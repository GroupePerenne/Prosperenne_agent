'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/consultantOnboarding');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;
let stubClient;
let captured;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/consultantOnboarding');
}

function installClientStub(stub) {
  stubClient = stub;
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/consultantOnboarding\.js$/.test(parent.filename) && request === './client') {
      return stubClient;
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
  captured = { upserts: [], gets: [], created: [] };
});

afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

// ─── No-op si AzureWebJobsStorage absent ─────────────────────────────────

test('recordOnboardingSent retourne null si pas de client (AzureWebJobsStorage absent)', async () => {
  installClientStub({
    getTableClient: () => null,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordOnboardingSent({
    consultantEmail: 'm.dejessey@oseys.fr',
    consultantName: 'Morgane DE JESSEY',
  });
  assert.equal(result, null);
});

test('recordOnboardingCompleted retourne null si pas de client', async () => {
  installClientStub({
    getTableClient: () => null,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordOnboardingCompleted({
    consultantEmail: 'm.dejessey@oseys.fr',
    briefId: 'brief_123',
    responses: { foo: 'bar' },
  });
  assert.equal(result, null);
});

test('listAllConsultants retourne tableau vide si pas de client', async () => {
  installClientStub({
    getTableClient: () => null,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.listAllConsultants();
  assert.deepEqual(result, []);
});

// ─── Comportement avec un client stubbé ─────────────────────────────────

function makeFakeClient(initialEntities = []) {
  const store = new Map();
  for (const e of initialEntities) {
    store.set(`${e.partitionKey}|${e.rowKey}`, e);
  }
  return {
    upsertEntity: async (entity) => {
      captured.upserts.push(entity);
      store.set(`${entity.partitionKey}|${entity.rowKey}`, entity);
    },
    getEntity: async (pk, rk) => {
      captured.gets.push({ pk, rk });
      const e = store.get(`${pk}|${rk}`);
      if (!e) {
        const err = new Error('ResourceNotFound');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    listEntities: () => {
      return {
        async *[Symbol.asyncIterator]() {
          for (const v of store.values()) yield v;
        },
      };
    },
    createTable: async () => {},
  };
}

test('recordOnboardingSent crée une row neuve avec status=sent', async () => {
  const fake = makeFakeClient();
  installClientStub({
    getTableClient: () => fake,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordOnboardingSent({
    consultantEmail: 'M.DEJESSEY@oseys.fr',
    consultantName: 'Morgane DE JESSEY',
    sentAt: '2026-05-01T18:11:00+02:00',
  });
  assert.equal(result.partitionKey, 'consultant');
  assert.equal(result.rowKey, 'm.dejessey@oseys.fr');
  assert.equal(result.status, 'sent');
  assert.equal(result.sentAt, '2026-05-01T18:11:00+02:00');
  assert.equal(result.consultantName, 'Morgane DE JESSEY');
  assert.equal(captured.upserts.length, 1);
});

test('recordOnboardingCompleted upsert avec status=completed et merge sentAt existant', async () => {
  const fake = makeFakeClient([
    {
      partitionKey: 'consultant',
      rowKey: 'm.dejessey@oseys.fr',
      consultantEmail: 'm.dejessey@oseys.fr',
      consultantName: 'Morgane DE JESSEY',
      status: 'sent',
      sentAt: '2026-05-01T18:11:00+02:00',
      completedAt: '',
      briefId: '',
      responses: '',
    },
  ]);
  installClientStub({
    getTableClient: () => fake,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordOnboardingCompleted({
    consultantEmail: 'm.dejessey@oseys.fr',
    briefId: 'brief_456',
    responses: { display_name: 'Morgane DE JESSEY', favorite_sectors: ['BTP'] },
    completedAt: '2026-05-04T09:00:00+02:00',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.sentAt, '2026-05-01T18:11:00+02:00');
  assert.equal(result.completedAt, '2026-05-04T09:00:00+02:00');
  assert.equal(result.briefId, 'brief_456');
  const parsed = JSON.parse(result.responses);
  assert.deepEqual(parsed.favorite_sectors, ['BTP']);
});

test('recordOnboardingSent ne dégrade pas un status=completed existant', async () => {
  const fake = makeFakeClient([
    {
      partitionKey: 'consultant',
      rowKey: 'j.serra@oseys.fr',
      consultantEmail: 'j.serra@oseys.fr',
      status: 'completed',
      sentAt: '2026-05-01T18:11:00+02:00',
      completedAt: '2026-05-04T10:00:00+02:00',
      briefId: 'brief_789',
      responses: '{"foo":"bar"}',
    },
  ]);
  installClientStub({
    getTableClient: () => fake,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.recordOnboardingSent({
    consultantEmail: 'j.serra@oseys.fr',
    consultantName: 'Johnny SERRA',
    sentAt: '2026-06-01T10:00:00+02:00',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.completedAt, '2026-05-04T10:00:00+02:00');
  assert.equal(result.briefId, 'brief_789');
  assert.equal(result.sentAt, '2026-06-01T10:00:00+02:00'); // sentAt mis à jour mais status préservé
});

test('listAllConsultants retourne et désérialise les responses JSON', async () => {
  const fake = makeFakeClient([
    {
      partitionKey: 'consultant',
      rowKey: 'm.dejessey@oseys.fr',
      consultantEmail: 'm.dejessey@oseys.fr',
      consultantName: 'Morgane DE JESSEY',
      status: 'completed',
      sentAt: '2026-05-01T18:11:00+02:00',
      completedAt: '2026-05-04T09:00:00+02:00',
      briefId: 'brief_456',
      responses: '{"display_name":"Morgane DE JESSEY","favorite_sectors":["BTP"]}',
    },
    {
      partitionKey: 'consultant',
      rowKey: 'j.serra@oseys.fr',
      consultantEmail: 'j.serra@oseys.fr',
      consultantName: 'Johnny SERRA',
      status: 'sent',
      sentAt: '2026-05-01T18:11:00+02:00',
      completedAt: '',
      briefId: '',
      responses: '',
    },
  ]);
  installClientStub({
    getTableClient: () => fake,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.listAllConsultants();
  assert.equal(result.length, 2);
  const morgane = result.find((c) => c.consultantEmail === 'm.dejessey@oseys.fr');
  assert.equal(morgane.status, 'completed');
  assert.equal(morgane.responses.favorite_sectors[0], 'BTP');
  const johnny = result.find((c) => c.consultantEmail === 'j.serra@oseys.fr');
  assert.equal(johnny.status, 'sent');
  assert.equal(johnny.responses, null);
});

test('getConsultant 404 retourne null', async () => {
  const fake = makeFakeClient();
  installClientStub({
    getTableClient: () => fake,
    ensureTable: async () => {},
  });
  const mod = loadFreshTarget();
  const result = await mod.getConsultant('inconnu@oseys.fr');
  assert.equal(result, null);
});
