/**
 * Tests — shared/prospect-research/index.js (orchestrateur V0)
 *
 * Vérifie le contrat d'output, la dérivation du status, et le pass-through
 * des injections aux sources couche A.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  profileProspect,
  _deriveStatus,
  _extractExperimentsApplied,
} = require('../../../shared/prospect-research');

// ─── helpers ──────────────────────────────────────────────────────────────

test('_deriveStatus — error / partial / ok', () => {
  assert.equal(_deriveStatus({ companyProfile: null, decisionMakerProfile: null }), 'error');
  assert.equal(_deriveStatus({ companyProfile: {}, decisionMakerProfile: null }), 'partial');
  assert.equal(_deriveStatus({ companyProfile: null, decisionMakerProfile: {} }), 'partial');
  assert.equal(_deriveStatus({ companyProfile: {}, decisionMakerProfile: {} }), 'ok');
});

test('_extractExperimentsApplied — liste vide par défaut', () => {
  assert.deepEqual(_extractExperimentsApplied({}), []);
  assert.deepEqual(_extractExperimentsApplied({ experimentsContext: {} }), []);
  assert.deepEqual(
    _extractExperimentsApplied({
      experimentsContext: {
        applied: [
          { experiment_id: 'mail_personalisation', variant: 'B' },
          { experiment_id: 'bad' }, // filtré
          { variant: 'B' }, // filtré
        ],
      },
    }),
    [{ experiment_id: 'mail_personalisation', variant: 'B' }],
  );
});

// ─── profileProspect ──────────────────────────────────────────────────────

test('profileProspect — siren invalide → status error', async () => {
  const res = await profileProspect({ siren: 'bad' });
  assert.equal(res.status, 'error');
  assert.equal(res.companyProfile, null);
  assert.equal(res.decisionMakerProfile, null);
  assert.equal(res.accroche, null);
  assert.equal(res.version, 'v0');
  assert.equal(res.cost_cents, 0);
  assert.equal(res.error, 'invalid_siren');
});

test('profileProspect — couche A renvoie profil → status partial (Jalon 1)', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'Conseil',
    codeNaf: '70.22Z',
    commune: 'Paris',
    estActive: true,
  });
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ results: [], elapsedMs: 0, provider: 'stub', query: '' });

  const res = await profileProspect(
    { siren: '123456789', companyName: 'ACME' },
    { apiGouvImpl, scraperImpl, searchImpl, skipCache: true },
  );
  assert.equal(res.status, 'partial');
  assert.ok(res.companyProfile);
  assert.equal(res.companyProfile.siren, '123456789');
  assert.equal(res.companyProfile.activity, 'Conseil');
  // Jalon 2 pas encore livré
  assert.equal(res.decisionMakerProfile, null);
  assert.equal(res.accroche, null);
  assert.equal(typeof res.elapsedMs, 'number');
});

test('profileProspect — toutes sources échouent → status error', async () => {
  const res = await profileProspect(
    { siren: '123456789', companyName: 'ACME' },
    {
      apiGouvImpl: async () => null,
      scraperImpl: async () => ({ texts: [], visitedPages: [], elapsedMs: 0 }),
      searchImpl: async () => ({ results: [], elapsedMs: 0 }),
      skipCache: true,
    },
  );
  assert.equal(res.status, 'error');
  assert.equal(res.companyProfile, null);
});

test('profileProspect — experimentsContext forwarded dans experimentsApplied', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'X',
  });
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ results: [], elapsedMs: 0 });

  const res = await profileProspect(
    {
      siren: '123456789',
      companyName: 'ACME',
      experimentsContext: {
        applied: [{ experiment_id: 'mail_personalisation', variant: 'B', type: 'mail_personalisation' }],
      },
    },
    { apiGouvImpl, scraperImpl, searchImpl, skipCache: true },
  );
  assert.deepEqual(res.experimentsApplied, [
    { experiment_id: 'mail_personalisation', variant: 'B' },
  ]);
});

test('profileProspect — siren absent → error', async () => {
  const res = await profileProspect({});
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'invalid_siren');
});
