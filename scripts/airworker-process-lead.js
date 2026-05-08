'use strict';

/**
 * AirWorker Process Lead — fonction processLead réutilisable extraite du
 * probe pour usage dans le mode continuous.
 *
 * Waterfall complète v8 :
 *   1. resolveDomainCombo (Playwright Google + queries variantes)
 *   2. extractBestEmail (Playwright rendu JS sur mentions-légales etc.)
 *      → si email confidence ≥ 0.60, COURT-CIRCUIT
 *   3. leadExhauster cascade interne (scrape statique + DM + patterns)
 *   4. SMTP probe sur 4 patterns standards
 *   5. Dropcontact en dernier recours (si domaine non agrégateur)
 *
 * Réutilise tous les modules existants de la branche feat/dropcontact-elargi.
 *
 * @module airworker-process-lead
 */

process.env.SITE_FINDER_WEBSEARCH_BACKENDS = process.env.SITE_FINDER_WEBSEARCH_BACKENDS || 'playwright_google';

const { leadExhauster } = require('../shared/lead-exhauster');
const { scrapeDomain } = require('../shared/lead-exhauster/scraping');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');
const { probeEmail } = require('../shared/lead-exhauster/smtp-probe');
const { applyPattern, normalizeDomain } = require('../shared/lead-exhauster/patterns');
const { isAggregator } = require('../shared/site-finder/aggregators');
const { resolveDomainCombo } = require('./airworker-domain-resolver');
const { extractBestEmail } = require('./airworker-email-extractor');

const PATTERNS_FOR_SMTP_PROBE = [
  '{first}.{last}@{domain}',
  '{first}@{domain}',
  '{f}.{last}@{domain}',
  '{first}-{last}@{domain}',
];

const EXTRACT_MIN_CONFIDENCE = 0.60;
const SMTP_VERIFY_CONFIDENCE = 0.85;
const DROPCONTACT_MIN_CONFIDENCE = 0.50;

// Adapters injectés pour leadExhauster en mode AirWorker.
// La cascade interne du leadExhauster est désactivée pour éviter la
// parallélisation S3 qui appelle Dropcontact systématiquement. On la
// remplace par un no-op et on rappelle Dropcontact MANUELLEMENT en
// dernier recours.
function makeNoOpDropcontact() {
  return {
    name: 'dropcontact',
    enabled: true,
    resolve: async () => ({
      email: null,
      confidence: 0,
      cost_cents: 0,
      providerRaw: { skipped: 'deferred_to_post_cascade' },
    }),
  };
}

function makeExhaustiveScraper() {
  return (input, opts) => scrapeDomain(input, {
    ...opts,
    mode: 'exhaustive',
    pageTimeoutMs: 5000,
    globalTimeoutMs: 60000,
  });
}

/**
 * Point d'entrée principal pour traiter un lead complet.
 *
 * @param {Object} candidate
 * @param {string} candidate.siren
 * @param {string} candidate.firstName
 * @param {string} candidate.lastName
 * @param {string} candidate.companyName
 * @param {string} [candidate.ville]
 * @param {string} [candidate.codeNaf]
 * @param {string} [candidate.trancheEffectif]
 * @param {string} [candidate.inseeRole]
 * @param {Object} deps
 * @param {Object} deps.extractorContext  Playwright BrowserContext (pré-init)
 * @param {Object} [deps.dropcontactAdapter]  Override pour tests
 * @param {Object} [deps.adaptersOverride]    Override leadExhauster adapters
 * @returns {Promise<{siren, status, email, confidence, source, cost_cents, signals, elapsedMs, domain, dirigeantName}>}
 */
async function processLead(candidate, deps = {}) {
  const t0 = Date.now();
  const dirigeantName = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();
  const signals = [];

  // Étape 1 : Playwright Google → domaine
  let domain = null;
  try {
    const sf = await resolveDomainCombo({
      siren: candidate.siren,
      companyName: candidate.companyName,
      ville: candidate.ville,
      dirigeantName,
    });
    if (sf && sf.siteUrl && !isAggregator(sf.siteUrl)) {
      domain = sf.siteUrl;
      signals.push(`sf.${sf.source}`, `sf.${sf.proofType || 'no_proof'}`);
    } else if (sf && sf.siteUrl) {
      signals.push('sf.aggregator_rejected_at_pose');
    } else {
      signals.push('sf.no_result');
    }
  } catch (err) {
    signals.push(`sf.error:${(err.message || '').slice(0, 30)}`);
  }

  // Étape 1.5 : extraction emails Playwright (rendu JS)
  if (domain && candidate.firstName && candidate.lastName && deps.extractorContext) {
    try {
      const ext = await extractBestEmail({
        siteUrl: domain,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        companyDomain: domain,
      }, { context: deps.extractorContext });
      if (ext && ext.email && ext.confidence >= EXTRACT_MIN_CONFIDENCE) {
        return {
          siren: candidate.siren,
          dirigeantName,
          domain,
          status: 'ok',
          email: ext.email,
          confidence: ext.confidence,
          source: `playwright_extract_${ext.type}`,
          cost_cents: 0,
          signals: [...signals, `extract.${ext.type}`, `extract.confidence_${Math.round(ext.confidence * 100)}`],
          elapsedMs: Date.now() - t0,
        };
      } else {
        signals.push('extract.no_match');
      }
    } catch (err) {
      signals.push(`extract.error:${(err.message || '').slice(0, 30)}`);
    }
  }

  // Étape 2 : cascade interne leadExhauster (scrape statique + DM + patterns)
  // Dropcontact désactivé via no-op (rappelé manuellement en étape 4).
  const adapters = deps.adaptersOverride || {
    readLeadContact: async () => null,
    resolveDomain: async (input) => ({
      domain: input.companyDomain || null,
      confidence: input.companyDomain ? 1.0 : 0,
      source: input.companyDomain ? 'input_via_playwright' : 'none',
      signals: input.companyDomain ? ['domain_from_input'] : ['no_domain'],
      elapsedMs: 0,
    }),
    scrapeDomain: makeExhaustiveScraper(),
    dropcontact: makeNoOpDropcontact(),
    upsertLeadContact: async () => true,
  };

  let result = await leadExhauster(
    {
      siren: candidate.siren,
      beneficiaryId: candidate.beneficiaryId || 'airworker',
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      companyName: candidate.companyName,
      companyDomain: domain,
      inseeRole: candidate.inseeRole,
      trancheEffectif: candidate.trancheEffectif,
      naf: candidate.codeNaf,
    },
    { adapters },
  ).catch((err) => ({
    status: 'error',
    email: null,
    confidence: 0,
    source: 'none',
    signals: [`exhauster.throw:${(err.message || '').slice(0, 30)}`],
  }));

  signals.push(...(result.signals || []));

  // Étape 3 : SMTP probe sur patterns standards
  let smtpVerified = null;
  if (result.status !== 'ok'
      && domain && !isAggregator(domain)
      && candidate.firstName && candidate.lastName) {
    const normDomain = normalizeDomain(domain);
    if (normDomain) {
      let probedCount = 0;
      for (const tpl of PATTERNS_FOR_SMTP_PROBE) {
        const candidateEmail = applyPattern(tpl, {
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          domain: normDomain,
        });
        if (!candidateEmail) continue;
        probedCount++;
        try {
          const sr = await probeEmail(candidateEmail, { timeoutMs: 10000 });
          if (sr.status === 'ok') {
            smtpVerified = { email: candidateEmail, code: sr.code, mxHost: sr.mxHost };
            break;
          }
        } catch { /* try next */ }
      }
      signals.push(`smtp.probed_${probedCount}`, smtpVerified ? 'smtp.verified' : 'smtp.no_match');
    }
  }

  if (smtpVerified) {
    return {
      siren: candidate.siren,
      dirigeantName,
      domain,
      status: 'ok',
      email: smtpVerified.email,
      confidence: SMTP_VERIFY_CONFIDENCE,
      source: 'smtp_probe',
      cost_cents: 0,
      signals,
      elapsedMs: Date.now() - t0,
    };
  }

  // Étape 4 : Dropcontact en dernier recours
  if (result.status !== 'ok' && domain && !isAggregator(domain) && deps.dropcontactAdapter) {
    try {
      const dropResult = await deps.dropcontactAdapter.resolve({
        siren: candidate.siren,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        companyName: candidate.companyName,
        companyDomain: domain,
      });
      if (dropResult && dropResult.email && dropResult.confidence >= DROPCONTACT_MIN_CONFIDENCE) {
        signals.push('cascade.dropcontact.hit');
        return {
          siren: candidate.siren,
          dirigeantName,
          domain,
          status: 'ok',
          email: dropResult.email,
          confidence: dropResult.confidence,
          source: 'dropcontact',
          cost_cents: dropResult.cost_cents || 0,
          signals,
          elapsedMs: Date.now() - t0,
        };
      } else {
        signals.push('cascade.dropcontact.miss_post_scrape');
      }
    } catch (err) {
      signals.push(`cascade.dropcontact.error:${(err.message || '').slice(0, 30)}`);
    }
  } else if (result.status === 'ok') {
    signals.push('cascade.dropcontact.skipped_internal_ok');
  } else if (!domain) {
    signals.push('cascade.dropcontact.skipped_no_domain');
  }

  // Pas résolu : retour unresolvable
  return {
    siren: candidate.siren,
    dirigeantName,
    domain,
    status: result.status === 'ok' ? 'ok' : 'unresolvable',
    email: result.email || null,
    confidence: result.confidence || 0,
    source: result.source || 'none',
    cost_cents: result.cost_cents || 0,
    signals,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  processLead,
  makeNoOpDropcontact,
  makeExhaustiveScraper,
};
