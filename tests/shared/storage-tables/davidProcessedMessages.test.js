'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/davidProcessedMessages');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;
let captured;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/davidProcessedMessages');
}

function installClientStub(stub) {
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/davidProcessedMessages\.js$/.test(parent.filename) && request === './client') {
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
  const store = new Map();
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
      store.set(entity.rowKey, entity);
      captured.creates.push(entity);
    },
    getEntity: async (pk, rk) => {
      const e = store.get(rk);
      if (!e) {
        const err = new Error('NotFound');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
  };
}

beforeEach(() => {
  captured = { creates: [] };
});

afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

// ─── sanitizeMessageId ─────────────────────────────────────────────────────

test('sanitizeMessageId remplace / \\ # ? par _', () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const { sanitizeMessageId } = loadFreshTarget();
  assert.equal(sanitizeMessageId('a/b\\c#d?e'), 'a_b_c_d_e');
});

test('sanitizeMessageId conserve les IDs Graph ordinaires', () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const { sanitizeMessageId } = loadFreshTarget();
  const id = 'AAMkAGNiYTQ5ZGVkLTI5ZWMtNDgxMC0=';
  assert.equal(sanitizeMessageId(id), id);
});

test('sanitizeMessageId tronque à 1024 chars', () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const { sanitizeMessageId } = loadFreshTarget();
  const long = 'a'.repeat(2000);
  assert.equal(sanitizeMessageId(long).length, 1024);
});

// ─── markProcessed ─────────────────────────────────────────────────────────

test('markProcessed retourne ok=false si messageId vide', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const r = await mod.markProcessed({});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_message_id');
});

test('markProcessed retourne fallback si pas de storage', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const r = await mod.markProcessed({ messageId: 'AAA' });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyProcessed, false);
  assert.equal(r.reason, 'no_storage_fallback');
});

test('markProcessed première fois retourne alreadyProcessed=false', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const r = await mod.markProcessed({
    messageId: 'msg-1',
    mailbox: 'david@oseys.fr',
    classe: 'consultant',
    action: 'replied',
  });
  assert.equal(r.alreadyProcessed, false);
  assert.equal(r.ok, true);
  assert.equal(captured.creates.length, 1);
  assert.equal(captured.creates[0].rowKey, 'msg-1');
  assert.equal(captured.creates[0].partitionKey, 'msg');
  assert.equal(captured.creates[0].classe, 'consultant');
});

test('markProcessed seconde fois sur même messageId retourne alreadyProcessed=true', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.markProcessed({ messageId: 'dup-1', mailbox: 'david@oseys.fr' });
  const r2 = await mod.markProcessed({ messageId: 'dup-1', mailbox: 'david@oseys.fr' });
  assert.equal(r2.alreadyProcessed, true);
  assert.equal(r2.ok, true);
  assert.equal(captured.creates.length, 1); // une seule création
});

test('markProcessed sanitize les messageId avec / \\ #', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.markProcessed({ messageId: 'a/b\\c#d', mailbox: 'david@oseys.fr' });
  assert.equal(captured.creates[0].rowKey, 'a_b_c_d');
});

// ─── isProcessed ───────────────────────────────────────────────────────────

test('isProcessed false sans storage', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  assert.equal(await mod.isProcessed('any'), false);
});

test('isProcessed true après markProcessed', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.markProcessed({ messageId: 'check-1', mailbox: 'david@oseys.fr' });
  assert.equal(await mod.isProcessed('check-1'), true);
  assert.equal(await mod.isProcessed('not-there'), false);
});
