'use strict';

/**
 * Tests unitaires — shared/threadBurstDetector.js (plan v3.1 Pilier 3 niveau 3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectBurst,
  recordOutboundSend,
  _setClientForTests,
  _resetForTests,
} = require('../../../shared/threadBurstDetector');

function mockClient({ entities = [], createEntity, throwOnList = false } = {}) {
  return {
    listEntities: () => {
      if (throwOnList) {
        // Async iterator qui throw au premier next
        return (async function* () { throw new Error('storage_down'); })();
      }
      return (async function* () {
        for (const e of entities) yield e;
      })();
    },
    createEntity: createEntity || (async () => true),
  };
}

test.beforeEach(() => { _resetForTests(); });

// ──────────────── detectBurst ────────────────

test('detectBurst — pas de conversationId → burst false no_conversation_id', async () => {
  const r = await detectBurst('');
  assert.equal(r.burst, false);
  assert.equal(r.reason, 'no_conversation_id');
});

test('detectBurst — Storage indispo (no AzureWebJobsStorage) → burst false no_storage', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await detectBurst('conv-123');
    assert.equal(r.burst, false);
    assert.equal(r.reason, 'no_storage');
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('detectBurst — aucune entry → burst false count=0', async () => {
  _setClientForTests(mockClient({ entities: [] }));
  const r = await detectBurst('conv-123');
  assert.equal(r.burst, false);
  assert.equal(r.count, 0);
});

test('detectBurst — count < threshold dans la window → burst false', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const within = new Date('2026-05-14T14:30:00Z').toISOString(); // 30 min in
  _setClientForTests(mockClient({
    entities: [
      { partitionKey: 'conv-123', rowKey: 'rk1', sentAtIso: within },
      { partitionKey: 'conv-123', rowKey: 'rk2', sentAtIso: within },
    ],
  }));
  const r = await detectBurst('conv-123', { now, threshold: 3, windowMinutes: 60 });
  assert.equal(r.burst, false);
  assert.equal(r.count, 2);
  assert.equal(r.threshold, 3);
});

test('detectBurst — count >= threshold dans la window → burst true', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const within = new Date('2026-05-14T14:30:00Z').toISOString();
  _setClientForTests(mockClient({
    entities: [
      { partitionKey: 'conv-123', rowKey: 'rk1', sentAtIso: within },
      { partitionKey: 'conv-123', rowKey: 'rk2', sentAtIso: within },
      { partitionKey: 'conv-123', rowKey: 'rk3', sentAtIso: within },
    ],
  }));
  const r = await detectBurst('conv-123', { now, threshold: 3, windowMinutes: 60 });
  assert.equal(r.burst, true);
  assert.equal(r.count, 3);
});

test('detectBurst — entries hors window (>1h) → ignorées', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const within = new Date('2026-05-14T14:30:00Z').toISOString(); // 30 min in
  const outOfWindow = new Date('2026-05-14T13:00:00Z').toISOString(); // 2h before
  _setClientForTests(mockClient({
    entities: [
      { partitionKey: 'conv-123', rowKey: 'rk_old1', sentAtIso: outOfWindow },
      { partitionKey: 'conv-123', rowKey: 'rk_old2', sentAtIso: outOfWindow },
      { partitionKey: 'conv-123', rowKey: 'rk_old3', sentAtIso: outOfWindow },
      { partitionKey: 'conv-123', rowKey: 'rk_new1', sentAtIso: within },
    ],
  }));
  const r = await detectBurst('conv-123', { now, threshold: 3, windowMinutes: 60 });
  assert.equal(r.burst, false);
  assert.equal(r.count, 1); // only the 1 within window
});

test('detectBurst — entry sans sentAtIso → ignorée', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const within = new Date('2026-05-14T14:30:00Z').toISOString();
  _setClientForTests(mockClient({
    entities: [
      { partitionKey: 'conv-123', rowKey: 'rk1', /* sentAtIso manquant */ },
      { partitionKey: 'conv-123', rowKey: 'rk2', sentAtIso: within },
    ],
  }));
  const r = await detectBurst('conv-123', { now, threshold: 3, windowMinutes: 60 });
  assert.equal(r.count, 1);
});

test('detectBurst — storage error → burst false reason storage_error', async () => {
  _setClientForTests(mockClient({ throwOnList: true }));
  const r = await detectBurst('conv-123');
  assert.equal(r.burst, false);
  assert.match(r.reason, /^storage_error:/);
});

test('detectBurst — windowMinutes/threshold override fonctionnent', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const ts = new Date('2026-05-14T14:55:00Z').toISOString(); // 5 min in
  _setClientForTests(mockClient({
    entities: [
      { partitionKey: 'c', rowKey: 'a', sentAtIso: ts },
      { partitionKey: 'c', rowKey: 'b', sentAtIso: ts },
    ],
  }));
  // threshold=2, window=10min → burst true
  const r = await detectBurst('c', { now, threshold: 2, windowMinutes: 10 });
  assert.equal(r.burst, true);
  assert.equal(r.windowMinutes, 10);
  assert.equal(r.threshold, 2);
});

test('detectBurst — court-circuit dès threshold atteint (pas d\'itération inutile)', async () => {
  const now = new Date('2026-05-14T15:00:00Z');
  const within = new Date('2026-05-14T14:30:00Z').toISOString();
  let visited = 0;
  const client = {
    listEntities: () => (async function* () {
      const items = Array(10).fill(0).map((_, i) => ({
        partitionKey: 'c', rowKey: `r${i}`, sentAtIso: within,
      }));
      for (const e of items) { visited++; yield e; }
    })(),
  };
  _setClientForTests(client);
  await detectBurst('c', { now, threshold: 3, windowMinutes: 60 });
  // Court-circuit attendu : devrait s'arrêter à 3, pas itérer les 10
  assert.equal(visited, 3);
});

// ──────────────── recordOutboundSend ────────────────

test('recordOutboundSend — pas de conversationId → recorded false', async () => {
  const r = await recordOutboundSend('');
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no_conversation_id');
});

test('recordOutboundSend — Storage indispo → recorded false', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await recordOutboundSend('conv-123');
    assert.equal(r.recorded, false);
    assert.equal(r.reason, 'no_storage');
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('recordOutboundSend — createEntity OK → recorded true + entity bien formée', async () => {
  let captured;
  _setClientForTests(mockClient({
    createEntity: async (e) => { captured = e; return true; },
  }));
  const sentAt = new Date('2026-05-14T15:00:00Z');
  const r = await recordOutboundSend('conv-456', { sentAt, subject: 'J0 test sujet long qui sera tronqué à 64 chars exactement pour éviter le bruit en table' });
  assert.equal(r.recorded, true);
  assert.equal(captured.partitionKey, 'conv-456');
  assert.match(captured.rowKey, /^\d{13}_[a-z0-9]+$/);
  assert.equal(captured.sentAtIso, sentAt.toISOString());
  // Subject tronqué à 64
  assert.equal(captured.subject.length, 64);
});

test('recordOutboundSend — createEntity throw → recorded false reason storage_error', async () => {
  _setClientForTests(mockClient({
    createEntity: async () => { throw new Error('table_busy'); },
  }));
  const r = await recordOutboundSend('conv-789');
  assert.equal(r.recorded, false);
  assert.match(r.reason, /^storage_error:table_busy/);
});

test('recordOutboundSend — sans subject → entry créée avec subject vide', async () => {
  let captured;
  _setClientForTests(mockClient({
    createEntity: async (e) => { captured = e; return true; },
  }));
  await recordOutboundSend('conv-x');
  assert.equal(captured.subject, '');
});
