'use strict';

/**
 * Orchestrateur Jalon 3 — enrichissement email + profilage prospect.
 *
 * Wrappe deux étapes :
 *   1. `enrichBatchForConsultant`  (lead-exhauster) → résout les emails,
 *      produit un batch de leads prêts pour launchSequenceForConsultant.
 *   2. Pour chaque lead avec SIREN, `profileProspect` (prospect-research) →
 *      produit un profil structuré (companyProfile + decisionMakerProfile
 *      + accroche Sonnet), qui est stocké en Mem0 namespace prospect:{siren}.
 *
 * Objectif : éviter la duplication entre les deux entry points qui
 * déclenchent le pipeline (runLeadSelectorForConsultant + onQualification
 * defaultTriggerLeadSelector).
 *
 * A/B testing (SPEC_AB_TESTING + point 3 Jalon 3) :
 *   - Expérience `profiler_activation` (type mail_personalisation), variantes
 *     `non_profiled` / `profiled` assignées hash-based par siren.
 *   - Les prospects `non_profiled` sautent l'étape 2 — le consultant reçoit
 *     la séquence standard non enrichie.
 *   - Les prospects `profiled` passent par profileProspect et storeProspect.
 *   - L'info de tagging est portée dans `lead.experimentsApplied` pour que
 *     runSequence/dailyReport puissent la logger aval (cf. Interactions).
 *
 * Zero hook dans shared/worker.js : le worker retrieve déjà automatiquement
 * `prospect:{siren}` via `mem0.retrieveProspect(lead.siren)` dans
 * `resolveMem0Enrichments`. Il suffit d'écrire en amont.
 *
 * Mode dryRun (point 5 Jalon 3) :
 *   - Propage `simulated: true` à `enrichBatchForConsultant` (skip Dropcontact)
 *   - Propage `simulated: true` à `profileProspect` (skip LLM facturables)
 *   - Skip les writes Mem0 (storeProspect) mais retourne tout de même les
 *     stubs pour que l'appelant puisse vérifier le pipeline end-to-end.
 *
 * Consommé par :
 *   - `functions/runLeadSelectorForConsultant/` (endpoint HTTP manuel)
 *   - `functions/onQualification/` defaultTriggerLeadSelector (fire-and-forget)
 */

const { enrichBatchForConsultant } = require('./lead-exhauster/enrichBatch');
const { profileProspect } = require('./prospect-research');
const { buildExperimentsContext } = require('./experiments');
const { getMem0 } = require('./adapters/memory/mem0');

const PROFILER_EXPERIMENT_ID = 'profiler_activation';
const PROFILER_EXPERIMENT_TYPE = 'mail_personalisation';
const PROFILER_VARIANTS = [
  { id: 'non_profiled', weight: 1 },
  { id: 'profiled', weight: 1 },
];

/**
 * Pipeline complet : brief consultant → leads enrichis avec profil Mem0 prêt.
 *
 * @param {Object} params                     Mêmes champs que enrichBatchForConsultant
 * @param {Object} params.brief
 * @param {string} params.beneficiaryId
 * @param {number} [params.batchSize]
 * @param {number} [params.candidateMultiplier]
 * @param {boolean} [params.dryRun]           Propagé à exhauster + profileProspect
 * @param {string}  [params.briefId]
 * @param {string}  [params.consultantId]
 * @param {Object}  [params.context]
 * @param {Object}  [params.adapters]         Injection pour tests :
 *   - adapters.enrichBatch                 override du wrap étape 1
 *   - adapters.profileProspect             override du wrap étape 2
 *   - adapters.buildExperimentsContext     override tagging A/B profiler
 *   - adapters.getMem0                     override Mem0 pour storeProspect
 *   - adapters.profilerOptions             opts passés à profileProspect
 *                                          (companyLlmImpl, discImpl, pitchLlmImpl, ...)
 *   - + les adapters consommés par enrichBatchForConsultant (passés tels quels)
 *
 * @returns {Promise<{
 *   status: 'ok' | 'insufficient' | 'empty' | 'error',
 *   leads: Array,
 *   profiles: Array<{ siren, status, experimentsApplied, simulated?, skipped?, reason? }>,
 *   unresolvableCount: number,
 *   meta: Object,
 *   selectorMeta: Object,
 * }>}
 */
async function enrichAndProfileBatchForConsultant(params = {}) {
  const {
    brief = {},
    beneficiaryId,
    batchSize,
    candidateMultiplier,
    dryRun = false,
    briefId,
    consultantId,
    context,
    adapters = {},
  } = params;

  const enrichImpl = adapters.enrichBatch || enrichBatchForConsultant;
  const profileImpl = adapters.profileProspect || profileProspect;
  const buildCtx = adapters.buildExperimentsContext || buildExperimentsContext;
  const getMem0Impl = adapters.getMem0 || getMem0;
  const profilerOptions = adapters.profilerOptions || {};

  // ─── Étape 1 : enrichissement email ──────────────────────────────────
  const enrichment = await enrichImpl({
    brief,
    beneficiaryId,
    batchSize,
    candidateMultiplier,
    dryRun,
    briefId,
    consultantId,
    context,
    adapters,
  });

  if (enrichment.status === 'error' || enrichment.status === 'empty') {
    return {
      ...enrichment,
      profiles: [],
      meta: {
        ...(enrichment.meta || {}),
        profilingAttempts: 0,
        profilingOk: 0,
        profilingSkipped: 0,
        profilingSimulated: 0,
        profilingCostCents: 0,
      },
    };
  }

  // ─── Étape 2 : profilage prospect + store Mem0 ───────────────────────
  const leads = Array.isArray(enrichment.leads) ? enrichment.leads : [];
  const mem0 = safeGetMem0(getMem0Impl, context);

  const profiles = [];
  let profilingAttempts = 0;
  let profilingOk = 0;
  let profilingSkipped = 0;
  let profilingSimulated = 0;
  let profilingCostCents = 0;

  for (const lead of leads) {
    profilingAttempts++;
    const tagging = await tagLeadForProfiler({
      lead,
      beneficiaryId,
      buildCtx,
    });
    // Qu'on profile ou non, on attache les applied au lead pour que
    // runSequence/dailyReport retrouvent la variante assignée.
    lead.experimentsApplied = mergeExperimentsApplied(
      lead.contact && lead.contact.experimentsApplied,
      tagging.applied,
    );

    if (!tagging.shouldProfile) {
      profilingSkipped++;
      profiles.push({
        siren: lead.siren,
        status: 'skipped',
        reason: 'variant_non_profiled',
        experimentsApplied: tagging.applied,
      });
      continue;
    }

    if (!lead.siren) {
      profilingSkipped++;
      profiles.push({
        siren: null,
        status: 'skipped',
        reason: 'no_siren',
        experimentsApplied: tagging.applied,
      });
      continue;
    }

    const profile = await profileImpl(
      {
        siren: lead.siren,
        firstName: lead.prenom,
        lastName: lead.nom,
        role: lead.role,
        email: lead.email,
        companyName: lead.entreprise,
        companyDomain: domainFromEmail(lead.email),
        beneficiaryId,
        experimentsContext: tagging.context,
      },
      {
        context,
        simulated: Boolean(dryRun),
        ...profilerOptions,
      },
    ).catch((err) => {
      warnLog(context, `[enrichAndProfile] profileProspect throw for ${lead.siren}: ${err && err.message}`);
      return null;
    });

    if (!profile) {
      profiles.push({
        siren: lead.siren,
        status: 'error',
        experimentsApplied: tagging.applied,
      });
      continue;
    }

    profilingCostCents += Number(profile.cost_cents) || 0;
    if (profile.simulated) profilingSimulated++;
    if (profile.status === 'ok' || profile.status === 'partial') profilingOk++;

    // Storage Mem0 — zero hook dans worker, c'est ici que le lien se fait.
    // Skippé en dryRun pour ne pas polluer la mémoire avec des stubs.
    let stored = false;
    if (!dryRun && mem0 && (profile.status === 'ok' || profile.status === 'partial')) {
      const digest = buildProspectDigest(lead, profile);
      try {
        const storeRes = await mem0.storeProspect(lead.siren, digest);
        stored = storeRes !== null;
      } catch (err) {
        warnLog(context, `[enrichAndProfile] storeProspect failed for ${lead.siren}: ${err && err.message}`);
      }
    }

    // On attache aussi un pointeur léger au lead — utile pour debug/rapport.
    lead.profile = {
      status: profile.status,
      simulated: Boolean(profile.simulated),
      accroche: profile.accroche ? {
        hook: profile.accroche.hook,
        angle: profile.accroche.angle,
        discApplied: profile.accroche.discApplied,
      } : null,
    };

    profiles.push({
      siren: lead.siren,
      status: profile.status,
      simulated: Boolean(profile.simulated),
      stored,
      experimentsApplied: tagging.applied,
    });
  }

  return {
    ...enrichment,
    leads,
    profiles,
    meta: {
      ...(enrichment.meta || {}),
      profilingAttempts,
      profilingOk,
      profilingSkipped,
      profilingSimulated,
      profilingCostCents,
    },
  };
}

// ─── Helpers privés ────────────────────────────────────────────────────────

/**
 * Calcule le tag A/B pour un lead donné : combine la liste complète des
 * expériences actives applicables (via buildExperimentsContext) et la
 * décision binaire profile/skip portée par l'expérience `profiler_activation`.
 *
 * Si l'expérience n'est pas enregistrée en Azure Table (environnement
 * dev/test) ou si la registry ne la renvoie pas, on fallback sur
 * `assignVariant` inline pour que le comportement reste déterministe par
 * siren — cohérent SPEC §2 ("assignment hash-based stable").
 */
async function tagLeadForProfiler({ lead, beneficiaryId, buildCtx }) {
  const siren = lead && lead.siren;
  if (!siren) {
    return { shouldProfile: false, applied: [], context: emptyExperimentsContext() };
  }

  let context = null;
  try {
    context = await buildCtx({
      siren,
      beneficiaryId,
      type: PROFILER_EXPERIMENT_TYPE,
    });
  } catch {
    context = null;
  }

  let applied = (context && Array.isArray(context.applied)) ? context.applied.slice() : [];
  let shouldProfile;

  const fromRegistry = applied.find((a) => a.experiment_id === PROFILER_EXPERIMENT_ID);
  if (fromRegistry) {
    shouldProfile = fromRegistry.variant === 'profiled';
  } else {
    // Fallback : expérience non enregistrée → on assigne quand même pour
    // que le split 50/50 soit effectif dès Jalon 3, stable par siren.
    const { assignVariant } = require('./experiments');
    const variant = assignVariant(PROFILER_EXPERIMENT_ID, String(siren), PROFILER_VARIANTS);
    shouldProfile = variant === 'profiled';
    applied = applied.concat([{
      experiment_id: PROFILER_EXPERIMENT_ID,
      variant,
      type: PROFILER_EXPERIMENT_TYPE,
    }]);
    context = wrapAppliedAsContext(applied);
  }

  return { shouldProfile, applied, context };
}

/**
 * Prospect digest stocké en Mem0 — format verbatim consommable par le
 * worker (retrieveProspect topK=20). On garde la charge utile légère
 * pour ne pas saturer l'extraction sémantique Mem0.
 */
function buildProspectDigest(lead, profile) {
  const dm = profile.decisionMakerProfile;
  const disc = dm && dm.discScore;
  const accroche = profile.accroche;
  return {
    siren: lead.siren,
    company_name: lead.entreprise,
    company_domain: domainFromEmail(lead.email),
    email: lead.email,
    first_name: lead.prenom,
    last_name: lead.nom,
    role: (dm && dm.currentRole) || lead.role || null,
    activity: profile.companyProfile && profile.companyProfile.activiteDeclaree,
    specialties: profile.companyProfile && profile.companyProfile.specialties,
    pain_points: dm && dm.inferredPainPoints,
    disc: disc ? {
      primary: disc.primary,
      secondary: disc.secondary,
      confidence: disc.confidence,
      tone: disc.tone,
    } : null,
    accroche: accroche ? {
      hook: accroche.hook,
      angle: accroche.angle,
      disc_applied: accroche.discApplied,
    } : null,
    profile_status: profile.status,
    version: profile.version || 'v0',
    profiled_at: new Date().toISOString(),
  };
}

function mergeExperimentsApplied(a, b) {
  const seen = new Set();
  const out = [];
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue;
    for (const item of src) {
      if (!item || !item.experiment_id || !item.variant) continue;
      const key = `${item.experiment_id}::${item.variant}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ experiment_id: item.experiment_id, variant: item.variant, type: item.type });
    }
  }
  return out;
}

function safeGetMem0(getMem0Impl, context) {
  try {
    return getMem0Impl(context);
  } catch {
    return null;
  }
}

function domainFromEmail(email) {
  if (!email || typeof email !== 'string') return undefined;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).toLowerCase();
}

function emptyExperimentsContext() {
  return {
    applied: [],
    shouldApplyVariant: () => false,
  };
}

function wrapAppliedAsContext(applied) {
  return {
    applied: Array.isArray(applied) ? applied : [],
    shouldApplyVariant(experimentId, variantId) {
      return (Array.isArray(applied) ? applied : []).some(
        (a) => a.experiment_id === experimentId && a.variant === variantId,
      );
    },
  };
}

function warnLog(context, message) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(message);
  else if (typeof context.log === 'function') context.log(message);
}

module.exports = {
  enrichAndProfileBatchForConsultant,
  // Exposés pour tests :
  PROFILER_EXPERIMENT_ID,
  PROFILER_EXPERIMENT_TYPE,
  PROFILER_VARIANTS,
  buildProspectDigest,
  tagLeadForProfiler,
  mergeExperimentsApplied,
};
