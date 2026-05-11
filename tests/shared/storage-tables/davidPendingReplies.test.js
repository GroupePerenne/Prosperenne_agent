'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/davidPendingReplies');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;
let captured;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/davidPendingReplies');
}

function installClientStub(stub) {
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/davidPendingReplies\.js$/.test(parent.filename) && request === './client') {
      return stub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

function restoreLoader() {
  if (originalLoad) {
    Module._load = originalLoad;
    originalLoad = null;
  }
}

function makeFakeClient(initial = []) {
  const store = new Map(); // rowKey → entity
  for (const e of initial) store.set(e.rowKey, e);
  return {
    _store: store,
    createTable: async () => {},
    createEntity: async (entity) => {
      if (store.has(entity.rowKey)) {
        const err = new Error('EntityAlreadyExists');
        err.statusCode = 409;
        throw err;
      }
      store.set(entity.rowKey, { ...entity, etag: 'W/"datetime0"' });
      captured.creates.push(entity);
    },
    updateEntity: async (entity, _mode) => {
      const existing = store.get(entity.rowKey);
      if (!existing) {
        const err = new Error('NotFound');
        err.statusCode = 404;
        throw err;
      }
      store.set(entity.rowKey, { ...existing, ...entity });
      captured.updates.push({ entity, mode: _mode });
    },
    listEntities: ({ queryOptions } = {}) => ({
      async *[Symbol.asyncIterator]() {
        const all = Array.from(store.values()).sort((a, b) => a.rowKey.localeCompare(b.rowKey));
        // Très basique : on simule un filter status=pending scheduledAtIso le 'X'
        const filter = (queryOptions && queryOptions.filter) || '';
        const upperBoundMatch = filter.match(/scheduledAtIso le '([^']+)'/);
        const upperBound = upperBoundMatch ? upperBoundMatch[1] : null;
        const wantsPending = /status eq 'pending'/.test(filter);
        for (const e of all) {
          if (wantsPending && e.status !== 'pending') continue;
          if (upperBound && e.scheduledAtIso > upperBound) continue;
          yield e;
        }
      },
    }),
  };
}

beforeEach(() => {
  captured = { creates: [], updates: [] };
});

afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

// ─── No-op si pas de client ────────────────────────────────────────────────

test('enqueuePendingReply retourne enqueued=false si pas de client', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.enqueuePendingReply({
    mailbox: 'david@oseys.fr',
    to: 'elie@oseys.fr',
    subject: 'Re: bienvenue',
    html: '<p>hello</p>',
    scheduledAt: new Date('2026-05-12T09:30:00.000Z'),
    senderType: 'consultant',
  });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, 'no_storage');
});

test('listDueReplies retourne [] si pas de client', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const due = await mod.listDueReplies(new Date());
  assert.deepEqual(due, []);
});

test('flushDueReplies retourne stats vides si pas de client', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const stats = await mod.flushDueReplies({ sendFn: async () => {} });
  assert.deepEqual(stats, { total: 0, sent: 0, failed: 0 });
});

// ─── enqueuePendingReply happy path ────────────────────────────────────────

test('enqueuePendingReply écrit une entry pending complète', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const scheduledAt = new Date('2026-05-12T09:30:00.000Z');
  const result = await mod.enqueuePendingReply({
    mailbox: 'david@oseys.fr',
    to: 'elie.mougel@oseys.fr',
    subject: 'Re: Bienvenue dans le réseau OSEYS',
    html: '<p>Salut Elie</p>',
    cc: ['m.dejessey@oseys.fr'],
    scheduledAt,
    senderType: 'consultant',
    jitterKind: 'consultant',
    originalMessageId: 'AAMkAGI...',
    originalSubject: 'Bienvenue dans le réseau OSEYS, Elie',
    originalSender: 'elie.mougel@oseys.fr',
    consultantEmail: 'elie.mougel@oseys.fr',
  });

  assert.equal(result.enqueued, true);
  assert.equal(result.scheduledAtIso, '2026-05-12T09:30:00.000Z');
  assert.match(result.rowKey, /^2026-05-12T09:30:00\.000Z_[0-9a-f-]+$/);
  assert.equal(captured.creates.length, 1);
  const e = captured.creates[0];
  assert.equal(e.partitionKey, 'pending');
  assert.equal(e.status, 'pending');
  assert.equal(e.mailbox, 'david@oseys.fr');
  assert.equal(e.to, 'elie.mougel@oseys.fr');
  assert.equal(e.senderType, 'consultant');
  assert.equal(e.jitterKind, 'consultant');
  assert.equal(e.prospectClass, null);
  assert.equal(e.ccJson, JSON.stringify(['m.dejessey@oseys.fr']));
  assert.equal(e.originalMessageId, 'AAMkAGI...');
});

test('enqueuePendingReply préserve prospectClass et dealId', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.enqueuePendingReply({
    mailbox: 'martin@oseys.fr',
    to: 'prospect@example.com',
    subject: 'Re: Question',
    html: '<p>Bonjour</p>',
    scheduledAt: new Date('2026-05-12T10:00:00.000Z'),
    senderType: 'prospect',
    prospectClass: 'question',
    jitterKind: 'prospect',
    dealId: 2531,
    consultantEmail: 'm.dejessey@oseys.fr',
  });
  const e = captured.creates[0];
  assert.equal(e.prospectClass, 'question');
  assert.equal(e.senderType, 'prospect');
  assert.equal(e.jitterKind, 'prospect');
  assert.equal(e.dealId, '2531');
  assert.equal(e.consultantEmail, 'm.dejessey@oseys.fr');
});

// ─── listDueReplies ────────────────────────────────────────────────────────

test('listDueReplies retourne uniquement les entries pending avec scheduledAtIso <= now', async () => {
  const fake = makeFakeClient([
    { partitionKey: 'pending', rowKey: '2026-05-12T09:00:00.000Z_a', scheduledAtIso: '2026-05-12T09:00:00.000Z', status: 'pending' },
    { partitionKey: 'pending', rowKey: '2026-05-12T09:30:00.000Z_b', scheduledAtIso: '2026-05-12T09:30:00.000Z', status: 'pending' },
    { partitionKey: 'pending', rowKey: '2026-05-12T11:00:00.000Z_c', scheduledAtIso: '2026-05-12T11:00:00.000Z', status: 'pending' },
    { partitionKey: 'pending', rowKey: '2026-05-12T09:00:00.000Z_d', scheduledAtIso: '2026-05-12T09:00:00.000Z', status: 'sent' },
  ]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const due = await mod.listDueReplies(new Date('2026-05-12T10:00:00.000Z'));
  assert.equal(due.length, 2);
  assert.deepEqual(due.map((e) => e.rowKey), [
    '2026-05-12T09:00:00.000Z_a',
    '2026-05-12T09:30:00.000Z_b',
  ]);
});

// ─── flushDueReplies ───────────────────────────────────────────────────────

test('flushDueReplies envoie + marque sent les dues', async () => {
  const fake = makeFakeClient([
    { partitionKey: 'pending', rowKey: '2026-05-12T09:00:00.000Z_a', scheduledAtIso: '2026-05-12T09:00:00.000Z', status: 'pending', to: 'a@x.fr', subject: 'A', html: 'a', mailbox: 'david@oseys.fr' },
    { partitionKey: 'pending', rowKey: '2026-05-12T09:30:00.000Z_b', scheduledAtIso: '2026-05-12T09:30:00.000Z', status: 'pending', to: 'b@x.fr', subject: 'B', html: 'b', mailbox: 'david@oseys.fr' },
  ]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const sent = [];
  const stats = await mod.flushDueReplies({
    sendFn: async (e) => { sent.push(e.to); },
    now: new Date('2026-05-12T10:00:00.000Z'),
  });

  assert.deepEqual(stats, { total: 2, sent: 2, failed: 0 });
  assert.deepEqual(sent, ['a@x.fr', 'b@x.fr']);
  assert.equal(captured.updates.length, 2);
  for (const u of captured.updates) {
    assert.equal(u.entity.status, 'sent');
    assert.equal(u.mode, 'Merge');
  }
});

test('flushDueReplies marque failed si sendFn throw', async () => {
  const fake = makeFakeClient([
    { partitionKey: 'pending', rowKey: '2026-05-12T09:00:00.000Z_x', scheduledAtIso: '2026-05-12T09:00:00.000Z', status: 'pending', to: 'x@x.fr', subject: 'X', html: 'x', mailbox: 'david@oseys.fr' },
  ]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const stats = await mod.flushDueReplies({
    sendFn: async () => { throw new Error('SMTP failed'); },
    now: new Date('2026-05-12T10:00:00.000Z'),
  });

  assert.deepEqual(stats, { total: 1, sent: 0, failed: 1 });
  assert.equal(captured.updates.length, 1);
  assert.equal(captured.updates[0].entity.status, 'failed');
  assert.equal(captured.updates[0].entity.errorMessage, 'SMTP failed');
});

test('flushDueReplies throw si sendFn manquant', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  await assert.rejects(() => mod.flushDueReplies({}), /requires sendFn/);
});
