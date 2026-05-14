'use strict';

/**
 * Tests unitaires — shared/dailyEmailCap.js (plan v3.1 Pilier 5).
 *
 * Couvre :
 *   - canSendToday default ok si pas d'entity
 *   - canSendToday ok si count < cap
 *   - canSendToday !ok si count >= cap
 *   - Graceful degradation Storage indispo → ok
 *   - mailbox vide → ok no_mailbox
 *   - incrementSentToday crée entity si 404 puis count=1
 *   - incrementSentToday +1 si entity existe
 *   - dateKey format YYYYMMDD UTC
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canSendToday,
  incrementSentToday,
  _setClientForTests,
  _resetForTests,
  _dateKey,
} = require('../../../shared/dailyEmailCap');

function mockClient({ getEntity, createEntity, updateEntity }) {
  return {
    getEntity: getEntity || (async () => { const e = new Error('not found'); e.statusCode = 404; throw e; }),
    createEntity: createEntity || (async () => true),
    updateEntity: updateEntity || (async () => true),
  };
}

test.beforeEach(() => {
  _resetForTests();
});

// ─── dateKey ────────────────────────────────────────────────────────────────

test('dateKey format YYYYMMDD UTC', () => {
  const d = new Date(Date.UTC(2026, 4, 14, 23, 59, 59)); // 14 mai 2026 UTC
  assert.equal(_dateKey(d), '20260514');
});

// ─── canSendToday ──────────────────────────────────────────────────────────

test('canSendToday — pas de Storage → ok graceful', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await canSendToday('martin@oseys.fr');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'no_storage');
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('canSendToday — mailbox vide → ok no_mailbox', async () => {
  const r = await canSendToday('');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_mailbox');
});

test('canSendToday — entity absente (404) → ok count=0', async () => {
  _setClientForTests(mockClient({}));
  const r = await canSendToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(r.cap, 30);
});

test('canSendToday — count < cap → ok', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: '20260514', rowKey: 'martin@oseys.fr', count: 15, cap: 30 }),
  }));
  const r = await canSendToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 15);
});

test('canSendToday — count >= cap → !ok daily_cap_reached', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: '20260514', rowKey: 'martin@oseys.fr', count: 30, cap: 30 }),
  }));
  const r = await canSendToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'daily_cap_reached');
  assert.equal(r.count, 30);
});

test('canSendToday — count > cap → !ok', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: '20260514', rowKey: 'martin@oseys.fr', count: 50, cap: 30 }),
  }));
  const r = await canSendToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.ok, false);
});

test('canSendToday — case insensitive sur mailbox', async () => {
  let queriedRowKey = null;
  _setClientForTests(mockClient({
    getEntity: async (pk, rk) => {
      queriedRowKey = rk;
      const e = new Error('not found'); e.statusCode = 404; throw e;
    },
  }));
  await canSendToday('MARTIN@OSEYS.FR');
  assert.equal(queriedRowKey, 'martin@oseys.fr');
});

// ─── incrementSentToday ────────────────────────────────────────────────────

test('incrementSentToday — entity absente → création count=1', async () => {
  let createdEntity = null;
  _setClientForTests(mockClient({
    createEntity: async (e) => { createdEntity = e; return true; },
  }));
  const r = await incrementSentToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.count, 1);
  assert.equal(r.cap, 30);
  assert.ok(createdEntity);
  assert.equal(createdEntity.count, 1);
  assert.equal(createdEntity.rowKey, 'martin@oseys.fr');
});

test('incrementSentToday — entity existe → +1', async () => {
  let updatedEntity = null;
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: '20260514', rowKey: 'martin@oseys.fr', count: 15, cap: 30, etag: 'W/"abc"' }),
    updateEntity: async (e) => { updatedEntity = e; return true; },
  }));
  const r = await incrementSentToday('martin@oseys.fr', { cap: 30 });
  assert.equal(r.count, 16);
  assert.equal(updatedEntity.count, 16);
});

test('incrementSentToday — pas de Storage → null', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await incrementSentToday('martin@oseys.fr');
    assert.equal(r, null);
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('incrementSentToday — mailbox vide → null', async () => {
  const r = await incrementSentToday('');
  assert.equal(r, null);
});
