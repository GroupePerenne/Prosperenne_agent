/**
 * Tests d'intégration Jalon 3 — shared/enrichAndProfileBatch.
 *
 * Couvre les 3 scénarios attendus :
 *   1. Pipeline complet : brief → enrichBatch → profileProspect →
 *      storeProspect → variant 'profiled' tagué → lead.profile rempli
 *   2. A/B assignment stable : même siren → même variant deux appels
 *      consécutifs ; split 50/50 observable sur N=100 siren
 *   3. Mode dryRun : simulated:true propagé à enrichBatch + profileProspect,
 *      pas d'appel Mem0 storeProspect, lead.profile marqué simulated
 *
 * Tous les providers externes (LLM, Dropcontact, scraping, Mem0) sont
 * injectés via adapters. Zéro appel réseau réel.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  enrichAndProfileBatchForConsultant,
  PROFILER_EXPERIMENT_ID,
  PROFILER_VARIANTS,
  buildProspectDigest,
} = require('../../../shared/enrichAndProfileBatch');
const { assignVariant } = require('../../../shared/experiments');

function makeEnrichStub(leads = []) {
  const calls = [];
  const stub = async (params) => {
    calls.push(params);
    return {
      status: leads.length > 0 ? 'ok' : 'empty',
      leads,
      unresolvableCount: 0,
      selectorMeta: { candidatesCount: leads.length },
      meta: {
        requested: leads.length,
        returned: leads.length,
        candidatesConsidered: leads.length,
        resolutionAttempts: leads.length,
        resolutionOk: leads.length,
        resolutionUnresolvable: 0,
        costCentsTotal: 0,
        dryRun: Boolean(params.dryRun),
        elapsedMs: 1,
      },
    };
  };
  return { stub, calls };
}

function makeProfileStub({ status = 'ok', simulatedEcho = true } = {}) {
  const calls = [];
  const stub = async (input, opts) => {
    calls.push({ input, opts });
    if (simulatedEcho && opts && opts.simulated) {
      // Mime le comportement de la branche simulated de profileProspect.
      return {
        status: 'ok',
        siren: input.siren,
        simulated: true,
        companyProfile: { siren: input.siren, nomEntreprise: input.companyName, simulated: true },
        decisionMakerProfile: {
          firstName: input.firstName,
          lastName: input.lastName,
          currentRole: input.role,
          discScore: {
            primary: 'unknown', confidence: 0, tone: 'unknown',
            signals: [], inferredPainPoints: [],
          },
          simulated: true,
        },
        accroche: null,
        elapsedMs: 1,
        cost_cents: 0,
        experimentsApplied: (input.experimentsContext && input.experimentsContext.applied) || [],
        version: 'v0',
      };
    }
    return {
      status,
      siren: input.siren,
      companyProfile: {
        siren: input.siren,
        nomEntreprise: input.companyName,
        activiteDeclaree: 'Agence',
        specialties: ['Node.js'],
      },
      decisionMakerProfile: {
        firstName: input.firstName,
        lastName: input.lastName,
        currentRole: 'CEO',
        discScore: {
          primary: 'D', secondary: 'I', confidence: 0.8, tone: 'direct',
          signals: [], inferredPainPoints: ['scale'],
        },
      },
      accroche: {
        hook: `Hook pour ${input.companyName}`,
        angle: 'Angle métier.',
        discAdaptation: 'Ton direct.',
        discApplied: true,
        tone: 'direct',
      },
      elapsedMs: 10,
      cost_cents: 3,
      experimentsApplied: (input.experimentsContext && input.experimentsContext.applied) || [],
      version: 'v0',
    };
  };
  return { stub, calls };
}

function makeMem0Stub() {
  const stored = [];
  const mem0 = {
    storeProspect: async (siren, memory) => {
      stored.push({ siren, memory });
      return { id: `mem_${siren}` };
    },
  };
  return { getMem0: () => mem0, stored };
}

function makeBuildCtxThatActivates() {
  // Force la variante 'profiled' pour tout le monde en mockant
  // buildExperimentsContext comme si la registry renvoyait déjà
  // l'expérience `profiler_activation`.
  return async ({ siren }) => ({
    applied: [{
      experiment_id: PROFILER_EXPERIMENT_ID,
      variant: 'profiled',
      type: 'mail_personalisation',
    }],
    shouldApplyVariant: (id, v) => id === PROFILER_EXPERIMENT_ID && v === 'profiled',
  });
}

function makeBuildCtxHashBased() {
  // Renvoie un contexte vide → force le fallback assignVariant in-process.
  // Permet de vérifier la distribution déterministe et stable.
  return async () => ({ applied: [], shouldApplyVariant: () => false });
}

function makeLead({ siren, email, entreprise = 'ACME', prenom = 'Paul', nom = 'Rudler' }) {
  return {
    siren,
    prenom,
    nom,
    entreprise,
    email,
    secteur: '62.01Z',
    ville: 'Paris',
    contexte: '',
    contact: {
      email,
      confidence: 0.85,
      source: 'pattern-insee',
      cost_cents: 0,
      experimentsApplied: [
        { experiment_id: 'enrichment_method', variant: 'cascade', type: 'lead_enrichment' },
      ],
    },
  };
}

// ─── Scénario 1 : pipeline complet ─────────────────────────────────────────

test('pipeline complet — lead enrichi → profile → storeProspect → tags fusionnés', async () => {
  const leads = [
    makeLead({ siren: '552032534', email: 'paul@acme.fr', entreprise: 'ACME SAS' }),
  ];
  const { stub: enrichStub, calls: enrichCalls } = makeEnrichStub(leads);
  const { stub: profileStub, calls: profileCalls } = makeProfileStub();
  const { getMem0, stored } = makeMem0Stub();

  const result = await enrichAndProfileBatchForConsultant({
    brief: { nom: 'Morgane', email: 'morgane@oseys.fr', offre: 'x' },
    beneficiaryId: 'oseys-morgane',
    consultantId: 'morgane@oseys.fr',
    adapters: {
      enrichBatch: enrichStub,
      profileProspect: profileStub,
      buildExperimentsContext: makeBuildCtxThatActivates(),
      getMem0,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(enrichCalls.length, 1);
  assert.equal(enrichCalls[0].dryRun, false);
  assert.equal(profileCalls.length, 1);
  assert.equal(profileCalls[0].input.siren, '552032534');
  // experimentsContext bien injecté dans profileProspect
  assert.ok(profileCalls[0].input.experimentsContext);
  assert.equal(
    profileCalls[0].input.experimentsContext.applied[0].experiment_id,
    PROFILER_EXPERIMENT_ID,
  );
  // Store Mem0 appelé avec digest
  assert.equal(stored.length, 1);
  assert.equal(stored[0].siren, '552032534');
  assert.equal(stored[0].memory.company_name, 'ACME SAS');
  assert.equal(stored[0].memory.disc.primary, 'D');
  assert.equal(stored[0].memory.accroche.hook, 'Hook pour ACME SAS');
  // Profile attaché au lead (pour runSequence/dailyReport)
  assert.equal(result.leads[0].profile.status, 'ok');
  assert.equal(result.leads[0].profile.simulated, false);
  assert.equal(result.leads[0].profile.accroche.hook, 'Hook pour ACME SAS');
  // Experiments fusionnés : enrichment_method (exhauster) + profiler_activation
  const ids = result.leads[0].experimentsApplied.map((x) => x.experiment_id).sort();
  assert.deepEqual(ids, ['enrichment_method', 'profiler_activation']);
  // Meta enrichie
  assert.equal(result.meta.profilingAttempts, 1);
  assert.equal(result.meta.profilingOk, 1);
  assert.equal(result.meta.profilingSkipped, 0);
  assert.equal(result.meta.profilingCostCents, 3);
  // Profiles liste retournée
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].stored, true);
});

// ─── Scénario 2 : A/B assignment stable + distribution 50/50 ──────────────

test('A/B profiler_activation — variant stable par siren (appel répété)', async () => {
  const siren = '123456789';
  const variant1 = assignVariant(PROFILER_EXPERIMENT_ID, siren, PROFILER_VARIANTS);
  const variant2 = assignVariant(PROFILER_EXPERIMENT_ID, siren, PROFILER_VARIANTS);
  const variant3 = assignVariant(PROFILER_EXPERIMENT_ID, siren, PROFILER_VARIANTS);
  assert.equal(variant1, variant2);
  assert.equal(variant2, variant3);
  assert.ok(variant1 === 'profiled' || variant1 === 'non_profiled');
});

test('A/B profiler_activation — distribution ~50/50 sur 100 siren', async () => {
  const leads = [];
  for (let i = 0; i < 100; i++) {
    const siren = String(100000000 + i);
    leads.push(makeLead({ siren, email: `p${i}@x.com`, entreprise: `Co${i}` }));
  }
  const { stub: enrichStub } = makeEnrichStub(leads);
  const { stub: profileStub, calls: profileCalls } = makeProfileStub();
  const { getMem0 } = makeMem0Stub();

  const result = await enrichAndProfileBatchForConsultant({
    brief: { nom: 'Morgane' },
    beneficiaryId: 'oseys-morgane',
    adapters: {
      enrichBatch: enrichStub,
      profileProspect: profileStub,
      // registry vide → fallback assignVariant → split hash-based
      buildExperimentsContext: makeBuildCtxHashBased(),
      getMem0,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.leads.length, 100);
  // Chaque lead porte la variante — le split doit être 30-70 côté profiled
  const profiledCount = result.leads.filter((l) =>
    l.experimentsApplied.some((x) => x.experiment_id === PROFILER_EXPERIMENT_ID && x.variant === 'profiled'),
  ).length;
  const nonProfiledCount = result.leads.filter((l) =>
    l.experimentsApplied.some((x) => x.experiment_id === PROFILER_EXPERIMENT_ID && x.variant === 'non_profiled'),
  ).length;
  assert.equal(profiledCount + nonProfiledCount, 100);
  assert.ok(profiledCount >= 30 && profiledCount <= 70, `profiled=${profiledCount}`);
  assert.ok(nonProfiledCount >= 30 && nonProfiledCount <= 70, `non_profiled=${nonProfiledCount}`);
  // profileProspect n'est appelé QUE sur les leads profiled
  assert.equal(profileCalls.length, profiledCount);
  // Meta cohérente
  assert.equal(result.meta.profilingAttempts, 100);
  assert.equal(result.meta.profilingOk, profiledCount);
  assert.equal(result.meta.profilingSkipped, nonProfiledCount);
});

// ─── Scénario 3 : dryRun propage simulated sans polluer Mem0 ──────────────

test('dryRun — simulated:true propagé à enrichBatch + profileProspect, skip storeProspect', async () => {
  const leads = [
    makeLead({ siren: '552032534', email: 'paul@acme.fr', entreprise: 'ACME SAS' }),
  ];
  const { stub: enrichStub, calls: enrichCalls } = makeEnrichStub(leads);
  const { stub: profileStub, calls: profileCalls } = makeProfileStub();
  const { getMem0, stored } = makeMem0Stub();

  const result = await enrichAndProfileBatchForConsultant({
    brief: { nom: 'Morgane' },
    beneficiaryId: 'oseys-morgane',
    dryRun: true,
    adapters: {
      enrichBatch: enrichStub,
      profileProspect: profileStub,
      buildExperimentsContext: makeBuildCtxThatActivates(),
      getMem0,
    },
  });

  assert.equal(result.status, 'ok');
  // enrichBatch reçoit dryRun:true (propagé à leadExhauster → Dropcontact skip)
  assert.equal(enrichCalls[0].dryRun, true);
  // profileProspect reçoit opts.simulated:true
  assert.equal(profileCalls.length, 1);
  assert.equal(profileCalls[0].opts.simulated, true);
  // Output profile marqué simulated
  assert.equal(result.leads[0].profile.simulated, true);
  assert.equal(result.profiles[0].simulated, true);
  // Meta : profilingSimulated incrementé
  assert.equal(result.meta.profilingSimulated, 1);
  // Aucun write Mem0 en dryRun
  assert.equal(stored.length, 0);
});

// ─── Bonus : variant non_profiled court-circuite profileProspect ──────────

test('variant non_profiled — profileProspect pas appelé, lead.profile absent, tag conservé', async () => {
  const leads = [makeLead({ siren: '111111111', email: 'x@y.com' })];
  const { stub: enrichStub } = makeEnrichStub(leads);
  const { stub: profileStub, calls: profileCalls } = makeProfileStub();
  const { getMem0, stored } = makeMem0Stub();

  const result = await enrichAndProfileBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-x',
    adapters: {
      enrichBatch: enrichStub,
      profileProspect: profileStub,
      buildExperimentsContext: async () => ({
        applied: [{
          experiment_id: PROFILER_EXPERIMENT_ID,
          variant: 'non_profiled',
          type: 'mail_personalisation',
        }],
        shouldApplyVariant: () => true,
      }),
      getMem0,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(profileCalls.length, 0);
  assert.equal(stored.length, 0);
  assert.equal(result.profiles[0].status, 'skipped');
  assert.equal(result.profiles[0].reason, 'variant_non_profiled');
  // Le tag reste attaché au lead — runSequence/dailyReport le logger aval
  const tag = result.leads[0].experimentsApplied.find(
    (x) => x.experiment_id === PROFILER_EXPERIMENT_ID,
  );
  assert.ok(tag);
  assert.equal(tag.variant, 'non_profiled');
});

// ─── Bonus : enrichment empty court-circuite profile + retourne meta 0 ────

test('enrichment empty — profile pas déclenché, meta profiling * 0', async () => {
  const { stub: enrichStub } = makeEnrichStub([]);
  const { stub: profileStub, calls: profileCalls } = makeProfileStub();
  const { getMem0 } = makeMem0Stub();

  const result = await enrichAndProfileBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-x',
    adapters: {
      enrichBatch: enrichStub,
      profileProspect: profileStub,
      buildExperimentsContext: makeBuildCtxThatActivates(),
      getMem0,
    },
  });

  assert.equal(result.status, 'empty');
  assert.equal(profileCalls.length, 0);
  assert.deepEqual(result.profiles, []);
  assert.equal(result.meta.profilingAttempts, 0);
  assert.equal(result.meta.profilingOk, 0);
});

// ─── Bonus : buildProspectDigest forme le payload Mem0 attendu ────────────

test('buildProspectDigest — forme stable, contient siren + accroche + DISC', () => {
  const lead = makeLead({ siren: '111222333', email: 'x@y.com', entreprise: 'Co' });
  const profile = {
    status: 'ok',
    siren: '111222333',
    companyProfile: {
      nomEntreprise: 'Co',
      activiteDeclaree: 'Conseil',
      specialties: ['audit'],
    },
    decisionMakerProfile: {
      currentRole: 'CEO',
      discScore: { primary: 'D', secondary: 'I', confidence: 0.7, tone: 'direct' },
      inferredPainPoints: ['pricing'],
    },
    accroche: { hook: 'H', angle: 'A', discApplied: true },
    version: 'v0',
  };
  const digest = buildProspectDigest(lead, profile);
  assert.equal(digest.siren, '111222333');
  assert.equal(digest.company_name, 'Co');
  assert.equal(digest.role, 'CEO');
  assert.equal(digest.activity, 'Conseil');
  assert.deepEqual(digest.specialties, ['audit']);
  assert.deepEqual(digest.pain_points, ['pricing']);
  assert.equal(digest.disc.primary, 'D');
  assert.equal(digest.accroche.hook, 'H');
  assert.equal(digest.accroche.disc_applied, true);
  assert.equal(digest.profile_status, 'ok');
  assert.equal(digest.version, 'v0');
  assert.match(digest.profiled_at, /^\d{4}-\d{2}-\d{2}T/);
});
