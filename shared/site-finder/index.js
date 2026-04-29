'use strict';

/**
 * Site-finder — orchestrateur public (T1).
 *
 * Pour un SIREN donné, retourne l'URL canonique du site web officiel avec une
 * preuve forte (SIREN trouvé dans les pages mentions légales) ou retourne null
 * avec la trace des tentatives.
 *
 * Pipeline T1 :
 *   1. Cache lookup (sauf forceRefresh ou skipCache).
 *   2. Source apiGouv (T1 unique source — T2/T3 ajouteront scrape agrégateurs
 *      et DuckDuckGo dans des jalons distincts sans toucher à l'orchestrateur).
 *   3. Validation séquentielle de chaque candidat via siteValidator.
 *   4. Premier candidat ≥ threshold (défaut 0.85) → cache.put + return.
 *   5. Aucun candidat validé → cache.recordFailure + return null.
 *
 * Contrat public : voir SPEC du brief T1.2 (FindWebsiteInput, FindWebsiteOutput).
 *
 * Tous les adapters externes sont injectables via `opts.<thing>Impl` pour les
 * tests — pattern conforme à `shared/lead-exhauster/index.js` et
 * `shared/prospect-research/index.js`.
 */

const { findCandidatesViaApiGouv } = require('./sources/apiGouv');
const { validateCandidate } = require('./validation/siteValidator');
const { fetchPagesForValidation } = require('./utils/pageFetcher');
const websitePatternsCache = require('./cache/websitePatternsCache');

const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.SITE_FINDER_CONFIDENCE_THRESHOLD || 0.85,
);
const DEFAULT_TIMEOUT_MS = Number(process.env.SITE_FINDER_TIMEOUT_MS || 15000);

const SOURCES_ORDER_T1 = ['api_gouv'];

/**
 * @param {Object} input
 * @param {string} input.siren                              9 chiffres, requis
 * @param {string} input.companyName                         Raison sociale, requise
 * @param {string} [input.ville]
 * @param {string} [input.codePostal]
 * @param {string} [input.codeDepartement]
 * @param {Object} [input.options]
 * @param {number}  [input.options.confidenceThreshold]
 * @param {number}  [input.options.timeoutMs]
 * @param {boolean} [input.options.forceRefresh]
 * @param {boolean} [input.options.skipCache]
 * @param {Object} [opts]                                    Adapters injectables pour tests
 * @param {Object} [opts.apiGouvImpl]                        { findCandidatesViaApiGouv }
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
          // validatedAt = la date de validation initiale, on garde celle du cache
        };
      }
    } catch (err) {
      logger.warn('site-finder.cache.error', { err: err && err.message });
    }
  }

  // ─── Étape 2 : source apiGouv ────────────────────────────────────────────
  const attempted = [];
  let candidates = [];
  let apiGouvRejectedReason;

  try {
    candidates = await adapters.apiGouv.findCandidatesViaApiGouv(
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
    candidates: candidates.length,
    ...(apiGouvRejectedReason ? { rejectedReason: apiGouvRejectedReason } : {}),
  });

  // ─── Étape 3 : validation séquentielle ───────────────────────────────────
  let validatedOutput = null;
  let bestRejected = null;

  for (const candidate of candidates) {
    const result = await adapters.validator.validateCandidate(
      {
        url: candidate.url,
        targetSiren: input.siren,
        companyName: input.companyName,
        ville: input.ville,
        codePostal: input.codePostal,
      },
      {
        timeoutMs,
        fetcherImpl: opts.fetcherImpl ? adapters.fetcher : undefined,
      },
    ).catch((err) => {
      logger.warn('site-finder.validator.error', { err: err && err.message, url: candidate.url });
      return null;
    });

    if (!result) continue;

    if (result.confidence >= threshold) {
      validatedOutput = buildOutput({
        siteUrl: candidate.url,
        confidence: result.confidence,
        source: candidate.source,
        proofType: result.proofType,
        proofDetails: result.proofDetails,
        signals: [...(candidate.signals || []), ...(result.signals || [])],
        attempted,
        validatedAt,
      });
      break;
    }

    if (!bestRejected || result.confidence > bestRejected.confidence) {
      bestRejected = { candidate, result };
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
    SOURCES_ORDER_T1,
  },
};
