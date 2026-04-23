'use strict';

/**
 * Orchestrateur de haut niveau : brief consultant → batch de leads enrichis
 * prêts à être envoyés par runSequence.
 *
 * Remplace l'ancien flow `selectLeadsForConsultant → launchSequenceForConsultant`
 * par le nouveau pipeline Jalon 3 :
 *
 *   1. `selectCandidatesForConsultant` produit un pool N × batchSize de
 *      candidats (sans filtre email)
 *   2. Pour chaque candidat, `leadExhauster` résout l'email (patterns +
 *      scraping + LinkedIn + éventuellement Dropcontact)
 *   3. Les candidats résolus (status='ok') deviennent des `Lead` utilisables
 *      par `launchSequenceForConsultant`
 *   4. Les candidats non résolus sont tracés dans `EmailUnresolvable`
 *   5. Si batchSize non atteint, le caller peut envoyer le mail
 *      "base à affiner" via `buildInsufficientBatchMail`
 *
 * Consommé par :
 *   - `functions/runLeadSelectorForConsultant/` (endpoint HTTP manuel)
 *   - `functions/onQualification/` (fire-and-forget après soumission brief)
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §9.1 "Intégration dans le pipeline existant".
 */

const { selectCandidatesForConsultant } = require('../leadSelector');
const { leadExhauster } = require('./index');
const { recordUnresolvable } = require('./unresolvableTrace');
const { DEFAULT_CONFIDENCE_THRESHOLD } = require('./schemas');

/**
 * Enrichit un brief en batch prêt pour launchSequenceForConsultant.
 *
 * @param {Object} params
 * @param {Object} params.brief                   Brief consultant (format formulaire)
 * @param {string} params.beneficiaryId           Scoping cache / budget / RGPD
 * @param {number} [params.batchSize]             Nombre visé de leads enrichis
 * @param {number} [params.candidateMultiplier]
 * @param {boolean} [params.dryRun]               Simulated (pas d appel Dropcontact)
 * @param {Object}  [params.adapters]             Override pour tests
 *   - adapters.selectCandidates, adapters.leadExhauster,
 *     adapters.recordUnresolvable, adapters.buildExperimentsContext
 * @param {string}  [params.briefId]              Pour trace
 * @param {string}  [params.consultantId]         Pour trace
 * @param {Object}  [params.context]
 * @returns {Promise<{
 *   status: 'ok' | 'insufficient' | 'empty' | 'error',
 *   leads: Array,
 *   unresolvableCount: number,
 *   meta: Object,
 *   selectorMeta: Object,
 * }>}
 */
async function enrichBatchForConsultant(params = {}) {
  const started = Date.now();
  const {
    brief = {},
    beneficiaryId,
    batchSize = 10,
    candidateMultiplier,
    dryRun = false,
    adapters = {},
    briefId,
    consultantId,
    context,
  } = params;

  const selector = adapters.selectCandidates || selectCandidatesForConsultant;
  const exhauster = adapters.leadExhauster || leadExhauster;
  const unresolvableWriter = adapters.recordUnresolvable || recordUnresolvable;
  const buildCtx = adapters.buildExperimentsContext || defaultBuildExperimentsContext;

  if (!beneficiaryId) {
    return errorResult(started, 'missing_beneficiary_id');
  }

  // ─── Étape 1 : sélection candidates ──────────────────────────────────
  const selectorResult = await selector({
    brief,
    batchSize,
    candidateMultiplier,
    adapters,
    context,
    briefId,
    consultantId,
  });

  if (selectorResult.status === 'empty' || selectorResult.status === 'error') {
    return {
      status: selectorResult.status,
      leads: [],
      unresolvableCount: 0,
      selectorMeta: selectorResult.meta,
      meta: {
        requested: batchSize,
        candidatesConsidered: 0,
        resolutionAttempts: 0,
        resolutionOk: 0,
        resolutionUnresolvable: 0,
        costCentsTotal: 0,
        dryRun,
        elapsedMs: Date.now() - started,
        reason: selectorResult.meta && (selectorResult.meta.reason || selectorResult.meta.errorCode),
      },
    };
  }

  // ─── Étape 2 : boucle exhauster séquentielle ────────────────────────
  const leads = [];
  const candidates = Array.isArray(selectorResult.candidates) ? selectorResult.candidates : [];
  let resolutionAttempts = 0;
  let resolutionOk = 0;
  let resolutionUnresolvable = 0;
  let costCentsTotal = 0;
  const unresolvablePromises = [];

  for (const cand of candidates) {
    if (leads.length >= batchSize) break;
    resolutionAttempts++;

    const experimentsContext = await buildCtx({
      siren: cand.siren,
      beneficiaryId,
      naf: cand.codeNaf,
      tranche: cand.trancheEffectif,
    }).catch(() => null);

    const enrichment = await exhauster(
      {
        siren: cand.siren,
        beneficiaryId,
        firstName: cand.firstName,
        lastName: cand.lastName,
        companyName: cand.companyName,
        companyDomain: cand.hintedEmail ? domainFromEmail(cand.hintedEmail) : undefined,
        inseeRole: cand.inseeRole,
        trancheEffectif: cand.trancheEffectif,
        naf: cand.codeNaf,
        experimentsContext,
        simulated: Boolean(dryRun),
      },
      { adapters, context },
    ).catch((err) => {
      logWarn(context, `[enrichBatch] exhauster throw for ${cand.siren}: ${err && err.message}`);
      return { status: 'error', email: null, signals: ['exception'] };
    });

    if (enrichment.status === 'ok' && enrichment.email) {
      resolutionOk++;
      costCentsTotal += Number(enrichment.cost_cents) || 0;
      leads.push(buildLeadFromCandidate(cand, enrichment));
    } else {
      resolutionUnresolvable++;
      unresolvablePromises.push(
        Promise.resolve(
          unresolvableWriter({
            beneficiaryId,
            siren: cand.siren,
            reason: enrichment.status === 'error' ? 'error' : 'unresolvable',
            signalsExhausted: Array.isArray(enrichment.signals) ? enrichment.signals : [],
            firstName: cand.firstName,
            lastName: cand.lastName,
            companyName: cand.companyName,
          }),
        ).catch(() => {}),
      );
    }
  }

  // Fire-and-forget des writes unresolvable (on n'attend pas la fin pour
  // répondre au caller)
  Promise.all(unresolvablePromises).catch(() => {});

  const status = leads.length === 0
    ? 'empty'
    : leads.length < batchSize
      ? 'insufficient'
      : 'ok';

  return {
    status,
    leads,
    unresolvableCount: resolutionUnresolvable,
    selectorMeta: selectorResult.meta,
    meta: {
      requested: batchSize,
      returned: leads.length,
      candidatesConsidered: candidates.length,
      resolutionAttempts,
      resolutionOk,
      resolutionUnresolvable,
      costCentsTotal,
      dryRun: Boolean(dryRun),
      elapsedMs: Date.now() - started,
    },
  };
}

/**
 * Helper : construit le payload consommé par `launchSequenceForConsultant`
 * à partir d'un candidate LeadBase + d'un résultat exhauster.
 *
 * Format compatible avec l'ancien DTO `extractLeadFromEntity` pour que
 * orchestrator.js:launchSequenceForConsultant n'ait rien à changer :
 *   { prenom, nom, entreprise, email, secteur, ville, contexte, siren,
 *     contact: <enrichment> }
 *
 * Le champ `contact` transporte la trace exhauster (source, confidence,
 * cost_cents, signals) pour que runSequence/dailyReport puissent l'exploiter.
 */
function buildLeadFromCandidate(cand, enrichment) {
  const dm = enrichment.resolvedDecisionMaker;
  return {
    siren: cand.siren,
    prenom: (dm && dm.firstName) || cand.firstName || '',
    nom: (dm && dm.lastName) || cand.lastName || '',
    entreprise: cand.companyName,
    email: enrichment.email,
    secteur: cand.codeNaf || '',
    ville: cand.ville || '',
    contexte: cand.contexte || '',
    contact: {
      email: enrichment.email,
      confidence: enrichment.confidence,
      source: enrichment.source,
      cost_cents: enrichment.cost_cents,
      resolvedDomain: enrichment.resolvedDomain,
      experimentsApplied: enrichment.experimentsApplied,
    },
  };
}

/**
 * Construit le mail d'insuffisance consolidé post-exhauster.
 * Migré depuis `functions/onQualification/index.js:buildInsufficientBriefMail`
 * (point Paul #1 Jalon 3). Le format s'enrichit des métriques exhauster
 * pour donner au consultant une vue honnête du coût de ciblage.
 *
 * @param {Object} brief
 * @param {Object} result  Retour d'enrichBatchForConsultant
 * @returns {string} HTML prêt à être passé à sendMail
 */
function buildInsufficientBatchMail(brief, result) {
  const meta = (result && result.meta) || {};
  const selectorMeta = (result && result.selectorMeta) || {};
  const prenomConsultant = String(brief.nom || '').split(/\s+/)[0] || 'Consultant';
  const checks = [
    `Secteurs NAF ciblés : ${(selectorMeta.nafCodesQueried && selectorMeta.nafCodesQueried.length) || 0} codes`,
    `Effectif : tranches ${(selectorMeta.effectifCodesQueried || []).join(', ') || '—'}`,
    `Candidats dans la base : ${selectorMeta.candidatesCount || 0}`,
    `Exclus par nos règles produit : ${selectorMeta.excludedByRules || 0}`,
    `Candidats sans dirigeant exploitable : ${selectorMeta.excludedNoDirigeant || 0}`,
    `Tentatives de résolution email : ${meta.resolutionAttempts || 0}`,
    `Emails résolus avec confiance ≥ ${DEFAULT_CONFIDENCE_THRESHOLD} : ${meta.resolutionOk || 0}`,
    `Emails non résolus (file unresolvable) : ${meta.resolutionUnresolvable || 0}`,
  ];
  const suggestions = buildSuggestions(brief, result);
  const li = (s) => `<li>${escapeHtml(s)}</li>`;
  return `<div style="font-family:Arial,sans-serif;color:#1a1714">
<p>Salut ${escapeHtml(prenomConsultant)},</p>
<p>J'ai lancé la sélection et l'enrichissement de la base cible : ${meta.returned || 0} leads prêts sur les ${meta.requested || 10} attendus.</p>
<p>Ce que j'ai regardé :</p>
<ul>${checks.map(li).join('')}</ul>
<p>Mes propositions pour élargir :</p>
<ul>${suggestions.map(li).join('')}</ul>
<p>Dis-moi ce qui te va et je relance la sélection.</p>
<p>David</p>
</div>`;
}

function buildSuggestions(brief, result) {
  const out = [];
  const selectorMeta = (result && result.selectorMeta) || {};
  const meta = (result && result.meta) || {};
  const rayon = Number(brief.zone_rayon);
  if (rayon && rayon < 50) {
    out.push(`Élargir le rayon de ${rayon} km à 50 km ou 75 km`);
  }
  const zone = String(brief.zone || '').toLowerCase();
  if (zone !== 'france' && zone !== 'region') {
    out.push("Passer à la région entière ou à la France entière");
  }
  if (brief.effectif && !String(brief.effectif).includes('40-75') && !String(brief.effectif).includes('any')) {
    out.push("Étendre l'effectif aux entreprises 40-75 salariés");
  }
  if (meta.resolutionUnresolvable && meta.resolutionOk !== undefined
    && meta.resolutionUnresolvable > (meta.resolutionOk || 0)) {
    out.push("Beaucoup de prospects non résolus — la cascade Dropcontact va les reprendre si le budget le permet (vérifier Budgets/dropcontact pour ce mois)");
  }
  if (selectorMeta.excludedNoDirigeant > selectorMeta.candidatesCount * 0.3) {
    out.push("Beaucoup d'entités sans dirigeant renseigné en base — ciblage à ajuster");
  }
  if (out.length === 0) {
    out.push("Ajouter un secteur NAF complémentaire via le formulaire (autocomplete 'Autres secteurs ou codes NAF')");
  }
  return out;
}

// ─── Helpers privés ────────────────────────────────────────────────────────

function domainFromEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).toLowerCase();
}

function errorResult(started, reason) {
  return {
    status: 'error',
    leads: [],
    unresolvableCount: 0,
    selectorMeta: null,
    meta: {
      requested: 0,
      candidatesConsidered: 0,
      resolutionAttempts: 0,
      resolutionOk: 0,
      resolutionUnresolvable: 0,
      costCentsTotal: 0,
      dryRun: false,
      elapsedMs: Date.now() - started,
      reason,
    },
  };
}

async function defaultBuildExperimentsContext(entity) {
  // Lazy-require pour ne pas forcer la présence de shared/experiments
  // dans les tests unitaires qui mockent déjà ce helper.
  try {
    const { buildExperimentsContext } = require('../experiments');
    return buildExperimentsContext(entity);
  } catch {
    return { applied: [], shouldApplyVariant: () => false };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function logWarn(context, message) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(message);
  else if (typeof context.log === 'function') context.log(message);
}

module.exports = {
  enrichBatchForConsultant,
  buildInsufficientBatchMail,
  // exposés pour tests :
  buildLeadFromCandidate,
  buildSuggestions,
  domainFromEmail,
};
