'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const braveQuota = require('../../../../../shared/site-finder/sources/webSearchBackends/_braveQuota');

function makeTableClientStub({ initialEntities = {}, throwOnGet = null, throwOnUpsert = null } = {}) {
  // store : Map "<pk>__<rk>" → entity
  const store = new Map();
  for (const [key, val] of Object.entries(initialEntities)) {
    store.set(key, val);
  }
  const calls = { get: [], upsert: [], createTable: 0 };
  return {
    stub: {
      createTable: async () => { calls.createTable++; },
      getEntity: async (pk, rk) => {
        calls.get.push({ pk, rk });
        if (throwOnGet) throw throwOnGet;
        const entity = store.get(`${pk}__${rk}`);
        if (!entity) {
          const err = new Error('ResourceNotFound');
          err.statusCode = 404;
          throw err;
        }
        return entity;
      },
      upsertEntity: async (entity, _mode) => {
        calls.upsert.push({ entity });
        if (throwOnUpsert) throw throwOnUpsert;
        store.set(`${entity.partitionKey}__${entity.rowKey}`, entity);
        return {};
      },
    },
    calls,
    store,
  };
}

test('getCurrentMonth — format YYYY-MM UTC', () => {
  const now = new Date('2026-05-04T18:00:00Z');
  assert.equal(braveQuota.getCurrentMonth(now), '2026-05');
});

test('getCurrentMonth — janvier padding', () => {
  const now = new Date('2026-01-15T08:00:00Z');
  assert.equal(braveQuota.getCurrentMonth(now), '2026-01');
});

test('getCurrentCount — entité absente → 0', async () => {
  braveQuota._resetForTests();
  const { stub } = makeTableClientStub();
  braveQuota._setClientForTests(stub);
  const count = await braveQuota.getCurrentCount({ month: '2026-05' });
  assert.equal(count, 0);
});

test('getCurrentCount — entité présente → count', async () => {
  braveQuota._resetForTests();
  const { stub } = makeTableClientStub({
    initialEntities: {
      '2026-05__count': { partitionKey: '2026-05', rowKey: 'count', count: 42 },
    },
  });
  braveQuota._setClientForTests(stub);
  const count = await braveQuota.getCurrentCount({ month: '2026-05' });
  assert.equal(count, 42);
});

test('getCurrentCount — pas de client → 0 (best effort)', async () => {
  braveQuota._resetForTests();
  braveQuota._setClientForTests(null);
  const count = await braveQuota.getCurrentCount({ month: '2026-05' });
  assert.equal(count, 0);
});

test('increment — première fois → écrit count=1', async () => {
  braveQuota._resetForTests();
  const { stub, calls, store } = makeTableClientStub();
  braveQuota._setClientForTests(stub);
  const ok = await braveQuota.increment({ month: '2026-05' });
  assert.equal(ok, true);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0].entity.count, 1);
  assert.equal(store.get('2026-05__count').count, 1);
});

test('increment — N fois → count=N', async () => {
  braveQuota._resetForTests();
  const { stub, store } = makeTableClientStub();
  braveQuota._setClientForTests(stub);
  await braveQuota.increment({ month: '2026-05' });
  await braveQuota.increment({ month: '2026-05' });
  await braveQuota.increment({ month: '2026-05' });
  assert.equal(store.get('2026-05__count').count, 3);
});

test('increment — mois différents → compteurs séparés', async () => {
  braveQuota._resetForTests();
  const { stub, store } = makeTableClientStub();
  braveQuota._setClientForTests(stub);
  await braveQuota.increment({ month: '2026-04' });
  await braveQuota.increment({ month: '2026-05' });
  await braveQuota.increment({ month: '2026-05' });
  assert.equal(store.get('2026-04__count').count, 1);
  assert.equal(store.get('2026-05__count').count, 2);
});

test('increment — pas de client → false (best effort)', async () => {
  braveQuota._resetForTests();
  braveQuota._setClientForTests(null);
  const ok = await braveQuota.increment({ month: '2026-05' });
  assert.equal(ok, false);
});

test('increment — upsert throw → false sans crash', async () => {
  braveQuota._resetForTests();
  const upsertErr = new Error('storage error');
  const { stub } = makeTableClientStub({ throwOnUpsert: upsertErr });
  braveQuota._setClientForTests(stub);
  const ok = await braveQuota.increment({ month: '2026-05' });
  assert.equal(ok, false);
});
