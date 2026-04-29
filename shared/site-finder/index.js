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
const webSearch = require('./sources/webSearch');
const { validateCandidate } = require('./validation/siteValidator');
const { fetchPagesForValidation } = require('./utils/pageFetcher');
const websitePatternsCache = require('./cache/websitePatternsCache');

const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.SITE_FINDER_CONFIDENCE_THRESHOLD || 0.85,
);
const DEFAULT_TIMEOUT_MS = Number(process.env.SITE_FINDER_TIMEOUT_MS || 15000);

const SOURCES_ORDER = ['api_gouv', 'websearch'];

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
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const forceRefresh = Boolean(options.forceRefresh);
  const skipCache = Boolean(options.skipCache);

  const adapters = {
    apiGouv: opts.apiGouvImpl || { findCandidatesViaApiGouv },
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

  // ─── Étape 3 : cascade webSearch ─────────────────────────────────────────
  // Skippée si apiGouv a déjà validé. Si le backend est blocked, on stoppe
  // la cascade pour ne pas marteler.
  if (!validatedOutput && adapters.webSearch && Array.isArray(adapters.webSearch.QUERY_STRATEGIES)) {
    let backendBlocked = false;
    for (const strategy of adapters.webSearch.QUERY_STRATEGIES) {
      if (validatedOutput || backendBlocked) break;
      if (!adapters.webSearch.canApply(strategy, input)) continue;

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
  // Exposés pour tests :
  _internals: {
    buildOutput,
    DEFAULT_CONFIDENCE_THRESHOLD,
    DEFAULT_TIMEOUT_MS,
    SOURCES_ORDER,
  },
};
