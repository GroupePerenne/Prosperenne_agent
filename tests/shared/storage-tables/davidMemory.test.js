'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const TARGET = require.resolve('../../../shared/storage-tables/davidMemory');
const CLIENT_PATH = require.resolve('../../../shared/storage-tables/client');

let originalLoad;

function loadFreshTarget() {
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
  return require('../../../shared/storage-tables/davidMemory');
}

function installClientStub(stub) {
  originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (parent && /storage-tables\/davidMemory\.js$/.test(parent.filename) && request === './client') {
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

afterEach(() => {
  restoreLoader();
  delete require.cache[TARGET];
  delete require.cache[CLIENT_PATH];
});

function makeFakeClient(initialEntities = []) {
  const store = [...initialEntities];
  return {
    createEntity: async (entity) => { store.push(entity); },
    listEntities: (opts) => ({
      async *[Symbol.asyncIterator]() {
        let entities = [...store].sort((a, b) => a.rowKey.localeCompare(b.rowKey));
        const filter = opts && opts.queryOptions && opts.queryOptions.filter;
        if (filter) {
          const match = /PartitionKey eq '([^']+)'/.exec(filter);
          if (match) entities = entities.filter((e) => e.partitionKey === match[1]);
        }
        for (const e of entities) yield e;
      },
    }),
    createTable: async () => {},
    _store: store,
  };
}

// ─── No-op safety ───────────────────────────────────────────────────────────

test('recordMessage retourne null si pas de client', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr',
    direction: 'inbound',
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result, null);
});

test('listMemoryFor retourne tableau vide si pas de client', async () => {
  installClientStub({ getTableClient: () => null, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.listMemoryFor('j.serra@oseys.fr');
  assert.deepEqual(result, []);
});

test('recordMessage retourne null si email manquant', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.recordMessage({ direction: 'inbound', subject: 'x' });
  assert.equal(result, null);
});

test('recordMessage retourne null si direction invalide', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr',
    direction: 'invalid',
    subject: 'x',
  });
  assert.equal(result, null);
});

// ─── Happy path ─────────────────────────────────────────────────────────────

test('recordMessage normalise email + crée PK interlocutor:', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.recordMessage({
    interlocutorEmail: 'J.Serra@Oseys.FR',
    direction: 'inbound',
    mailbox: 'David@OSEYS.fr',
    subject: 'Re: Démarrage pilote',
    body: 'Bonjour David',
    messageId: 'AAMkAGI2',
    sentAt: '2026-05-15T10:30:00Z',
  });
  assert.equal(result.partitionKey, 'interlocutor:j.serra@oseys.fr');
  assert.ok(result.rowKey);
  assert.equal(client._store.length, 1);
  assert.equal(client._store[0].partitionKey, 'interlocutor:j.serra@oseys.fr');
  assert.equal(client._store[0].direction, 'inbound');
  assert.equal(client._store[0].mailbox, 'david@oseys.fr');
  assert.equal(client._store[0].subject, 'Re: Démarrage pilote');
  assert.equal(client._store[0].body, 'Bonjour David');
});

test('recordMessage strip HTML du body', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr',
    direction: 'outbound',
    body: '<html><body><p>Bonjour <b>Johnny</b>,</p><style>.x{}</style><p>Tout va bien ?</p></body></html>',
  });
  assert.equal(client._store[0].body, 'Bonjour Johnny,\nTout va bien ?');
});

test('recordMessage tronque body si > 60KB', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const huge = 'x'.repeat(70000);
  await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr',
    direction: 'inbound',
    body: huge,
  });
  assert.ok(client._store[0].body.length < 61_000);
  assert.match(client._store[0].body, /tronqué/);
});

test('recordMessage stringifie classification JSON', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  await mod.recordMessage({
    interlocutorEmail: 'lead@example.com',
    direction: 'inbound',
    classification: { prospect_class: 'positive', confidence: 0.95 },
  });
  assert.equal(typeof client._store[0].classification, 'string');
  assert.match(client._store[0].classification, /positive/);
});

test('recordMessage best-effort ne throw pas si createEntity fail', async () => {
  const client = {
    createEntity: async () => { throw new Error('Storage 503'); },
    listEntities: () => ({ async *[Symbol.asyncIterator]() {} }),
  };
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  const result = await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr',
    direction: 'inbound',
    body: 'x',
  });
  assert.equal(result, null); // pas de throw
});

// ─── Lecture chronologique ──────────────────────────────────────────────────

test('listMemoryFor retourne dans l\'ordre chronologique ASC', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr', direction: 'outbound',
    subject: 'J0', body: 'envoi 1', sentAt: '2026-05-10T09:00:00Z',
  });
  await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr', direction: 'inbound',
    subject: 'Re J0', body: 'réponse', sentAt: '2026-05-11T14:00:00Z',
  });
  await mod.recordMessage({
    interlocutorEmail: 'j.serra@oseys.fr', direction: 'outbound',
    subject: 'Suite', body: 'envoi 2', sentAt: '2026-05-12T10:00:00Z',
  });

  const memory = await mod.listMemoryFor('j.serra@oseys.fr');
  assert.equal(memory.length, 3);
  assert.equal(memory[0].body, 'envoi 1');
  assert.equal(memory[1].body, 'réponse');
  assert.equal(memory[2].body, 'envoi 2');
});

test('listMemoryFor ne retourne que les messages de l\'interlocuteur demandé', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();

  await mod.recordMessage({ interlocutorEmail: 'j.serra@oseys.fr', direction: 'inbound', body: 'A' });
  await mod.recordMessage({ interlocutorEmail: 'm.dejessey@oseys.fr', direction: 'inbound', body: 'B' });

  const johnny = await mod.listMemoryFor('j.serra@oseys.fr');
  assert.equal(johnny.length, 1);
  assert.equal(johnny[0].body, 'A');
});

test('listMemoryFor parse classification JSON si présente', async () => {
  const client = makeFakeClient();
  installClientStub({ getTableClient: () => client, ensureTable: async () => {} });
  const mod = loadFreshTarget();
  await mod.recordMessage({
    interlocutorEmail: 'lead@example.com', direction: 'inbound',
    classification: { prospect_class: 'positive', confidence: 0.95 },
  });
  const memory = await mod.listMemoryFor('lead@example.com');
  assert.equal(memory[0].classification.prospect_class, 'positive');
});

// ─── Format pour prompt ─────────────────────────────────────────────────────

test('formatMemoryForPrompt retourne chaîne vide pour mémoire vide', () => {
  const mod = require('../../../shared/storage-tables/davidMemory');
  assert.equal(mod.formatMemoryForPrompt([]), '');
  assert.equal(mod.formatMemoryForPrompt(null), '');
});

test('formatMemoryForPrompt produit format chronologique lisible', () => {
  const mod = require('../../../shared/storage-tables/davidMemory');
  const out = mod.formatMemoryForPrompt([
    { direction: 'outbound', mailbox: 'david@oseys.fr', subject: 'Bonjour', body: 'Comment vas-tu ?', sentAt: '2026-05-10T09:00:00Z' },
    { direction: 'inbound', subject: 'Re: Bonjour', body: 'Très bien merci', sentAt: '2026-05-10T14:00:00Z' },
  ]);
  assert.match(out, /ÉCHANGES PRÉCÉDENTS/);
  assert.match(out, /2026-05-10 09:00/);
  assert.match(out, /envoyé par nous/);
  assert.match(out, /reçu de lui/);
  assert.match(out, /Comment vas-tu \?/);
  assert.match(out, /Très bien merci/);
});

// ─── Sécurité PK & stripHtml ────────────────────────────────────────────────

test('stripHtml gère entities + multilignes', () => {
  const mod = require('../../../shared/storage-tables/davidMemory');
  const out = mod.stripHtml('<p>Bonjour&nbsp;David,</p>\n<p>&amp;merci&lt;</p>');
  // </p>\n<p> → \n\n (paragraph separator)
  assert.equal(out, 'Bonjour David,\n\n&merci<');
});
