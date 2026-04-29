'use strict';

/**
 * Tests unitaires — enrichBatchForConsultant + pré-passe site-finder Sprint 2.
 *
 * On stubbe selectCandidates, leadExhauster, recordUnresolvable,
 * findWebsite, writeSiteFinderResultToLeadBase via opts.adapters.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { enrichBatchForConsultant } = require('../../../shared/lead-exhauster/enrichBatch');

function makeCandidate({ siren, hintedEmail = null, partitionKey = 'A' } = {}) {
  return {
    siren,
    partitionKey,
    firstName: 'Jean',
    lastName: 'Dupont',
    companyName: 'ACME',
    ville: 'Lyon',
    codeNaf: '62.02A',
    trancheEffectif: '11',
    inseeRole: 'Président',
    contexte: 'NAF 62.02A · tranche 11 · Lyon',
    hintedEmail,
  };
}

function makeAdapters({
  candidates = [],
  exhausterResult = (cand) => ({
    status: 'ok',
    email: `${cand.firstName.toLowerCase()}.${cand.lastName.toLowerCase()}@${cand.companyDomain || 'fallback.fr'}`,
    confidence: 0.85,
    source: 'pattern',
    cost_cents: 0,
    resolvedDecisionMaker: { firstName: cand.firstName, lastName: cand.lastName },
    resolvedDomain: cand.companyDomain,
    signals: [],
  }),
  findWebsiteResult = null,
  findWebsiteThrows = null,
  writerOk = true,
} = {}) {
  const calls = {
    selectCandidates: 0,
    exhauster: [],
    findWebsite: [],
    writer: [],
    unresolvable: [],
  };
  return {
    calls,
    adapters: {
      selectCandidates: async () => {
        calls.selectCandidates++;
        return {
          status: 'ok',
          candidates,
          meta: { source: 'candidates', candidatesCount: candidates.length },
        };
      },
      leadExhauster: async (input) => {
        calls.exhauster.push(input);
        return exhausterResult(input);
      },
      recordUnresolvable: async (row) => {
        calls.unresolvable.push(row);
        return true;
      },
      findWebsite: async (input, opts) => {
        calls.findWebsite.push({ input, opts });
        if (findWebsiteThrows) throw findWebsiteThrows;
        return findWebsiteResult;
      },
      writeSiteFinderResultToLeadBase: async (siren, result, opts) => {
        calls.writer.push({ siren, result, opts });
        return writerOk;
      },
      buildExperimentsContext: async () => ({ applied: [], shouldApplyVariant: () => false }),
    },
  };
}

// ─── Pré-passe site-finder — comportement nominal ──────────────────────────

test('enrichBatch — candidate sans hintedEmail + site-finder valide → companyDomain enrichi', async () => {
  const cand = makeCandidate({ siren: '111111111', hintedEmail: null });
  const { calls, adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteResult: {
      siteUrl: 'https://acme.fr',
      confidence: 0.99,
      source: 'api_gouv',
      proofType: 'siren_match',
      validatedAt: '2026-04-29T10:00:00Z',
      attempted: [{ source: 'api_gouv', candidates: 1 }],
      signals: [],
      costCents: 0,
    },
  });
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    adapters,
  });
  assert.equal(calls.findWebsite.length, 1);
  assert.equal(calls.findWebsite[0].input.siren, '111111111');
  assert.equal(calls.findWebsite[0].input.companyName, 'ACME');
  assert.equal(calls.findWebsite[0].input.ville, 'Lyon');
  assert.equal(calls.findWebsite[0].input.dirigeantName, 'Jean Dupont');
  assert.equal(calls.findWebsite[0].opts.mode, 'on_demand');
  // L'exhauster a reçu companyDomain depuis site-finder
  assert.equal(calls.exhauster.length, 1);
  assert.equal(calls.exhauster[0].companyDomain, 'https://acme.fr');
  // Compteurs meta
  assert.equal(result.meta.siteFinderAttempts, 1);
  assert.equal(result.meta.siteFinderOk, 1);
  assert.equal(result.meta.siteFinderSkipped, 0);
});

test('enrichBatch — candidate avec hintedEmail → site-finder skippé (siteFinderSkipped++)', async () => {
  const cand = makeCandidate({ siren: '111111111', hintedEmail: 'jean.dupont@acme.fr' });
  const { calls, adapters } = makeAdapters({ candidates: [cand] });
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    adapters,
  });
  assert.equal(calls.findWebsite.length, 0);
  assert.equal(result.meta.siteFinderAttempts, 0);
  assert.equal(result.meta.siteFinderSkipped, 1);
  assert.equal(result.meta.siteFinderOk, 0);
});

test('enrichBatch — site-finder throw → candidate continue sans enrichissement', async () => {
  const cand = makeCandidate({ siren: '111111111', hintedEmail: null });
  const { calls, adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteThrows: new Error('blocked'),
  });
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    adapters,
  });
  assert.equal(calls.findWebsite.length, 1);
  // L'exhauster a été appelé sans companyDomain
  assert.equal(calls.exhauster.length, 1);
  assert.equal(calls.exhauster[0].companyDomain, undefined);
  // Compteur Attempts incrémenté (on a essayé) mais Ok pas
  assert.equal(result.meta.siteFinderAttempts, 1);
  assert.equal(result.meta.siteFinderOk, 0);
});

test('enrichBatch — site-finder retourne null → continue sans enrichissement', async () => {
  const cand = makeCandidate({ siren: '111111111', hintedEmail: null });
  const { calls, adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteResult: { siteUrl: null, confidence: 0, source: null, proofType: null, signals: [], attempted: [] },
  });
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    adapters,
  });
  assert.equal(result.meta.siteFinderAttempts, 1);
  assert.equal(result.meta.siteFinderOk, 0);
  assert.equal(calls.exhauster[0].companyDomain, undefined);
});

test('enrichBatch — site-finder OK + pas dryRun → writer LeadBase appelé', async () => {
  const cand = makeCandidate({ siren: '111111111', partitionKey: 'X' });
  const { calls, adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteResult: {
      siteUrl: 'https://acme.fr', confidence: 0.99, source: 'api_gouv',
      proofType: 'siren_match', validatedAt: '2026-04-29T10:00:00Z',
      signals: [], attempted: [], costCents: 0,
    },
  });
  await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    dryRun: false,
    adapters,
  });
  assert.equal(calls.writer.length, 1);
  assert.equal(calls.writer[0].siren, '111111111');
  assert.equal(calls.writer[0].opts.partitionKey, 'X');
});

test('enrichBatch — dryRun=true → writer LeadBase JAMAIS appelé', async () => {
  const cand = makeCandidate({ siren: '111111111' });
  const { calls, adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteResult: {
      siteUrl: 'https://acme.fr', confidence: 0.99, source: 'api_gouv',
      proofType: 'siren_match', validatedAt: '2026-04-29T10:00:00Z',
      signals: [], attempted: [], costCents: 0,
    },
  });
  await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    dryRun: true,
    adapters,
  });
  // findWebsite tourne mais pas le writer
  assert.equal(calls.findWebsite.length, 1);
  assert.equal(calls.writer.length, 0);
});

test('enrichBatch — site-finder cache hit → siteFinderCacheHits++', async () => {
  const cand = makeCandidate({ siren: '111111111' });
  const { adapters } = makeAdapters({
    candidates: [cand],
    findWebsiteResult: {
      siteUrl: 'https://acme.fr', confidence: 0.99, source: 'cache',
      proofType: 'siren_match', validatedAt: '2026-04-01T10:00:00Z',
      signals: ['cache_hit'], attempted: [], costCents: 0,
      cachedAt: '2026-04-01T10:00:00Z',
    },
  });
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 1,
    adapters,
  });
  assert.equal(result.meta.siteFinderCacheHits, 1);
  assert.equal(result.meta.siteFinderOk, 1);
});

test('enrichBatch — 3 candidates : 1 hintedEmail, 1 enrichi, 1 null → compteurs corrects', async () => {
  const cands = [
    makeCandidate({ siren: '111111111', hintedEmail: 'a@x.fr' }),
    makeCandidate({ siren: '222222222', hintedEmail: null }),
    makeCandidate({ siren: '333333333', hintedEmail: null }),
  ];
  const { calls, adapters } = makeAdapters({
    candidates: cands,
    findWebsiteResult: null, // par défaut pour tous
  });
  // Override : pour 222 on retourne un site, pour 333 on retourne null
  let callIdx = 0;
  adapters.findWebsite = async (input) => {
    calls.findWebsite.push({ input });
    callIdx++;
    if (input.siren === '222222222') {
      return {
        siteUrl: 'https://b.fr', confidence: 0.99, source: 'api_gouv',
        proofType: 'siren_match', validatedAt: '2026-04-29T10:00:00Z',
        signals: [], attempted: [], costCents: 0,
      };
    }
    return { siteUrl: null, confidence: 0, source: null, proofType: null, signals: [], attempted: [] };
  };
  const result = await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 3,
    adapters,
  });
  assert.equal(result.meta.siteFinderAttempts, 2); // 222 + 333
  assert.equal(result.meta.siteFinderOk, 1); // 222
  assert.equal(result.meta.siteFinderSkipped, 1); // 111 (hintedEmail)
});

test('enrichBatch — buildDirigeantName combine firstName et lastName', async () => {
  const cands = [
    { ...makeCandidate({ siren: '111111111' }), firstName: 'Jean', lastName: '' },
    { ...makeCandidate({ siren: '222222222' }), firstName: '', lastName: 'Dupont' },
    { ...makeCandidate({ siren: '333333333' }), firstName: 'Jean', lastName: 'Dupont' },
  ];
  const { calls, adapters } = makeAdapters({ candidates: cands, findWebsiteResult: null });
  await enrichBatchForConsultant({
    brief: {},
    beneficiaryId: 'oseys-test',
    batchSize: 3,
    adapters,
  });
  assert.equal(calls.findWebsite[0].input.dirigeantName, 'Jean');
  assert.equal(calls.findWebsite[1].input.dirigeantName, 'Dupont');
  assert.equal(calls.findWebsite[2].input.dirigeantName, 'Jean Dupont');
});
