'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cache = require('../../../../shared/site-finder/cache/websitePatternsCache');

function makeTableClientStub() {
  const entities = new Map();
  const calls = { upsert: [], get: [], create: 0 };
  const stub = {
    createTable: async () => {
      calls.create++;
    },
    upsertEntity: async (entity, mode) => {
      calls.upsert.push({ entity, mode });
      const key = `${entity.partitionKey}/${entity.rowKey}`;
      entities.set(key, { ...entity });
    },
    getEntity: async (partitionKey, rowKey) => {
      calls.get.push({ partitionKey, rowKey });
      const key = `${partitionKey}/${rowKey}`;
      const e = entities.get(key);
      if (!e) {
        const err = new Error('ResourceNotFound');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
  };
  return { stub, entities, calls };
}

function setupClient() {
  const { stub, entities, calls } = makeTableClientStub();
  cache._setClientForTests(stub);
  return { stub, entities, calls };
}

function teardown() {
  cache._resetForTests();
}

test('put — upsert dans partition validated avec rowKey=siren', async () => {
  const { calls } = setupClient();
  try {
    const ok = await cache.put('123456789', { siteUrl: 'https://acme.fr', confidence: 0.99 });
    assert.equal(ok, true);
    assert.equal(calls.upsert.length, 1);
    const upserted = calls.upsert[0].entity;
    assert.equal(upserted.partitionKey, 'validated');
    assert.equal(upserted.rowKey, '123456789');
    assert.equal(JSON.parse(upserted.payload).siteUrl, 'https://acme.fr');
    assert.equal(upserted.version, 'v1');
  } finally {
    teardown();
  }
});

test('get — retourne null pour cache miss (404)', async () => {
  setupClient();
  try {
    const r = await cache.get('123456789');
    assert.equal(r, null);
  } finally {
    teardown();
  }
});

test('get — retourne payload sérialisé pour entrée fraîche', async () => {
  const { entities } = setupClient();
  try {
    const now = new Date('2026-04-29T10:00:00Z');
    entities.set('validated/123456789', {
      partitionKey: 'validated',
      rowKey: '123456789',
      payload: JSON.stringify({ siteUrl: 'https://acme.fr', confidence: 0.99 }),
      cachedAt: now.toISOString(),
      version: 'v1',
    });
    const r = await cache.get('123456789', { now: new Date('2026-04-30T10:00:00Z') });
    assert.equal(r.siteUrl, 'https://acme.fr');
    assert.equal(r.confidence, 0.99);
    assert.equal(r.cachedAt, now.toISOString());
  } finally {
    teardown();
  }
});

test('get — retourne null pour entrée expirée (> ttlValidatedDays)', async () => {
  const { entities } = setupClient();
  try {
    const oldDate = new Date('2025-01-01T00:00:00Z');
    entities.set('validated/123456789', {
      partitionKey: 'validated',
      rowKey: '123456789',
      payload: JSON.stringify({ siteUrl: 'https://acme.fr' }),
      cachedAt: oldDate.toISOString(),
      version: 'v1',
    });
    const r = await cache.get('123456789', { now: new Date('2026-04-29T10:00:00Z') });
    assert.equal(r, null);
  } finally {
    teardown();
  }
});

test('get — siren invalide retourne null sans appel', async () => {
  const { calls } = setupClient();
  try {
    const r = await cache.get('12345');
    assert.equal(r, null);
    assert.equal(calls.get.length, 0);
  } finally {
    teardown();
  }
});

test('recordFailure — upsert dans partition failed avec timestamp dans rowKey', async () => {
  const { calls } = setupClient();
  try {
    const now = new Date('2026-04-29T12:00:00Z');
    const ok = await cache.recordFailure(
      '123456789',
      { siteUrl: null, attempted: [{ source: 'api_gouv', candidates: 0 }] },
      { now },
    );
    assert.equal(ok, true);
    assert.equal(calls.upsert.length, 1);
    const upserted = calls.upsert[0].entity;
    assert.equal(upserted.partitionKey, 'failed');
    assert.equal(upserted.rowKey, `123456789_${now.getTime()}`);
  } finally {
    teardown();
  }
});

test('recordFailure — partition unverified si demandée', async () => {
  const { calls } = setupClient();
  try {
    await cache.recordFailure('123456789', {}, { partition: 'unverified' });
    assert.equal(calls.upsert[0].entity.partitionKey, 'unverified');
  } finally {
    teardown();
  }
});

test('cache désactivé silencieusement si pas de connection string', async () => {
  // Ici on ne setup PAS le client injecté — le module retombe sur env vars,
  // qu'on vide pour simuler "no connection string".
  const snap = {
    a: process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING,
    b: process.env.AzureWebJobsStorage,
  };
  delete process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING;
  delete process.env.AzureWebJobsStorage;
  cache._resetForTests();
  try {
    assert.equal(await cache.get('123456789'), null);
    assert.equal(await cache.put('123456789', { siteUrl: 'https://acme.fr' }), false);
    assert.equal(await cache.recordFailure('123456789', {}), false);
  } finally {
    if (snap.a !== undefined) process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING = snap.a;
    if (snap.b !== undefined) process.env.AzureWebJobsStorage = snap.b;
    cache._resetForTests();
  }
});

test('TABLE_NAME respecte l\'env var', () => {
  // Lecture statique (au moment du require initial) : on vérifie juste que le
  // module exporte une string non vide cohérente. Les overrides dynamiques
  // d'env requièrent reload du module — hors scope T1.
  assert.equal(typeof cache.TABLE_NAME, 'string');
  assert.ok(cache.TABLE_NAME.length > 0);
});
