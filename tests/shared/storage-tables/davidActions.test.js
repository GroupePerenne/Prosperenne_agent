'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/davidActions');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;
let captured;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/davidActions');
}

function installClientStub(stub) {
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/davidActions\.js$/.test(parent.filename) && request === './client') {
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

beforeEach(() => {
  captured = { creates: [] };
});

afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

function makeFakeClient(initialEntities = []) {
  const store = [];
  for (const e of initialEntities) store.push(e);
  return {
    createEntity: async (entity) => {
      captured.creates.push(entity);
      store.push(entity);
    },
    listEntities: () => ({
      async *[Symbol.asyncIterator]() {
        for (const e of store.sort((a, b) => a.rowKey.localeCompare(b.rowKey))) yield e;
      },
    }),
    createTable: async () => {},
  };
}

// ─── No-op si pas de client ─────────────────────────────────────────────

test('recordAction retourne null si pas de client', async () => {
  installClientStub({
    getTableClient: () => null,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordAction({
    consultantEmail: 'm.dejessey@oseys.fr',
    type: 'daily_brief_sent',
    summary: 'Brief 8h envoyé',
  });
  assert.equal(result, null);
});

test('listActionsByConsultant retourne tableau vide si pas de client', async () => {
  installClientStub({
    getTableClient: () => null,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.listActionsByConsultant('m.dejessey@oseys.fr');
  assert.deepEqual(result, []);
});

// ─── Validation entrée ─────────────────────────────────────────────────

test('recordAction retourne null si consultantEmail absent', async () => {
  installClientStub({
    getTableClient: () => makeFakeClient(),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordAction({ type: 'daily_brief_sent' });
  assert.equal(result, null);
});

test('recordAction retourne null si type absent', async () => {
  installClientStub({
    getTableClient: () => makeFakeClient(),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordAction({ consultantEmail: 'm@x.fr' });
  assert.equal(result, null);
});

// ─── Création row ───────────────────────────────────────────────────────

test('recordAction crée une row avec PK=email, type, summary, metadata sérialisée', async () => {
  installClientStub({
    getTableClient: () => makeFakeClient(),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordAction({
    consultantEmail: 'M.DEJESSEY@oseys.fr',
    type: 'reply_classified',
    summary: 'Réponse Marie Dupont classifiée positive',
    metadata: { class: 'positive', confidence: 0.92 },
    at: '2026-05-04T10:00:00+02:00',
  });
  assert.equal(result.partitionKey, 'm.dejessey@oseys.fr');
  assert.equal(result.type, 'reply_classified');
  assert.equal(result.summary, 'Réponse Marie Dupont classifiée positive');
  assert.equal(result.actorAgent, 'david');
  assert.equal(result.knownType, true);
  assert.equal(result.at, '2026-05-04T10:00:00+02:00');
  const parsed = JSON.parse(result.metadata);
  assert.equal(parsed.class, 'positive');
  assert.equal(parsed.confidence, 0.92);
});

test('recordAction marque knownType=false sur type inconnu mais l\'enregistre quand même', async () => {
  installClientStub({
    getTableClient: () => makeFakeClient(),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordAction({
    consultantEmail: 'm@oseys.fr',
    type: 'custom_event_x',
    summary: 'Test',
  });
  assert.equal(result.type, 'custom_event_x');
  assert.equal(result.knownType, false);
});

test('rowKey antichronologique : action plus récente vient en premier au listEntities', async () => {
  installClientStub({
    getTableClient: () => makeFakeClient(),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  // 2 actions très espacées dans le temps
  const r1 = await mod.recordAction({
    consultantEmail: 'm@x.fr',
    type: 'daily_brief_sent',
    summary: 'ancien',
    at: '2026-01-01T08:00:00+02:00',
  });
  const r2 = await mod.recordAction({
    consultantEmail: 'm@x.fr',
    type: 'daily_brief_sent',
    summary: 'récent',
    at: '2026-05-04T08:00:00+02:00',
  });
  // RowKey du récent est lexicographiquement plus petit (timestamp inversé)
  assert.equal(r2.rowKey < r1.rowKey, true);
});

test('listActionsByConsultant désérialise metadata JSON et serialize les rows', async () => {
  const initial = [
    {
      partitionKey: 'm.dejessey@oseys.fr',
      rowKey: '0009999999999999:daily_brief_sent:abc123',
      type: 'daily_brief_sent',
      summary: 'Brief 8h',
      metadata: '{"prospects_count":5}',
      actorAgent: 'david',
      at: '2026-05-04T08:00:00+02:00',
      knownType: true,
    },
  ];
  installClientStub({
    getTableClient: () => makeFakeClient(initial),
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const actions = await mod.listActionsByConsultant('m.dejessey@oseys.fr');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'daily_brief_sent');
  assert.equal(actions[0].metadata.prospects_count, 5);
  assert.equal(actions[0].at, '2026-05-04T08:00:00+02:00');
});
