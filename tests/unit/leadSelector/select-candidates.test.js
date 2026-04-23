/**
 * Tests unitaires — shared/leadSelector.selectCandidatesForConsultant
 * et extractCandidateFromEntity (Path additif Jalon 3).
 *
 * Couvre :
 *   - extractCandidateFromEntity forme du candidate
 *   - sans email → candidate valide (diff vs extractLeadFromEntity legacy)
 *   - selectCandidatesForConsultant retourne candidatMultiplier * batchSize
 *   - meta.source = 'candidates', pas de excludedNoEmail, ajout excludedNoDirigeant
 *   - comportement non-régression de selectLeadsForConsultant vérifié
 *     ailleurs (sector-mapping.test.js)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectCandidatesForConsultant,
  extractCandidateFromEntity,
} = require('../../../shared/leadSelector');

function mockLeadBase(candidates) {
  return {
    queryLeads: async () => candidates,
  };
}

const BRIEF_FRANCE = {
  secteurs: 'esn',
  effectif: '10-20',
  zone: 'france',
};

function buildEntity(overrides = {}) {
  return {
    siren: '123456789',
    nom: 'Acme SAS',
    codeNaf: '62.02A',
    ville: 'Paris',
    trancheEffectif: '11',
    latitude: 48.8,
    longitude: 2.3,
    dirigeants: JSON.stringify([
      { prenoms: 'Jean', nom: 'Dupont', email: 'jean.dupont@acme.fr' },
    ]),
    ...overrides,
  };
}

// ─── extractCandidateFromEntity ────────────────────────────────────────────

test('extractCandidateFromEntity — entité complète → candidate avec hintedEmail', () => {
  const cand = extractCandidateFromEntity(buildEntity());
  assert.equal(cand.siren, '123456789');
  assert.equal(cand.firstName, 'Jean');
  assert.equal(cand.lastName, 'Dupont');
  assert.equal(cand.companyName, 'Acme SAS');
  assert.equal(cand.hintedEmail, 'jean.dupont@acme.fr');
  assert.equal(cand.trancheEffectif, '11');
});

test('extractCandidateFromEntity — sans email → candidate valide (diff legacy)', () => {
  const cand = extractCandidateFromEntity(buildEntity({
    dirigeants: JSON.stringify([{ prenoms: 'Jean', nom: 'Dupont' }]),
  }));
  assert.ok(cand);
  assert.equal(cand.firstName, 'Jean');
  assert.equal(cand.hintedEmail, null);
});

test('extractCandidateFromEntity — dirigeants vide + entreprise connue → null', () => {
  // Sans firstName/lastName on ne peut pas exhauster → skip
  const cand = extractCandidateFromEntity(buildEntity({
    dirigeants: '[]',
  }));
  assert.equal(cand, null);
});

test('extractCandidateFromEntity — siren absent → null', () => {
  const cand = extractCandidateFromEntity(buildEntity({ siren: '' }));
  assert.equal(cand, null);
});

test('extractCandidateFromEntity — entreprise absente mais dirigeant ok → null', () => {
  const cand = extractCandidateFromEntity(buildEntity({ nom: '' }));
  assert.equal(cand, null);
});

test('extractCandidateFromEntity — role INSEE capturé', () => {
  const cand = extractCandidateFromEntity(buildEntity({
    dirigeants: JSON.stringify([{ prenoms: 'Jean', nom: 'Dupont', fonction: 'Président' }]),
  }));
  assert.equal(cand.inseeRole, 'Président');
});

// ─── selectCandidatesForConsultant ─────────────────────────────────────────

test('selectCandidatesForConsultant — pool = batchSize * multiplier', async () => {
  const entities = Array.from({ length: 30 }, (_, i) => buildEntity({ siren: String(100000000 + i) }));
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 5,
    candidateMultiplier: 3,
    adapters: { leadBase: mockLeadBase(entities) },
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.candidates.length, 15); // 5 * 3
  assert.equal(r.meta.source, 'candidates');
  assert.equal(r.meta.maxCandidates, 15);
  assert.equal(r.meta.excludedNoDirigeant, 0);
  // Pas de excludedNoEmail dans la meta candidates
  assert.equal(r.meta.excludedNoEmail, undefined);
});

test('selectCandidatesForConsultant — meta.source distinct de leads', async () => {
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 10,
    adapters: { leadBase: mockLeadBase([buildEntity()]) },
  });
  assert.equal(r.meta.source, 'candidates');
});

test('selectCandidatesForConsultant — entité sans email comptée comme candidate', async () => {
  // Diff vs selectLeadsForConsultant qui drop en excludedNoEmail
  const entities = [
    buildEntity({ dirigeants: JSON.stringify([{ prenoms: 'A', nom: 'A' }]) }),
    buildEntity({ siren: '222222222', dirigeants: JSON.stringify([{ prenoms: 'B', nom: 'B' }]) }),
  ];
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 10,
    adapters: { leadBase: mockLeadBase(entities) },
  });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].hintedEmail, null);
});

test('selectCandidatesForConsultant — excludedNoDirigeant tracé', async () => {
  const entities = [
    buildEntity(),
    buildEntity({ siren: '333333333', dirigeants: '[]' }), // sans dirigeant
  ];
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 10,
    adapters: { leadBase: mockLeadBase(entities) },
  });
  assert.equal(r.meta.excludedNoDirigeant, 1);
  assert.equal(r.candidates.length, 1);
});

test('selectCandidatesForConsultant — status insufficient si pool < batchSize', async () => {
  const entities = [buildEntity(), buildEntity({ siren: '222222222' })];
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 10,
    candidateMultiplier: 1,
    adapters: { leadBase: mockLeadBase(entities) },
  });
  assert.equal(r.status, 'insufficient');
  assert.equal(r.candidates.length, 2);
});

test('selectCandidatesForConsultant — NAF non mappé → empty avec reason', async () => {
  const r = await selectCandidatesForConsultant({
    brief: { secteurs: 'invalid-tag', effectif: 'any', zone: 'france' },
    batchSize: 10,
    adapters: { leadBase: mockLeadBase([]) },
  });
  assert.equal(r.status, 'empty');
  assert.equal(r.meta.reason, 'no_sector_mapped');
  assert.equal(r.meta.source, 'candidates');
});

test('selectCandidatesForConsultant — leadBase throw → status error', async () => {
  const r = await selectCandidatesForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 5,
    adapters: {
      leadBase: { queryLeads: async () => { throw new Error('azure down'); } },
    },
  });
  assert.equal(r.status, 'error');
  assert.match(r.meta.errorMessage, /azure down/);
});

// ─── Non-régression selectLeadsForConsultant : meta shape inchangée ───────

test('non-régression — selectLeadsForConsultant ne change pas la meta shape', async () => {
  const { selectLeadsForConsultant } = require('../../../shared/leadSelector');
  const entities = [buildEntity()];
  const r = await selectLeadsForConsultant({
    brief: BRIEF_FRANCE,
    batchSize: 1,
    adapters: { leadBase: mockLeadBase(entities) },
  });
  assert.equal(r.status, 'ok');
  assert.ok('excludedNoEmail' in r.meta);
  assert.ok(!('excludedNoDirigeant' in r.meta));
  // Pas de champ source (legacy)
  assert.ok(!('source' in r.meta));
});
