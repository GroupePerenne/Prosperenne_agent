'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/doublonsAlerted');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;
let captured;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/doublonsAlerted');
}

function installClientStub(stub) {
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/doublonsAlerted\.js$/.test(parent.filename) && request === './client') {
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
        const err = new Error('Conflict');
        err.statusCode = 409;
        throw err;
      }
      store.set(entity.rowKey, { ...entity });
      captured.creates.push(entity);
    },
    updateEntity: async (entity, mode) => {
      const existing = store.get(entity.rowKey);
      if (!existing) {
        const err = new Error('NotFound');
        err.statusCode = 404;
        throw err;
      }
      store.set(entity.rowKey, { ...existing, ...entity });
      captured.updates.push({ entity, mode });
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

beforeEach(() => { captured = { creates: [], updates: [] }; });
afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

// ─── Fallbacks ─────────────────────────────────────────────────────────────

test('checkAndMarkAlerted retourne shouldAlert=false si groupHash manquant', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const r = await mod.checkAndMarkAlerted({ count: 2, severity: 'ALERT' });
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'no_group_hash');
});

test('checkAndMarkAlerted alerte par sécurité si pas de storage', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const r = await mod.checkAndMarkAlerted({ groupHash: 'abc', count: 5, severity: 'ALERT' });
  assert.equal(r.shouldAlert, true);
  assert.equal(r.reason, 'no_storage_fallback');
});

// ─── Première alerte ───────────────────────────────────────────────────────

test('checkAndMarkAlerted première fois alerte + crée entrée', async () => {
  const fake = makeFakeClient();
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  const r = await mod.checkAndMarkAlerted({
    groupHash: 'h1', count: 3, severity: 'ALERT',
    mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', normalizedSubject: 'ton point quotidien',
  });
  assert.equal(r.shouldAlert, true);
  assert.equal(r.reason, 'first_time');
  assert.equal(captured.creates.length, 1);
  assert.equal(captured.creates[0].rowKey, 'h1');
  assert.equal(captured.creates[0].lastCount, 3);
});

// ─── Cooldown ──────────────────────────────────────────────────────────────

test('checkAndMarkAlerted dans cooldown 24h → pas de nouvelle alerte', async () => {
  const fake = makeFakeClient([{
    partitionKey: 'alert', rowKey: 'h1',
    firstAlertedAt: '2026-05-12T08:00:00.000Z',
    lastAlertedAt: '2026-05-12T08:00:00.000Z',
    lastCount: 3,
  }]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  // 1h plus tard, même count → cooldown actif
  const r = await mod.checkAndMarkAlerted({
    groupHash: 'h1', count: 3, severity: 'ALERT',
    now: new Date('2026-05-12T09:00:00.000Z'),
  });
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'within_cooldown');
  assert.equal(captured.updates.length, 0);
});

test('checkAndMarkAlerted cooldown expiré → ré-alerte', async () => {
  const fake = makeFakeClient([{
    partitionKey: 'alert', rowKey: 'h1',
    firstAlertedAt: '2026-05-10T08:00:00.000Z',
    lastAlertedAt: '2026-05-10T08:00:00.000Z',
    lastCount: 3,
  }]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  // 2 jours plus tard → cooldown 24h dépassé
  const r = await mod.checkAndMarkAlerted({
    groupHash: 'h1', count: 3, severity: 'ALERT',
    now: new Date('2026-05-12T08:00:00.000Z'),
  });
  assert.equal(r.shouldAlert, true);
  assert.equal(r.reason, 'cooldown_expired');
  assert.equal(captured.updates.length, 1);
});

test('checkAndMarkAlerted count augmenté → ré-alerte même dans cooldown', async () => {
  const fake = makeFakeClient([{
    partitionKey: 'alert', rowKey: 'h1',
    firstAlertedAt: '2026-05-12T08:00:00.000Z',
    lastAlertedAt: '2026-05-12T08:00:00.000Z',
    lastCount: 3,
  }]);
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  // 1h plus tard mais count est passé de 3 à 5 → ré-alerte
  const r = await mod.checkAndMarkAlerted({
    groupHash: 'h1', count: 5, severity: 'ALERT',
    now: new Date('2026-05-12T09:00:00.000Z'),
  });
  assert.equal(r.shouldAlert, true);
  assert.equal(r.reason, 'count_increased');
});

test('checkAndMarkAlerted race condition 409 → ne ré-alerte pas', async () => {
  const fake = {
    createTable: async () => {},
    getEntity: async () => {
      const e = new Error('NotFound'); e.statusCode = 404; throw e;
    },
    createEntity: async () => {
      const e = new Error('Conflict'); e.statusCode = 409; throw e;
    },
  };
  installClientStub({ getTableClient: () => fake, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const r = await mod.checkAndMarkAlerted({ groupHash: 'h1', count: 2, severity: 'ALERT' });
  assert.equal(r.shouldAlert, false);
  assert.equal(r.reason, 'race_already_created');
});
