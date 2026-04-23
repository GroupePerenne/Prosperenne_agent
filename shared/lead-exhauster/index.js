'use strict';

/**
 * Lead Exhauster — orchestrateur public.
 *
 * Responsabilité : à partir d'un SIREN (+ éventuelles infos optionnelles),
 * produire un `LeadContacts` exploitable par le pipeline aval (Graph Mail
 * via runSequence), avec une confidence ≥ seuil tenant (défaut 0.80).
 *
 * Pipeline (SPEC §3.3) :
 *   étape 0 : lookup cache LeadContacts                           [Jalon 1]
 *   étape 1 : resolveDomain (API gouv → fallback scraping)        [Jalon 1]
 *   étape 2 : resolveDecisionMaker (rescore INSEE vs scrapé)       [Jalon 2]
 *   étape 3 : resolveEmail (patterns + scraping + LinkedIn)        [Jalon 2]
 *   étape 4 : cascade Dropcontact (pay-on-success)                 [Jalon 3]
 *   étape 5 : trace LeadContacts + return                          [Jalon 1]
 *
 * Garantie "pas d'invention" (SPEC §3.4) :
 *   Aucune résolution ne passe avec confidence < seuil. Le pipeline
 *   retourne `status='unresolvable'` et `email=null` dans ce cas.
 *   L'orchestrateur caller (runLeadSelectorForConsultant) range le
 *   prospect dans la file `EmailUnresolvable` pour review.
 *
 * Le module expose :
 *   - leadExhauster(input, opts) → Promise<LeadExhausterOutput>
 *   - reportFeedback({ siren, status, ...}) → fire-and-forget pour
 *     runSequence / davidInbox (feedback delivered/bounced/replied)
 *
 * SPEC : SPEC_LEAD_EXHAUSTER_v1_0.md + ARCHITECTURE_v5_1.md §7.13
 */

const { resolveDomain } = require('./resolveDomain');
const { resolveDecisionMaker } = require('./resolveDecisionMaker');
const { resolveEmail } = require('./resolveEmail');
const { scrapeDomain } = require('./scraping');
const { readLeadContact, upsertLeadContact, updateFeedback } = require('./trace');
const { DEFAULT_CONFIDENCE_THRESHOLD, SOURCES, STATUS } = require('./schemas');
const { normalizeNamePart } = require('./patterns');

const DEFAULT_CACHE_TTL_DAYS = 90;

/**
 * Orchestrateur principal. Retourne toujours un LeadExhausterOutput
 * (jamais throw en production — même en cas d'erreur interne, status='error').
 *
 * @param {import('./schemas').LeadExhausterInput} input
 * @param {Object} [opts]
 * @param {Function|Object} [opts.logger]
 * @param {Object} [opts.adapters]   Override pour tests :
 *   - adapters.readLeadContact, adapters.upsertLeadContact
 *   - adapters.resolveDomain, adapters.resolveEmail
 *   - adapters.scrapeDomain
 *   - adapters.dropcontact (Jalon 3)
 * @returns {Promise<import('./schemas').LeadExhausterOutput>}
 */
async function leadExhauster(input = {}, opts = {}) {
  const started = Date.now();
  const logger = opts.logger || null;
  const adapters = opts.adapters || {};

  // ─── Validation d'entrée ────────────────────────────────────────────────
  if (!input.siren || !/^\d{9}$/.test(String(input.siren))) {
    return buildOutput({
      status: STATUS.ERROR,
      signals: ['invalid_siren'],
      elapsedMs: Date.now() - started,
    });
  }
  if (!input.beneficiaryId) {
    return buildOutput({
      status: STATUS.ERROR,
      signals: ['missing_beneficiary_id'],
      elapsedMs: Date.now() - started,
    });
  }

  const threshold = Number.isFinite(input.confidenceThreshold)
    ? input.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;
  const experimentsApplied = extractAppliedExperiments(input.experimentsContext);
  const signals = [];

  // ─── Étape 0 : lookup cache LeadContacts ────────────────────────────────
  const cacheReader = adapters.readLeadContact || readLeadContact;
  const cached = await cacheReader({
    siren: input.siren,
    firstName: input.firstName,
    lastName: input.lastName,
  }).catch(() => null);
  if (cached && isFreshCacheHit(cached)) {
    log(logger, 'info', 'exhauster.cache.hit', { siren: input.siren });
    return buildOutput({
      status: cached.email ? STATUS.OK : STATUS.UNRESOLVABLE,
      email: cached.email,
      confidence: Number(cached.confidence) || 0,
      source: SOURCES.CACHE,
      signals: [`cache_hit_from_${cached.source}`],
      cost_cents: 0,
      resolvedDecisionMaker: cached.firstName
        ? {
            firstName: cached.firstName,
            lastName: cached.lastName,
            role: cached.role || '',
            source: cached.roleSource || 'insee',
            confidence: Number(cached.roleConfidence) || 0,
          }
        : null,
      resolvedDomain: cached.domain || null,
      cached: true,
      elapsedMs: Date.now() - started,
      experimentsApplied,
    });
  }

  // ─── Étape 1 : résolution domaine ───────────────────────────────────────
  const domainResolver = adapters.resolveDomain || resolveDomain;
  const domainResult = await domainResolver(
    {
      siren: input.siren,
      companyName: input.companyName,
      companyDomain: input.companyDomain,
    },
    { logger, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl },
  ).catch((err) => {
    log(logger, 'warn', 'exhauster.resolveDomain.error', { err: err && err.message });
    return { domain: null, confidence: 0, source: 'none', signals: ['resolve_domain_error'], elapsedMs: 0 };
  });
  signals.push(...(domainResult.signals || []).map((s) => `domain.${s}`));

  // Domaine absent → pas de résolution interne possible, on saute aux
  // stubs étape 4 (Dropcontact peut encore résoudre sans domain, en
  // utilisant firstName/lastName/companyName).
  if (!domainResult.domain) {
    signals.push('domain_unresolved');
  }

  // ─── Étape 2 : résolution décideur ──────────────────────────────────────
  // On scrape le domaine une seule fois pour nourrir à la fois
  // resolveDecisionMaker (teamProfiles) et resolveEmail (emails/teamProfiles).
  // Si le domaine est absent, le scraping est skippé.
  let scrapedContext = { emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [] };
  if (domainResult.domain) {
    const scraper = adapters.scrapeDomain || scrapeDomain;
    scrapedContext = await scraper(
      {
        domain: domainResult.domain,
        firstName: input.firstName,
        lastName: input.lastName,
      },
      { fetchImpl: opts.fetchImpl, logger },
    ).catch((err) => {
      log(logger, 'warn', 'exhauster.scraping.error', { err: err && err.message });
      return { emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: ['scraping_error'] };
    });
    signals.push(`scraped.${scrapedContext.pagesVisited.length}_visited.${scrapedContext.pagesFailed.length}_failed`);
  }

  const dmResolver = adapters.resolveDecisionMaker || resolveDecisionMaker;
  const decisionMaker = dmResolver({
    firstName: input.firstName,
    lastName: input.lastName,
    inseeRole: input.inseeRole,
    trancheEffectif: input.trancheEffectif,
    teamProfiles: scrapedContext.teamProfiles,
  });
  if (decisionMaker) {
    signals.push(...(decisionMaker.signals || []).map((s) => `dm.${s}`));
  } else {
    signals.push('dm.no_candidate');
  }

  // ─── Étape 3 : résolution email interne ─────────────────────────────────
  // resolveEmail exploite les mêmes inputs scrapés si on lui injecte un
  // scraper qui retourne le cache. Sinon il re-scrape. Ici on optimise :
  // on lui injecte un scraper-cache qui re-sert scrapedContext.
  let emailResult = {
    status: 'unresolvable',
    email: null,
    confidence: 0,
    source: 'none',
    signals: [],
    candidateHint: null,
  };

  // Si on n'a pas de domaine ou pas de décideur, on skip resolveEmail
  // interne. Dropcontact peut encore faire son travail.
  if (domainResult.domain && decisionMaker && (decisionMaker.firstName || decisionMaker.lastName)) {
    const emailResolver = adapters.resolveEmail || resolveEmail;
    const cachedScraper = async () => scrapedContext;
    emailResult = await emailResolver(
      {
        domain: domainResult.domain,
        firstName: decisionMaker.firstName,
        lastName: decisionMaker.lastName,
        companyName: input.companyName,
        siren: input.siren,
        companyLinkedInUrl: input.companyLinkedInUrl,
        profileLinkedInUrl: input.profileLinkedInUrl,
        naf: input.naf,
        trancheEffectif: input.trancheEffectif,
        confidenceThreshold: threshold,
      },
      {
        scraper: cachedScraper,
        logger,
      },
    ).catch((err) => {
      log(logger, 'warn', 'exhauster.resolveEmail.error', { err: err && err.message });
      return {
        status: 'unresolvable',
        email: null,
        confidence: 0,
        source: 'none',
        signals: ['resolve_email_error'],
        candidateHint: null,
      };
    });
    signals.push(...(emailResult.signals || []).map((s) => `email.${s}`));
  } else {
    signals.push('email.skipped_missing_inputs');
  }

  // ─── Étape 4 : cascade Dropcontact ──────────────────────────────────────
  // Stub Jalon 2 : l'adapter existe mais est désactivé par défaut, retourne
  // toujours un résultat vide. Le câblage réel (budget check, circuit
  // breaker, HTTP batch + polling) vient au Jalon 3.
  let cascadeResult = null;
  if (emailResult.status !== 'ok' && !input.simulated) {
    const dropcontact = adapters.dropcontact || null;
    if (dropcontact && typeof dropcontact.resolve === 'function' && dropcontact.enabled) {
      const payload = {
        firstName: (decisionMaker && decisionMaker.firstName) || input.firstName,
        lastName: (decisionMaker && decisionMaker.lastName) || input.lastName,
        companyName: input.companyName,
        companyDomain: domainResult.domain,
        siren: input.siren,
      };
      cascadeResult = await dropcontact.resolve(payload).catch((err) => {
        log(logger, 'warn', 'exhauster.dropcontact.error', { err: err && err.message });
        return { email: null, confidence: 0, cost_cents: 0, providerRaw: { error: 'throw' } };
      });
      signals.push(`cascade.dropcontact.${cascadeResult && cascadeResult.email ? 'hit' : 'miss'}`);
    } else {
      signals.push('cascade.skipped_dropcontact_off');
    }
  } else if (input.simulated) {
    signals.push('cascade.skipped_simulated');
  }

  // ─── Choix du meilleur résultat ─────────────────────────────────────────
  const candidates = [];
  if (emailResult.status === 'ok' && emailResult.email) {
    candidates.push({
      email: emailResult.email,
      confidence: emailResult.confidence,
      source: emailResult.source,
      cost_cents: 0,
    });
  }
  if (cascadeResult && cascadeResult.email && cascadeResult.confidence >= threshold) {
    candidates.push({
      email: cascadeResult.email,
      confidence: cascadeResult.confidence,
      source: SOURCES.DROPCONTACT,
      cost_cents: cascadeResult.cost_cents || 0,
    });
  }

  let finalEmail = null;
  let finalConfidence = 0;
  let finalSource = 'none';
  let finalCost = 0;
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.confidence - a.confidence);
    const best = candidates[0];
    finalEmail = best.email;
    finalConfidence = best.confidence;
    finalSource = best.source;
    finalCost = best.cost_cents;
  }

  const status = (finalEmail && finalConfidence >= threshold)
    ? STATUS.OK
    : STATUS.UNRESOLVABLE;

  const output = buildOutput({
    status,
    email: status === STATUS.OK ? finalEmail : null,
    confidence: status === STATUS.OK ? finalConfidence : (finalConfidence || 0),
    source: status === STATUS.OK ? finalSource : 'none',
    signals,
    cost_cents: finalCost,
    resolvedDecisionMaker: decisionMaker,
    resolvedDomain: domainResult.domain,
    cached: false,
    elapsedMs: Date.now() - started,
    experimentsApplied,
    simulated: Boolean(input.simulated),
  });

  // ─── Étape 5 : trace LeadContacts ───────────────────────────────────────
  const tracer = adapters.upsertLeadContact || upsertLeadContact;
  await Promise.resolve(
    tracer({
      siren: input.siren,
      email: output.email,
      confidence: output.confidence,
      source: output.source,
      signals,
      cost_cents: output.cost_cents,
      firstName: (decisionMaker && decisionMaker.firstName) || '',
      lastName: (decisionMaker && decisionMaker.lastName) || '',
      role: (decisionMaker && decisionMaker.role) || '',
      roleSource: (decisionMaker && decisionMaker.source) || '',
      roleConfidence: (decisionMaker && decisionMaker.confidence) || 0,
      domain: domainResult.domain,
      domainSource: domainResult.source,
      experimentsApplied,
      beneficiaryId: input.beneficiaryId,
    }),
  ).catch(() => {});

  return output;
}

/**
 * Hook feedback pour runSequence / davidInbox.
 * Fire-and-forget côté caller — ce module absorbe toute erreur.
 *
 *   await leadExhauster.reportFeedback({
 *     siren: '123456789',
 *     firstName: 'Jean',
 *     lastName: 'Dupont',
 *     status: 'delivered' | 'bounced' | 'replied' | 'spam_flagged',
 *     timestamp: ISOString,
 *   });
 *
 * @param {Object} p
 * @returns {Promise<boolean>}
 */
async function reportFeedback(p = {}) {
  try {
    return await updateFeedback(p);
  } catch {
    return false;
  }
}

// ─── Helpers internes ──────────────────────────────────────────────────────

function buildOutput(partial = {}) {
  return {
    status: partial.status || STATUS.ERROR,
    email: partial.email || null,
    confidence: typeof partial.confidence === 'number' ? partial.confidence : 0,
    source: partial.source || 'none',
    signals: Array.isArray(partial.signals) ? partial.signals.slice() : [],
    cost_cents: Number.isFinite(partial.cost_cents) ? partial.cost_cents : 0,
    resolvedDecisionMaker: partial.resolvedDecisionMaker || null,
    resolvedDomain: partial.resolvedDomain || null,
    cached: Boolean(partial.cached),
    elapsedMs: Number.isFinite(partial.elapsedMs) ? partial.elapsedMs : 0,
    experimentsApplied: Array.isArray(partial.experimentsApplied)
      ? partial.experimentsApplied
      : [],
    ...(partial.simulated !== undefined ? { simulated: Boolean(partial.simulated) } : {}),
  };
}

function isFreshCacheHit(row) {
  if (!row || !row.lastVerifiedAt) return false;
  const last = Date.parse(row.lastVerifiedAt);
  if (!Number.isFinite(last)) return false;
  const ageDays = (Date.now() - last) / (24 * 3600 * 1000);
  return ageDays <= DEFAULT_CACHE_TTL_DAYS;
}

function extractAppliedExperiments(ctx) {
  if (!ctx || !Array.isArray(ctx.applied)) return [];
  return ctx.applied
    .filter((a) => a && a.experiment_id && a.variant)
    .map((a) => `${a.experiment_id}:${a.variant}`);
}

function log(logger, level, message, payload) {
  if (!logger) return;
  if (typeof logger[level] === 'function') logger[level](message, payload);
  else if (typeof logger === 'function') logger(`${level}: ${message}`, payload);
  else if (typeof logger.log === 'function') logger.log(`[${level}] ${message}`, payload);
}

// ─── Exports ───────────────────────────────────────────────────────────────

leadExhauster.reportFeedback = reportFeedback;

module.exports = {
  leadExhauster,
  reportFeedback,
  // Exposés pour tests / sous-modules :
  _internals: { buildOutput, isFreshCacheHit, extractAppliedExperiments, DEFAULT_CACHE_TTL_DAYS },
};
