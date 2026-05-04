'use strict';

/**
 * Site-finder — orchestrateur public.
 *
 * Pour un SIREN donné, retourne l'URL canonique du site web officiel avec une
 * preuve forte (SIREN trouvé dans les pages mentions légales) ou retourne null
 * avec la trace des tentatives.
 *
 * Pipeline :
 *   1. Cache lookup (sauf forceRefresh ou skipCache).
 *   2. Source apiGouv → candidats validés via siteValidator.
 *   3. Si toujours rien : cascade webSearch sur 5 stratégies de query
 *      (name_city, name_postcode, name_siren, name_director, name_naf_city).
 *      On stoppe dès qu'un candidat passe le seuil — économie backend +
 *      validation. Les agrégateurs connus sont filtrés en amont par webSearch.
 *   4. Premier candidat ≥ threshold → cache.put + return.
 *   5. Aucun candidat validé → cache.recordFailure + return null avec trace
 *      complète des tentatives.
 *
 * Tous les adapters externes sont injectables via `opts.<thing>Impl` pour les
 * tests — pattern conforme à `shared/lead-exhauster/index.js` et
 * `shared/prospect-research/index.js`.
 */

const { findCandidatesViaApiGouv } = require('./sources/apiGouv');
const { findCandidatesViaHeuristic } = require('./sources/heuristicUrlGuess');
const webSearch = require('./sources/webSearch');
const { validateCandidate } = require('./validation/siteValidator');
const { fetchPagesForValidation } = require('./utils/pageFetcher');
const websitePatternsCache = require('./cache/websitePatternsCache');

const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.SITE_FINDER_CONFIDENCE_THRESHOLD || 0.85,
);
const DEFAULT_TIMEOUT_MS = Number(process.env.SITE_FINDER_TIMEOUT_MS || 15000);

const SOURCES_ORDER = ['api_gouv', 'heuristic_url_guess', 'websearch'];

/**
 * Mode 'on_demand' : appel interactif avec bornes serrées. Utilisé par le
 * pipeline d'enrichissement automatique pour ne pas bloquer la chaîne. Limite
 * la cascade aux 2 stratégies les plus discriminantes (name_city, name_siren).
 *
 * Mode 'batch' : run continu / smoke test. Bornes lâches, toutes stratégies
 * appliquées. Utilisé par le wrapper standalone (mode MacBook Air, hors scope
 * Sprint 2 mais le mode est exposé pour le préparer).
 */
const ON_DEMAND_LIMITS = {
  totalTimeoutMs: Number(process.env.SITE_FINDER_ON_DEMAND_TIMEOUT_MS || 20000),
  politenessBudgetMs: Number(process.env.SITE_FINDER_ON_DEMAND_POLITENESS_BUDGET_MS || 5000),
  maxStrategies: 2,
  strategyOrder: ['name_city', 'name_siren'],
};

const BATCH_LIMITS = {
  totalTimeoutMs: Number(process.env.SITE_FINDER_BATCH_TIMEOUT_MS || 90000),
  politenessBudgetMs: Infinity,
  maxStrategies: 5,
  strategyOrder: ['name_city', 'name_postcode', 'name_siren', 'name_director', 'name_naf_city'],
};

const VALID_MODES = new Set(['on_demand', 'batch']);

function getLimitsForMode(mode) {
  if (mode === 'batch') return BATCH_LIMITS;
  return ON_DEMAND_LIMITS;
}

/**
 * @param {Object} input
 * @param {string} input.siren                              9 chiffres, requis
 * @param {string} input.companyName                         Raison sociale, requise
 * @param {string} [input.ville]
 * @param {string} [input.codePostal]
 * @param {string} [input.codeDepartement]
 * @param {string} [input.dirigeantName]                    Pour stratégie name_director
 * @param {string} [input.libelleNaf]                       Pour stratégie name_naf_city
 * @param {Object} [input.options]
 * @param {number}  [input.options.confidenceThreshold]
 * @param {number}  [input.options.timeoutMs]
 * @param {boolean} [input.options.forceRefresh]
 * @param {boolean} [input.options.skipCache]
 * @param {Object} [opts]                                    Adapters injectables pour tests
 * @param {Object} [opts.apiGouvImpl]                        { findCandidatesViaApiGouv }
 * @param {Object} [opts.webSearchImpl]                      { searchOneStrategy, QUERY_STRATEGIES, canApply }
 * @param {Object} [opts.cacheImpl]                          { get, put, recordFailure }
 * @param {Object} [opts.validatorImpl]                      { validateCandidate }
 * @param {Function} [opts.fetcherImpl]                      fetchPagesForValidation
 * @param {Object} [opts.context]                            Azure InvocationContext
 * @param {Function} [opts.now]                              Clock injectable
 *   pour tests déterministes (default: Date.now). Affecte uniquement le
 *   tracking politesse/timeout cascade, pas le champ validatedAt.
 * @returns {Promise<FindWebsiteOutput>}
 */
async function findWebsite(input = {}, opts = {}) {
  const logger = makeLogger(opts.context);
  const validatedAt = new Date().toISOString();

  // Validation d'entrée stricte
  if (!input || !/^\d{9}$/.test(String(input.siren || ''))) {
    return buildOutput({
      siteUrl: null,
      confidence: 0,
      source: null,
      proofType: null,
      signals: ['invalid_siren'],
      attempted: [],
      validatedAt,
    });
  }
  if (!input.companyName || typeof input.companyName !== 'string') {
    return buildOutput({
      siteUrl: null,
      confidence: 0,
      source: null,
      proofType: null,
      signals: ['missing_company_name'],
      attempted: [],
      validatedAt,
    });
  }

  const options = input.options || {};
  const threshold = Number.isFinite(options.confidenceThreshold)
    ? options.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const forceRefresh = Boolean(options.forceRefresh);
  const skipCache = Boolean(options.skipCache);

  // Mode on_demand vs batch — borne le coût de la cascade webSearch.
  // Le mode peut venir de input.options.mode (passé par le caller métier) ou
  // opts.mode (pour les tests). Default 'on_demand' (mode le plus serré, sûr).
  const mode = (options.mode && VALID_MODES.has(options.mode)) ? options.mode
    : (opts.mode && VALID_MODES.has(opts.mode)) ? opts.mode
    : 'on_demand';
  const limits = getLimitsForMode(mode);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : (limits.totalTimeoutMs || DEFAULT_TIMEOUT_MS);

  // Clock injectable pour tests déterministes (T4.1). Default : Date.now.
  // Sert UNIQUEMENT au tracking politesse / timeout cascade — pas au champ
  // `validatedAt` du résultat (qui doit refléter l'horloge wall-clock).
  const now = (typeof opts.now === 'function') ? opts.now : Date.now.bind(Date);
  const startedAt = now();
  const isOverallBudget = () => now() - startedAt > limits.totalTimeoutMs;

  const adapters = {
    apiGouv: opts.apiGouvImpl || { findCandidatesViaApiGouv },
    heuristic: opts.heuristicImpl || { findCandidatesViaHeuristic },
    webSearch: opts.webSearchImpl || webSearch,
    cache: opts.cacheImpl || websitePatternsCache,
    validator: opts.validatorImpl || { validateCandidate },
    fetcher: opts.fetcherImpl || fetchPagesForValidation,
  };

  // ─── Étape 1 : cache lookup ──────────────────────────────────────────────
  if (!forceRefresh && !skipCache) {
    try {
      const cached = await adapters.cache.get(input.siren);
      if (cached && cached.siteUrl) {
        logger.info('site-finder.cache.hit', { siren: input.siren });
        return {
          ...cached,
          source: 'cache',
          signals: [...(cached.signals || []), 'cache_hit'],
        };
      }
    } catch (err) {
      logger.warn('site-finder.cache.error', { err: err && err.message });
    }
  }

  const attempted = [];
  let bestRejected = null;
  const validatorOpts = {
    timeoutMs,
    fetcherImpl: opts.fetcherImpl ? adapters.fetcher : undefined,
  };

  // Helper : valide une liste de candidats, retourne le 1er validé ou met à
  // jour bestRejected. Effet de bord sur `bestRejected` capturé via closure.
  const tryValidate = async (candidates, sourceLabel) => {
    for (const candidate of candidates) {
      const result = await adapters.validator.validateCandidate(
        {
          url: candidate.url,
          targetSiren: input.siren,
          companyName: input.companyName,
          ville: input.ville,
          codePostal: input.codePostal,
        },
        validatorOpts,
      ).catch((err) => {
        logger.warn('site-finder.validator.error', { err: err && err.message, url: candidate.url });
        return null;
      });

      if (!result) continue;

      if (result.confidence >= threshold) {
        return buildOutput({
          siteUrl: candidate.url,
          confidence: result.confidence,
          source: sourceLabel,
          proofType: result.proofType,
          proofDetails: result.proofDetails,
          signals: [...(candidate.signals || []), ...(result.signals || [])],
          attempted: attempted.slice(),
          validatedAt,
        });
      }

      if (!bestRejected || result.confidence > bestRejected.result.confidence) {
        bestRejected = { candidate, result };
      }
    }
    return null;
  };

  // ─── Étape 2 : source apiGouv ────────────────────────────────────────────
  let apiGouvCandidates = [];
  let apiGouvRejectedReason;
  try {
    apiGouvCandidates = await adapters.apiGouv.findCandidatesViaApiGouv(
      {
        siren: input.siren,
        companyName: input.companyName,
        ville: input.ville,
      },
      { timeoutMs },
    );
  } catch (err) {
    apiGouvRejectedReason = (err && err.code) || 'error';
    logger.warn('site-finder.api_gouv.error', { err: err && err.message });
  }

  attempted.push({
    source: 'api_gouv',
    candidates: apiGouvCandidates.length,
    ...(apiGouvRejectedReason ? { rejectedReason: apiGouvRejectedReason } : {}),
  });

  let validatedOutput = await tryValidate(apiGouvCandidates, 'api_gouv');

  // ─── Étape 2.5 : source heuristicUrlGuess (T1bis) ────────────────────────
  // Tentative gratuite et rapide entre apiGouv (souvent vide pour PME) et la
  // cascade webSearch (consommatrice + risque de blocage backend). On
  // construit des URLs candidates par slugification du nom et on les probe.
  // Le validator aval fait la preuve SIREN comme pour les autres sources.
  if (!validatedOutput && adapters.heuristic && typeof adapters.heuristic.findCandidatesViaHeuristic === 'function') {
    let heuristicCandidates = [];
    let heuristicRejectedReason;
    try {
      heuristicCandidates = await adapters.heuristic.findCandidatesViaHeuristic(
        {
          siren: input.siren,
          companyName: input.companyName,
        },
        { fetchImpl: opts.fetchImpl, timeoutMs },
      );
    } catch (err) {
      heuristicRejectedReason = (err && err.code) || 'error';
      logger.warn('site-finder.heuristic.error', { err: err && err.message });
    }

    attempted.push({
      source: 'heuristic_url_guess',
      candidates: heuristicCandidates.length,
      ...(heuristicRejectedReason ? { rejectedReason: heuristicRejectedReason } : {}),
    });

    if (heuristicCandidates.length > 0) {
      validatedOutput = await tryValidate(heuristicCandidates, 'heuristic_url_guess');
    }
  }

  // ─── Étape 3 : cascade webSearch ─────────────────────────────────────────
  // Skippée si apiGouv a déjà validé. Bornée par les limites du mode :
  //   - Liste autorisée (limits.strategyOrder) → on_demand limite à 2
  //     stratégies (name_city, name_siren), batch en autorise 5.
  //   - maxStrategies : nombre max de stratégies effectivement tentées.
  //   - politenessBudget / totalTimeout : early-exit si dépassé.
  // Si le backend throw blocked, on arrête la cascade pour ne pas marteler.
  if (!validatedOutput && adapters.webSearch && Array.isArray(adapters.webSearch.QUERY_STRATEGIES)) {
    let backendBlocked = false;
    let strategiesAppliedCount = 0;
    let politenessUsedMs = 0;
    const allowedStrategies = new Set(limits.strategyOrder);

    // On itère selon l'ordre canonique du module webSearch (qui définit
    // l'ordre des stratégies de query). Mais on filtre sur allowedStrategies
    // en respectant l'ordre voulu par le mode.
    const orderedStrategies = limits.strategyOrder
      .map((name) => adapters.webSearch.QUERY_STRATEGIES.find((s) => s.name === name))
      .filter(Boolean);

    for (const strategy of orderedStrategies) {
      if (validatedOutput || backendBlocked) break;
      if (strategiesAppliedCount >= limits.maxStrategies) break;
      if (isOverallBudget()) {
        attempted.push({ source: 'websearch_skipped', candidates: 0, rejectedReason: 'overall_timeout' });
        break;
      }
      if (politenessUsedMs >= limits.politenessBudgetMs) {
        attempted.push({ source: 'websearch_skipped', candidates: 0, rejectedReason: 'politeness_exhausted' });
        break;
      }
      if (!allowedStrategies.has(strategy.name)) continue;
      if (!adapters.webSearch.canApply(strategy, input)) continue;

      strategiesAppliedCount++;
      const stratStart = now();
      let strategyCandidates = [];
      let strategyRejectedReason;
      try {
        strategyCandidates = await adapters.webSearch.searchOneStrategy(strategy, input, {
          fetchImpl: opts.fetchImpl,
          timeoutMs,
        });
      } catch (err) {
        strategyRejectedReason = (err && err.code) || 'error';
        logger.warn('site-finder.websearch.error', {
          strategy: strategy.name,
          err: err && err.message,
        });
        if (err && err.code === 'blocked') {
          backendBlocked = true;
        }
      }
      politenessUsedMs += now() - stratStart;

      attempted.push({
        source: `websearch_${strategy.name}`,
        candidates: strategyCandidates.length,
        ...(strategyRejectedReason ? { rejectedReason: strategyRejectedReason } : {}),
      });

      if (strategyCandidates.length > 0) {
        validatedOutput = await tryValidate(
          strategyCandidates,
          `websearch_${strategy.name}`,
        );
      }
    }
  }

  // ─── Étape 4 : caching + retour ──────────────────────────────────────────
  if (validatedOutput) {
    if (!skipCache) {
      try {
        await adapters.cache.put(input.siren, validatedOutput);
      } catch (err) {
        logger.warn('site-finder.cache.put.error', { err: err && err.message });
      }
    }
    return validatedOutput;
  }

  const failureOutput = buildOutput({
    siteUrl: null,
    confidence: bestRejected ? bestRejected.result.confidence : 0,
    source: null,
    proofType: bestRejected ? bestRejected.result.proofType : null,
    proofDetails: bestRejected ? bestRejected.result.proofDetails : undefined,
    signals: bestRejected
      ? ['no_candidate_validated', ...(bestRejected.result.signals || [])]
      : ['no_candidate_validated'],
    attempted,
    validatedAt,
  });

  if (!skipCache) {
    try {
      await adapters.cache.recordFailure(input.siren, failureOutput);
    } catch (err) {
      logger.warn('site-finder.cache.recordFailure.error', { err: err && err.message });
    }
  }

  return failureOutput;
}

// ─── Helpers privés ────────────────────────────────────────────────────────

function buildOutput({
  siteUrl,
  confidence,
  source,
  proofType,
  proofDetails,
  signals,
  attempted,
  validatedAt,
}) {
  const out = {
    siteUrl: siteUrl || null,
    confidence: typeof confidence === 'number' ? confidence : 0,
    source: source || null,
    proofType: proofType || null,
    signals: Array.isArray(signals) ? signals.slice() : [],
    costCents: 0,
    validatedAt,
    attempted: Array.isArray(attempted) ? attempted.slice() : [],
  };
  if (proofDetails && Object.keys(proofDetails).length > 0) {
    out.proofDetails = proofDetails;
  }
  return out;
}

/**
 * Wrap des méthodes Azure Functions context dans des closures pour préserver
 * les champs privés #xxx du SDK (défense BL-31, cf. commit 1c67a4c sur
 * feat/mem0-integration). Tout module qui consomme `context` doit faire ça.
 */
function makeLogger(context) {
  if (!context) return { info: () => {}, warn: () => {} };
  const info = context.info || (context.log && context.log.info) || context.log || (() => {});
  const warn = context.warn || (context.log && context.log.warn) || info;
  return {
    info: (msg, payload) => { try { info(msg, payload); } catch { /* noop */ } },
    warn: (msg, payload) => { try { warn(msg, payload); } catch { /* noop */ } },
  };
}

module.exports = {
  findWebsite,
  ON_DEMAND_LIMITS,
  BATCH_LIMITS,
  // Exposés pour tests :
  _internals: {
    buildOutput,
    DEFAULT_CONFIDENCE_THRESHOLD,
    DEFAULT_TIMEOUT_MS,
    SOURCES_ORDER,
    getLimitsForMode,
  },
};
