'use strict';

/**
 * Adapter webSearch — cascade de requêtes successives sur un moteur de
 * recherche public, avec filtrage des domaines agrégateurs connus.
 *
 * Architecture T2 :
 *   - Backend pluggable (DuckDuckGo HTML par défaut, SearXNG / Brave plus tard).
 *   - 5 stratégies de query ordonnées du plus discriminant au plus large.
 *   - Le caller (orchestrateur findWebsite) a deux modes d'usage :
 *       1. `findCandidatesViaWebSearch(input)` → agrège tous les candidats des
 *          5 stratégies (économie de roundtrip côté caller, mais consomme du
 *          budget DDG inutilement si la stratégie 1 suffisait).
 *       2. `searchOneStrategy(strategy, input)` → exécute une seule stratégie,
 *          le caller peut stopper la cascade dès validation. C'est le mode
 *          recommandé en intégration orchestrateur (cf. T2.5 du brief).
 *   - Filtrage agrégateurs côté webSearch : les URL retournées par DDG qui
 *     pointent vers societe.com / linkedin.com / etc. sont éliminées avant
 *     d'être présentées au validator (économie validator + faux positif).
 *
 * Politesse :
 *   - delay configurable entre 2 requêtes au même backend, géré par un
 *     Map<backendId, lastFetchAt> module-scope. Réinitialisable pour tests.
 */

const duckduckgoHtml = require('./webSearchBackends/duckduckgoHtml');

const DEFAULT_POLITENESS_DELAY_MS = Number(
  process.env.SITE_FINDER_WEBSEARCH_POLITENESS_DELAY_MS || 2000,
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
 * Domaines agrégateurs connus à filtrer des résultats (le module ne valide
 * jamais une URL qui pointe vers un de ces domaines, parce que ce ne sont pas
 * des sites d'entreprise).
 *
 * Liste fermée — extensible au fil de l'observation terrain. Pas d'ajout
 * spéculatif (R-J6).
 */
const AGGREGATOR_DOMAINS = new Set([
  'societe.com',
  'verif.com',
  'pappers.fr',
  'pagesjaunes.fr',
  'linkedin.com',
  'fr.linkedin.com',
  'facebook.com',
  'fr-fr.facebook.com',
  'wikipedia.org',
  'fr.wikipedia.org',
  'infogreffe.fr',
  'annuaire-mairie.fr',
  'mairie.com',
  'societe-info.com',
  'manageo.fr',
  'kompass.com',
  'fr.kompass.com',
  'europages.fr',
  'annuaire-entreprises.data.gouv.fr',
  'data.gouv.fr',
  'insee.fr',
  'bodacc.fr',
  'duckduckgo.com',
  'google.com',
  'bing.com',
]);

/**
 * Vérifie si une URL appartient à un domaine agrégateur connu.
 * Le check est insensitive sur le préfixe `www.` et la casse.
 */
function isAggregator(url) {
  if (typeof url !== 'string' || !url) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('www.')) host = host.slice(4);
  if (AGGREGATOR_DOMAINS.has(host)) return true;
  // Match aussi les sous-domaines (ex: blog.linkedin.com)
  for (const aggr of AGGREGATOR_DOMAINS) {
    if (host.endsWith(`.${aggr}`)) return true;
  }
  return false;
}

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
 * Exécute une seule stratégie. Recommandé pour la cascade dans l'orchestrateur.
 *
 * @param {Object} strategy   Une entrée de QUERY_STRATEGIES
 * @param {Object} input
 * @param {Object} [opts]
 * @param {Object} [opts.backend]            Backend search (défaut DDG HTML)
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

  const backend = opts.backend || duckduckgoHtml;
  const backendId = (backend && backend.BACKEND_ID) || 'unknown';

  await applyPoliteness(backendId, opts);

  const raw = await backend.search(query, {
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    maxResults: Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS,
  });

  if (!Array.isArray(raw)) return [];

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
  // Exposés pour tests :
  _resetPolitenessForTests,
  _internals: {
    INITIAL_CONFIDENCE,
    DEFAULT_POLITENESS_DELAY_MS,
    DEFAULT_MAX_RESULTS,
  },
};
