'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const writer = require('../../../../shared/site-finder/writers/leadbaseWriter');
const { writeSiteFinderResultToLeadBase, _setClientForTests, _resetForTests } = writer;

function makeTableClientStub() {
  const updates = [];
  const queryResults = [];
  const stub = {
    updateEntity: async (entity, mode) => {
      updates.push({ entity, mode });
    },
    listEntities: ({ queryOptions } = {}) => {
      // Iterator simulé sur queryResults
      const arr = queryResults.slice();
      return (async function* () {
        for (const e of arr) yield e;
      })();
    },
    _seedQueryResults: (arr) => { queryResults.length = 0; for (const e of arr) queryResults.push(e); },
  };
  return { stub, updates, queryResults };
}

test('writeSiteFinderResultToLeadBase — write Merge avec partitionKey fourni', async () => {
  const { stub, updates } = makeTableClientStub();
  _setClientForTests(stub);
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
  } finally {
    _resetForTests();
  }
});

test('writeSiteFinderResultToLeadBase — sans partitionKey, lookup par RowKey', async () => {
  const { stub, updates } = makeTableClientStub();
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

test('writeSiteFinderResultToLeadBase — TableClient.updateEntity throw → return false (pas de bubble)', async () => {
  const stub = {
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
  // Reset complet pour forcer la branche pas-de-client
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
  // Permet de tracer l'absence d'un site (cache.recordFailure côté site-finder
  // ne touche pas LeadBase, donc ce test vérifie juste que le writer accepte
  // un siteUrl null pour ne pas crasher si le caller force l'appel).
  const { stub, updates } = makeTableClientStub();
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
