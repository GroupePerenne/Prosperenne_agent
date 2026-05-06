'use strict';

/**
 * Adapter webSearch — cascade de requêtes successives sur des moteurs de
 * recherche publics, avec filtrage des domaines agrégateurs connus.
 *
 * Architecture T2 :
 *   - Cascade de backends pluggables (DDG Lite, Mojeek, Ecosia, DDG HTML
 *     par défaut). Si un backend throw `blocked` ou `transient`, on bascule
 *     sur le suivant pour la même stratégie. La diversification multi-moteur
 *     fait office de résilience anti-blocage.
 *   - 5 stratégies de query ordonnées du plus discriminant au plus large.
 *   - Le caller (orchestrateur findWebsite) a deux modes d'usage :
 *       1. `findCandidatesViaWebSearch(input)` → agrège tous les candidats des
 *          5 stratégies (économie de roundtrip côté caller, mais consomme du
 *          budget backend inutilement si la stratégie 1 suffisait).
 *       2. `searchOneStrategy(strategy, input)` → exécute une seule stratégie,
 *          le caller peut stopper la cascade dès validation. C'est le mode
 *          recommandé en intégration orchestrateur.
 *   - Filtrage agrégateurs côté webSearch : les URL retournées qui pointent
 *     vers societe.com / linkedin.com / etc. sont éliminées avant d'être
 *     présentées au validator (économie validator + faux positif).
 *
 * Politesse :
 *   - delay configurable entre 2 requêtes au même backend, géré par un
 *     Map<backendId, lastFetchAt> module-scope. Réinitialisable pour tests.
 *
 * Ordre des backends configurable via env `SITE_FINDER_WEBSEARCH_BACKENDS`
 * (liste comma-separated). Par défaut : `ddg_lite,mojeek,ecosia,duckduckgo_html`.
 * Le 1er backend qui retourne un résultat non-bloqué fournit les candidats
 * pour cette stratégie. Si tous bloquent → on remonte SearchBlockedError
 * pour que l'orchestrateur stoppe la cascade strategy globalement.
 */

const duckduckgoHtml = require('./webSearchBackends/duckduckgoHtml');
const duckduckgoLite = require('./webSearchBackends/duckduckgoLite');
const mojeek = require('./webSearchBackends/mojeek');
const ecosia = require('./webSearchBackends/ecosia');
const braveApi = require('./webSearchBackends/braveApi');

// Map BACKEND_ID → module pour résolution depuis env config.
const BACKEND_REGISTRY = {
  [braveApi.BACKEND_ID]: braveApi,
  [duckduckgoHtml.BACKEND_ID]: duckduckgoHtml,
  [duckduckgoLite.BACKEND_ID]: duckduckgoLite,
  [mojeek.BACKEND_ID]: mojeek,
  [ecosia.BACKEND_ID]: ecosia,
};

// Brave retiré du défaut le 6 mai 2026 (décision Paul — crédit Brave épuisé,
// pas de renouvellement). Cascade gratuits uniquement : DDG Lite → Mojeek →
// Ecosia → DDG HTML. Le module braveApi reste dans le registry pour pouvoir
// le réactiver via env SITE_FINDER_WEBSEARCH_BACKENDS si crédit revient.
const DEFAULT_BACKENDS_ORDER = ['duckduckgo_lite', 'mojeek', 'ecosia', 'duckduckgo_html'];

/**
 * Lit l'ordre des backends depuis env. Filtre les IDs inconnus pour ne
 * pas crasher si quelqu'un met une typo dans la config Azure.
 */
function getDefaultBackends() {
  const raw = process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  if (!raw || typeof raw !== 'string') {
    return DEFAULT_BACKENDS_ORDER.map((id) => BACKEND_REGISTRY[id]).filter(Boolean);
  }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out = ids.map((id) => BACKEND_REGISTRY[id]).filter(Boolean);
  return out.length > 0 ? out : DEFAULT_BACKENDS_ORDER.map((id) => BACKEND_REGISTRY[id]).filter(Boolean);
}

const DEFAULT_POLITENESS_DELAY_MS = Number(
  process.env.SITE_FINDER_WEBSEARCH_POLITENESS_DELAY_MS || 5000,
);
const DEFAULT_MAX_RESULTS = Number(
  process.env.SITE_FINDER_WEBSEARCH_MAX_RESULTS_PER_QUERY || 10,
);

const SOURCE_ID = 'websearch';
const INITIAL_CONFIDENCE = 0.65;

const _lastFetchByBackend = new Map();

/**
 * Stratégies de query ordonnées de la plus discriminante à la plus large.
 * Chaque stratégie est skippée si les inputs nécessaires manquent.
 *
 * `requires` est utilisé par `canApply()` pour filtrer en amont, ce qui évite
 * d'envoyer une query incomplète comme `"" Lyon` au backend.
 */
const QUERY_STRATEGIES = [
  {
    name: 'name_city',
    requires: ['companyName', 'ville'],
    build: ({ companyName, ville }) => `"${companyName}" ${ville}`,
  },
  {
    name: 'name_postcode',
    requires: ['companyName', 'codePostal'],
    build: ({ companyName, codePostal }) => `"${companyName}" ${codePostal}`,
  },
  {
    name: 'name_siren',
    requires: ['companyName', 'siren'],
    build: ({ companyName, siren }) => `"${companyName}" ${siren}`,
  },
  {
    name: 'name_director',
    requires: ['companyName', 'dirigeantName'],
    build: ({ companyName, dirigeantName }) => `"${companyName}" "${dirigeantName}"`,
  },
  {
    name: 'name_naf_city',
    requires: ['companyName', 'libelleNaf', 'ville'],
    build: ({ companyName, libelleNaf, ville }) => `"${companyName}" ${libelleNaf} ${ville}`,
  },
];

/**
 * Domaines agrégateurs : centralisés dans `shared/site-finder/aggregators.js`
 * pour partage entre webSearch (filtre URLs candidates) et lead-exhauster
 * (filtre companyDomain à un agrégateur). Si on ne filtre pas dans le
 * lead-exhauster, on génère des patterns absurdes type
 * `prenom.nom@rubypayeur.com`.
 */
const { AGGREGATOR_DOMAINS, isAggregator } = require('../aggregators');

/**
 * Vérifie si une stratégie est applicable à un input donné.
 */
function canApply(strategy, input) {
  for (const field of strategy.requires) {
    const v = input && input[field];
    if (v === undefined || v === null) return false;
    if (typeof v === 'string' && v.trim().length === 0) return false;
  }
  return true;
}

/**
 * Exécute une seule stratégie sur la cascade de backends. Le 1er backend qui
 * retourne sans blocked fournit les résultats. Si tous les backends sont
 * bloqués, on remonte SearchBlockedError pour stopper la cascade strategy
 * globalement (l'orchestrateur ne martèle pas).
 *
 * @param {Object} strategy   Une entrée de QUERY_STRATEGIES
 * @param {Object} input
 * @param {Object} [opts]
 * @param {Object|Array} [opts.backend]      Backend ou array de backends en
 *                                           cascade. Si non fourni : env
 *                                           `SITE_FINDER_WEBSEARCH_BACKENDS`
 *                                           ou DEFAULT_BACKENDS_ORDER.
 * @param {Function} [opts.fetchImpl]
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxResults]
 * @param {number}   [opts.politenessDelayMs]
 * @param {Function} [opts.sleepImpl]        Pour tests (override sleep)
 * @returns {Promise<Array<Candidate>>}
 */
async function searchOneStrategy(strategy, input, opts = {}) {
  if (!canApply(strategy, input)) return [];
  const query = strategy.build(input);
  if (!query || typeof query !== 'string' || query.trim().length === 0) return [];

  // Résolution backends : single (rétrocompat tests existants), array (cascade)
  // ou défaut (env / DEFAULT_BACKENDS_ORDER).
  let backends;
  if (Array.isArray(opts.backend)) {
    backends = opts.backend;
  } else if (opts.backend) {
    backends = [opts.backend];
  } else {
    backends = getDefaultBackends();
  }
  if (!backends || backends.length === 0) {
    backends = [duckduckgoHtml];
  }

  let lastBlockedError = null;
  let lastTransientError = null;

  for (const backend of backends) {
    const backendId = (backend && backend.BACKEND_ID) || 'unknown';
    await applyPoliteness(backendId, opts);

    let raw;
    try {
      raw = await backend.search(query, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        maxResults: Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS,
      });
    } catch (err) {
      if (err && err.code === 'blocked') {
        lastBlockedError = err;
        continue; // bascule sur le backend suivant
      }
      if (err && err.code === 'transient') {
        lastTransientError = err;
        continue;
      }
      throw err;
    }

    if (!Array.isArray(raw)) continue;

    // Backend a répondu (potentiellement 0 résultat — pas une erreur,
    // c'est une réponse légitime "rien trouvé").
    return raw
      .filter((r) => r && r.url && !isAggregator(r.url))
      .map((r) => ({
        url: r.url,
        source: SOURCE_ID,
        strategy: strategy.name,
        backend: backendId,
        initialConfidence: INITIAL_CONFIDENCE,
        title: r.title || '',
        rank: r.rank || 0,
        signals: [`websearch_${strategy.name}`, `backend_${backendId}`],
      }));
  }

  // Tous les backends ont échoué. Si au moins un blocked → remonter blocked
  // pour stopper la cascade strategy. Sinon transient.
  if (lastBlockedError) throw lastBlockedError;
  if (lastTransientError) throw lastTransientError;
  return [];
}

/**
 * Exécute toutes les stratégies applicables et retourne l'union des candidats.
 * Mode "agrégation totale" — utile pour debug / smoke tests, mais consomme
 * inutilement du budget backend si une stratégie précoce suffirait. La
 * cascade orchestrateur préférera `searchOneStrategy` boucle externe.
 *
 * @param {Object} input
 * @param {Object} [opts]
 * @returns {Promise<Array<Candidate>>}
 */
async function findCandidatesViaWebSearch(input = {}, opts = {}) {
  const out = [];
  const seen = new Set();
  for (const strategy of QUERY_STRATEGIES) {
    if (!canApply(strategy, input)) continue;
    let candidates;
    try {
      candidates = await searchOneStrategy(strategy, input, opts);
    } catch (err) {
      // On laisse remonter les erreurs blocked/transient à l'orchestrateur :
      // c'est lui qui décide d'arrêter ou de continuer la cascade globale.
      throw err;
    }
    for (const c of candidates) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  return out;
}

// ─── Helpers privés ────────────────────────────────────────────────────────

async function applyPoliteness(backendId, opts) {
  const delay = Number.isFinite(opts.politenessDelayMs)
    ? opts.politenessDelayMs
    : DEFAULT_POLITENESS_DELAY_MS;
  if (delay <= 0) return;

  const last = _lastFetchByBackend.get(backendId);
  const now = Date.now();
  if (last && now - last < delay) {
    const wait = delay - (now - last);
    const sleeper = opts.sleepImpl || defaultSleep;
    await sleeper(wait);
  }
  _lastFetchByBackend.set(backendId, Date.now());
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _resetPolitenessForTests() {
  _lastFetchByBackend.clear();
}

module.exports = {
  findCandidatesViaWebSearch,
  searchOneStrategy,
  isAggregator,
  canApply,
  QUERY_STRATEGIES,
  AGGREGATOR_DOMAINS,
  SOURCE_ID,
  BACKEND_REGISTRY,
  DEFAULT_BACKENDS_ORDER,
  getDefaultBackends,
  // Exposés pour tests :
  _resetPolitenessForTests,
  _internals: {
    INITIAL_CONFIDENCE,
    DEFAULT_POLITENESS_DELAY_MS,
    DEFAULT_MAX_RESULTS,
  },
};
