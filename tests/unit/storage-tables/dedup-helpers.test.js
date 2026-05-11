'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Smoke tests pour les 3 helpers de dédup créés pour BL-52.
// On vérifie que les modules chargent, exposent l'API attendue, et que les
// fonctions retournent un comportement degraded mode sain quand AzureWebJobsStorage
// est absent (env vars de tests Node ne sont pas configurés vers une vraie table).

test('leadSelectorRuns — exports attendus', () => {
  const m = require('../../../shared/storage-tables/leadSelectorRuns');
  assert.equal(typeof m.tryAcquireRun, 'function');
  assert.equal(typeof m.markRunCompleted, 'function');
  assert.equal(typeof m.makeRunKey, 'function');
});

test('leadSelectorRuns.makeRunKey — slug stable', () => {
  const { makeRunKey } = require('../../../shared/storage-tables/leadSelectorRuns');
  const k1 = makeRunKey('m.dejessey@oseys.fr', 'brief_123');
  const k2 = makeRunKey('m.dejessey@oseys.fr', 'brief_123');
  assert.equal(k1, k2);
  assert.equal(k1, 'm.dejessey@oseys.fr-brief_123');
});

test('leadSelectorRuns.makeRunKey — fallback no-brief', () => {
  const { makeRunKey } = require('../../../shared/storage-tables/leadSelectorRuns');
  assert.equal(makeRunKey('a@b.c', null), 'a@b.c-no-brief');
  assert.equal(makeRunKey('a@b.c'), 'a@b.c-no-brief');
});

test('leadSelectorRuns.tryAcquireRun — degraded mode si pas de connection string', async () => {
  const original = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  // Reset module cache pour relire env
  delete require.cache[require.resolve('../../../shared/storage-tables/client')];
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
  try {
    const { tryAcquireRun } = require('../../../shared/storage-tables/leadSelectorRuns');
    const r = await tryAcquireRun({ consultantId: 'a@b.c', briefId: 'b1', jobId: 'j1' });
    assert.equal(r.acquired, true);
    assert.equal(r.reason, 'no_storage_fallback');
  } finally {
    if (original !== undefined) process.env.AzureWebJobsStorage = original;
    delete require.cache[require.resolve('../../../shared/storage-tables/client')];
    delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
  }
});

test('locks — exports attendus', () => {
  const m = require('../../../shared/storage-tables/locks');
  assert.equal(typeof m.tryAcquireLock, 'function');
  assert.equal(typeof m.releaseLock, 'function');
  assert.equal(typeof m.withLock, 'function');
  assert.equal(typeof m.makeLockKey, 'function');
  assert.equal(typeof m.LockHeldError, 'function'); // class
});

test('locks.makeLockKey — concat namespace+key', () => {
  const { makeLockKey } = require('../../../shared/storage-tables/locks');
  assert.equal(makeLockKey('person', '53802'), 'person-53802');
  assert.equal(makeLockKey('brief', 'job-1234'), 'brief-job-1234');
});

test('locks.tryAcquireLock — degraded mode si pas de storage', async () => {
  const original = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  delete require.cache[require.resolve('../../../shared/storage-tables/client')];
  delete require.cache[require.resolve('../../../shared/storage-tables/locks')];
  try {
    const { tryAcquireLock } = require('../../../shared/storage-tables/locks');
    const r = await tryAcquireLock({ namespace: 'person', key: '999', holder: 'test' });
    assert.equal(r.acquired, true);
    assert.equal(r.reason, 'no_storage_fallback');
    assert.equal(r.lockKey, 'person-999');
  } finally {
    if (original !== undefined) process.env.AzureWebJobsStorage = original;
    delete require.cache[require.resolve('../../../shared/storage-tables/client')];
    delete require.cache[require.resolve('../../../shared/storage-tables/locks')];
  }
});

test('locks.LockHeldError — classe instanciable', () => {
  const { LockHeldError } = require('../../../shared/storage-tables/locks');
  const err = new LockHeldError('held_by_other', 'person-42');
  assert.equal(err.name, 'LockHeldError');
  assert.equal(err.reason, 'held_by_other');
  assert.equal(err.lockKey, 'person-42');
  assert.ok(err.message.includes('held_by_other'));
});

test('briefDedup — exports attendus', () => {
  const m = require('../../../shared/storage-tables/briefDedup');
  assert.equal(typeof m.tryReserveBrief, 'function');
  assert.equal(typeof m.recordResponseSnapshot, 'function');
  assert.equal(typeof m.computeIdempotencyKey, 'function');
});

test('briefDedup.computeIdempotencyKey — déterministe avec mêmes inputs', () => {
  const { computeIdempotencyKey } = require('../../../shared/storage-tables/briefDedup');
  const k1 = computeIdempotencyKey({ consultantId: 'a@b.c', briefId: 'b1', sentAt: '2026-05-11T08:00:00Z' });
  const k2 = computeIdempotencyKey({ consultantId: 'a@b.c', briefId: 'b1', sentAt: '2026-05-11T08:00:00Z' });
  assert.equal(k1, k2);
  assert.equal(k1.length, 32);
});

test('briefDedup.computeIdempotencyKey — différent si inputs différents', () => {
  const { computeIdempotencyKey } = require('../../../shared/storage-tables/briefDedup');
  const k1 = computeIdempotencyKey({ consultantId: 'a@b.c', briefId: 'b1', sentAt: 't1' });
  const k2 = computeIdempotencyKey({ consultantId: 'a@b.c', briefId: 'b2', sentAt: 't1' });
  assert.notEqual(k1, k2);
});

test('briefDedup.computeIdempotencyKey — header key prioritaire si valide', () => {
  const { computeIdempotencyKey } = require('../../../shared/storage-tables/briefDedup');
  const k = computeIdempotencyKey({
    headerKey: 'client-supplied-key-abc123',
    consultantId: 'a@b.c',
    briefId: 'b1',
    sentAt: 't1',
  });
  assert.equal(k, 'client-supplied-key-abc123');
});

test('briefDedup.computeIdempotencyKey — header key trop court → fallback hash', () => {
  const { computeIdempotencyKey } = require('../../../shared/storage-tables/briefDedup');
  const k = computeIdempotencyKey({
    headerKey: 'ab', // < 8 chars
    consultantId: 'a@b.c',
    briefId: 'b1',
    sentAt: 't1',
  });
  assert.equal(k.length, 32); // fallback hash
});

test('optOutGuard — exports attendus', () => {
  const m = require('../../../shared/optOutGuard');
  assert.equal(typeof m.checkLeadCooldown, 'function');
  assert.equal(typeof m.isLeadStillSendable, 'function');
  assert.equal(typeof m.pickMostRecent, 'function');
});

test('optOutGuard.checkLeadCooldown — pas de personId → skip false', async () => {
  const { checkLeadCooldown } = require('../../../shared/optOutGuard');
  const r = await checkLeadCooldown(null);
  assert.deepEqual(r, { skip: false });
});

test('optOutGuard.isLeadStillSendable — pas de personId → sendable true', async () => {
  const { isLeadStillSendable } = require('../../../shared/optOutGuard');
  const r = await isLeadStillSendable({ personId: null });
  assert.deepEqual(r, { sendable: true });
});

test('optOutGuard.checkLeadCooldown — env vars non configurées → skip false', async () => {
  const { checkLeadCooldown } = require('../../../shared/optOutGuard');
  const originalOptOut = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  const originalRetry = process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  try {
    const r = await checkLeadCooldown('123');
    assert.deepEqual(r, { skip: false });
  } finally {
    if (originalOptOut !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = originalOptOut;
    if (originalRetry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = originalRetry;
  }
});

test('optOutGuard.checkLeadCooldown — détecte opt_out_until > today', async () => {
  const { checkLeadCooldown } = require('../../../shared/optOutGuard');
  const originalOptOut = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'opt_out_until';
  try {
    const mockPipedrive = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 1, opt_out_until: '9999-12-31', add_time: '2026-05-11' },
      ],
    };
    const r = await checkLeadCooldown('123', { pipedriveMod: mockPipedrive });
    assert.equal(r.skip, true);
    assert.equal(r.reason, 'opt_out');
    assert.equal(r.until, '9999-12-31');
  } finally {
    if (originalOptOut !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = originalOptOut;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  }
});

test('optOutGuard.checkLeadCooldown — détecte cooldown 180j sur deal le plus récent', async () => {
  const { checkLeadCooldown } = require('../../../shared/optOutGuard');
  const originalRetry = process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = 'retry_available_after';
  try {
    const futureDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const mockPipedrive = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 1, retry_available_after: futureDate, add_time: '2026-05-11' },
      ],
    };
    const r = await checkLeadCooldown('123', { pipedriveMod: mockPipedrive });
    assert.equal(r.skip, true);
    assert.equal(r.reason, 'cooldown');
    assert.equal(r.until, futureDate);
  } finally {
    if (originalRetry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = originalRetry;
    else delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  }
});

test('optOutGuard.checkLeadCooldown — pas de deals → skip false (eligible)', async () => {
  const { checkLeadCooldown } = require('../../../shared/optOutGuard');
  const originalOptOut = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'opt_out_until';
  try {
    const mockPipedrive = {
      findOpenDealsForPersonInOurPipe: async () => [],
    };
    const r = await checkLeadCooldown('123', { pipedriveMod: mockPipedrive });
    assert.equal(r.skip, false);
  } finally {
    if (originalOptOut !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = originalOptOut;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  }
});
