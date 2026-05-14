'use strict';

/**
 * Tests charge idempotence BL-52 (plan v3.1 P3 Task #15) — 20 messages
 * parallèles sur même run key doivent donner 1 acquired + 19 idempotent
 * rejects, jamais 2+ acquisitions concurrentes.
 *
 * Mock client atomique simulé : un seul `createEntity` réussit en concurrence,
 * les autres reçoivent 409. Reproduit le comportement Azure Table Storage
 * createEntity (atomique par partition+row).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _setClientForTests, _resetForTests } = require('../../../shared/storage-tables/client');

test('BL-52 charge — 20 messages parallèles même run key → 1 acquired, 19 idempotent', async () => {
  _resetForTests();
  // Mock client atomique : createEntity réussit pour le 1er, throw 409 pour les autres
  let created = false;
  const mockClient = {
    createTable: async () => true,
    createEntity: async (entity) => {
      // Simule l'atomicité Azure Table Storage : si déjà créé → 409
      if (created) {
        const err = new Error('Conflict');
        err.statusCode = 409;
        throw err;
      }
      created = true;
      return true;
    },
    getEntity: async () => ({
      partitionKey: 'run',
      rowKey: 'paul-b1',
      status: 'running',
      startedAt: new Date().toISOString(),
    }),
  };
  _setClientForTests('LeadSelectorRuns', mockClient);

  // Force re-require pour pas cache
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
  const { tryAcquireRun } = require('../../../shared/storage-tables/leadSelectorRuns');

  // 20 promises parallèles
  const promises = Array.from({ length: 20 }, (_, i) =>
    tryAcquireRun({ consultantId: 'paul', briefId: 'b1', jobId: `j${i}` })
  );
  const results = await Promise.all(promises);

  const fresh = results.filter((r) => r.acquired === true && !r.reason).length;
  const idempotent = results.filter((r) => r.acquired === false).length;
  const total = results.length;

  // Exactement 1 acquisition fraîche, 19 idempotent rejects
  assert.equal(fresh, 1, `Expected 1 fresh acquisition, got ${fresh}/${total}`);
  assert.equal(idempotent, 19, `Expected 19 idempotent rejects, got ${idempotent}/${total}`);

  // Cleanup pour ne pas polluer autres tests
  _resetForTests();
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
});

test('BL-52 charge — 50 messages parallèles → idempotence préservée (court-circuit OK)', async () => {
  _resetForTests();
  let created = false;
  const mockClient = {
    createTable: async () => true,
    createEntity: async () => {
      if (created) { const e = new Error('Conflict'); e.statusCode = 409; throw e; }
      created = true;
      return true;
    },
    getEntity: async () => ({
      partitionKey: 'run', rowKey: 'k', status: 'running',
      startedAt: new Date().toISOString(),
    }),
  };
  _setClientForTests('LeadSelectorRuns', mockClient);
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
  const { tryAcquireRun } = require('../../../shared/storage-tables/leadSelectorRuns');

  const promises = Array.from({ length: 50 }, (_, i) =>
    tryAcquireRun({ consultantId: 'mila', briefId: 'b2', jobId: `j${i}` })
  );
  const results = await Promise.all(promises);

  const fresh = results.filter((r) => r.acquired === true && !r.reason).length;
  assert.equal(fresh, 1, `Expected exactly 1 fresh, got ${fresh}`);

  _resetForTests();
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
});

test('BL-52 charge — 20 messages parallèles, run keys DISTINCTES → 20 acquired', async () => {
  _resetForTests();
  // Track creations per rowKey
  const createdKeys = new Set();
  const mockClient = {
    createTable: async () => true,
    createEntity: async (entity) => {
      if (createdKeys.has(entity.rowKey)) {
        const err = new Error('Conflict'); err.statusCode = 409; throw err;
      }
      createdKeys.add(entity.rowKey);
      return true;
    },
    getEntity: async () => ({ status: 'running', startedAt: new Date().toISOString() }),
  };
  _setClientForTests('LeadSelectorRuns', mockClient);
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
  const { tryAcquireRun } = require('../../../shared/storage-tables/leadSelectorRuns');

  // 20 consultantIds distincts → 20 run keys distinctes → toutes doivent passer
  const promises = Array.from({ length: 20 }, (_, i) =>
    tryAcquireRun({ consultantId: `consultant-${i}`, briefId: 'b1', jobId: `j${i}` })
  );
  const results = await Promise.all(promises);
  const fresh = results.filter((r) => r.acquired === true && !r.reason).length;
  assert.equal(fresh, 20, `Expected 20 fresh on distinct keys, got ${fresh}`);

  _resetForTests();
  delete require.cache[require.resolve('../../../shared/storage-tables/leadSelectorRuns')];
});
