'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const writer = require('../../../../shared/site-finder/writers/leadbaseWriter');
const {
  writeSiteFinderResultToLeadBase,
  _setClientForTests,
  _setViolationsClientForTests,
  _resetForTests,
} = writer;

function makeCouche1Conforme(siren = '123456789', partitionKey = 'A') {
  // Couche 1 valide pour passer la précondition I-1 dans safeMergeCoucheN.
  // Note : partitionKey ne respecte pas le PK_LEADBASE_REGEX strict (département),
  // mais checkCouche1Prerequisite ne valide pas PartitionKey, seulement les
  // colonnes Couche 1 obligatoires.
  return {
    partitionKey,
    rowKey: siren,
    siren,
    nom: 'EXEMPLE SAS',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    codePostal: '75002',
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-test-fixture',
    schema_version: '1.0',
  };
}

function makeTableClientStub({ couche1Entities = {}, couche1Default = null } = {}) {
  const updates = [];
  const queryResults = [];
  const stub = {
    _entities: couche1Entities,
    updateEntity: async (entity, mode) => {
      updates.push({ entity, mode });
    },
    listEntities: () => {
      const arr = queryResults.slice();
      return (async function* () {
        for (const e of arr) yield e;
      })();
    },
    getEntity: async (pk, rk) => {
      const key = `${pk}:${rk}`;
      if (couche1Entities[key]) return couche1Entities[key];
      if (couche1Default) return { ...couche1Default, partitionKey: pk, rowKey: rk };
      const err = new Error(`Entity not found: ${key}`);
      err.statusCode = 404;
      throw err;
    },
    _seedQueryResults: (arr) => { queryResults.length = 0; for (const e of arr) queryResults.push(e); },
  };
  return { stub, updates, queryResults };
}

function makeViolationsStub() {
  const writes = [];
  return {
    stub: {
      createEntity: async (entity) => { writes.push({ entity }); },
    },
    writes,
  };
}

// ─── writeSiteFinderResultToLeadBase ────────────────────────────────────────

test('writeSiteFinderResultToLeadBase — write Merge avec Couche 1 valide', async () => {
  const couche1 = makeCouche1Conforme('123456789', 'A');
  const { stub, updates } = makeTableClientStub({
    couche1Entities: { 'A:123456789': couche1 },
  });
  const violations = makeViolationsStub();
  _setClientForTests(stub);
  _setViolationsClientForTests(violations.stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      {
        siteUrl: 'https://acme.fr',
        confidence: 0.99,
        source: 'api_gouv',
        proofType: 'siren_match',
        validatedAt: '2026-04-29T10:00:00Z',
      },
      { partitionKey: 'A' },
    );
    assert.equal(ok, true);
    assert.equal(updates.length, 1);
    const u = updates[0];
    assert.equal(u.mode, 'Merge');
    assert.equal(u.entity.partitionKey, 'A');
    assert.equal(u.entity.rowKey, '123456789');
    assert.equal(u.entity.siteWeb, 'https://acme.fr');
    assert.equal(u.entity.siteWebConfidence, 0.99);
    assert.equal(u.entity.siteWebSource, 'api_gouv');
    assert.equal(u.entity.siteWebProofType, 'siren_match');
    assert.equal(u.entity.siteWebValidatedAt, '2026-04-29T10:00:00Z');
    assert.ok(u.entity.siteWebLastCheckedAt);
    assert.equal(u.entity.siteWebVersion, 'v1');
    assert.equal(violations.writes.length, 0, 'pas de violation enregistrée');
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — sans partitionKey, lookup par RowKey', async () => {
  const couche1 = makeCouche1Conforme('123456789', 'B');
  const { stub, updates } = makeTableClientStub({
    couche1Entities: { 'B:123456789': couche1 },
  });
  stub._seedQueryResults([{ partitionKey: 'B', rowKey: '123456789' }]);
  _setClientForTests(stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase('123456789', {
      siteUrl: 'https://acme.fr',
      confidence: 0.99,
      source: 'api_gouv',
      proofType: 'siren_match',
      validatedAt: '2026-04-29T10:00:00Z',
    });
    assert.equal(ok, true);
    assert.equal(updates[0].entity.partitionKey, 'B');
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — lookup retourne 0 → return false sans write', async () => {
  const { stub, updates } = makeTableClientStub();
  // Pas de seedQueryResults : iterator vide
  _setClientForTests(stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase('123456789', {
      siteUrl: 'https://acme.fr',
      confidence: 0.99,
      source: 'api_gouv',
      proofType: 'siren_match',
    });
    assert.equal(ok, false);
    assert.equal(updates.length, 0);
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — siren invalide → false', async () => {
  const { stub, updates } = makeTableClientStub();
  _setClientForTests(stub);
  try {
    assert.equal(await writeSiteFinderResultToLeadBase('12345', {}, { partitionKey: 'A' }), false);
    assert.equal(await writeSiteFinderResultToLeadBase(null, {}, { partitionKey: 'A' }), false);
    assert.equal(updates.length, 0);
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — result null → false', async () => {
  const { stub, updates } = makeTableClientStub();
  _setClientForTests(stub);
  try {
    assert.equal(await writeSiteFinderResultToLeadBase('123456789', null, { partitionKey: 'A' }), false);
    assert.equal(updates.length, 0);
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — entrée Couche 1 absente (404) → false + violation I-1', async () => {
  const { stub, updates } = makeTableClientStub(); // pas d'entité couche1
  const violations = makeViolationsStub();
  _setClientForTests(stub);
  _setViolationsClientForTests(violations.stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      { siteUrl: 'https://acme.fr', confidence: 0.99 },
      { partitionKey: 'A' },
    );
    assert.equal(ok, false);
    assert.equal(updates.length, 0, 'pas de write si Couche 1 absente');
    assert.equal(violations.writes.length, 1);
    assert.equal(violations.writes[0].entity.reason, 'i1_entry_absent');
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — Couche 1 incomplète → false + violation I-1', async () => {
  // Entité présente mais sans codeNaf → Couche 1 non conforme
  const incomplete = makeCouche1Conforme('123456789', 'A');
  delete incomplete.codeNaf;
  const { stub, updates } = makeTableClientStub({
    couche1Entities: { 'A:123456789': incomplete },
  });
  const violations = makeViolationsStub();
  _setClientForTests(stub);
  _setViolationsClientForTests(violations.stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      { siteUrl: 'https://acme.fr', confidence: 0.99 },
      { partitionKey: 'A' },
    );
    assert.equal(ok, false);
    assert.equal(updates.length, 0);
    assert.equal(violations.writes.length, 1);
    assert.ok(
      violations.writes[0].entity.reason.startsWith('i1_'),
      `violation I-1 attendue, eu : ${violations.writes[0].entity.reason}`,
    );
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — TableClient.updateEntity throw → return false (pas de bubble)', async () => {
  const couche1 = makeCouche1Conforme('123456789', 'A');
  const stub = {
    getEntity: async () => couche1,
    updateEntity: async () => { throw new Error('storage offline'); },
    listEntities: () => (async function* () {})(),
  };
  _setClientForTests(stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      { siteUrl: 'https://acme.fr', confidence: 0.99 },
      { partitionKey: 'A' },
    );
    assert.equal(ok, false);
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — pas de connection string → false silencieux', async () => {
  const snap = {
    a: process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING,
    b: process.env.LEADBASE_STORAGE_CONNECTION_STRING,
    c: process.env.AzureWebJobsStorage,
  };
  delete process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING;
  delete process.env.LEADBASE_STORAGE_CONNECTION_STRING;
  delete process.env.AzureWebJobsStorage;
  _resetForTests();
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      { siteUrl: 'https://acme.fr', confidence: 0.99 },
      { partitionKey: 'A' },
    );
    assert.equal(ok, false);
  } finally {
    if (snap.a !== undefined) process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING = snap.a;
    if (snap.b !== undefined) process.env.LEADBASE_STORAGE_CONNECTION_STRING = snap.b;
    if (snap.c !== undefined) process.env.AzureWebJobsStorage = snap.c;
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — siteUrl null (failure cache) → écrit quand même', async () => {
  const couche1 = makeCouche1Conforme('123456789', 'A');
  const { stub, updates } = makeTableClientStub({
    couche1Entities: { 'A:123456789': couche1 },
  });
  _setClientForTests(stub);
  try {
    const ok = await writeSiteFinderResultToLeadBase(
      '123456789',
      { siteUrl: null, confidence: 0, source: null, proofType: null },
      { partitionKey: 'A' },
    );
    assert.equal(ok, true);
    assert.equal(updates[0].entity.siteWeb, null);
    assert.equal(updates[0].entity.siteWebConfidence, 0);
  } finally {
    _resetForTests();
  }
});

// Gap 5.2B — writeEmailResultToLeadBase supprimé. La Couche 4 (email) vit
// désormais en LeadContacts via shared/lead-exhauster/trace.js::upsertLeadContact.
// Tests de cette migration : tests/unit/lead-exhauster/* + couvrent le fast path
// AirWorker via batchReadLeadContactsCatchAll.
