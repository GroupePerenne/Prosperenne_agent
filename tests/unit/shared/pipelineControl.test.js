'use strict';

/**
 * Tests unitaires — shared/pipelineControl.js (kill-switch FA pipeline David).
 *
 * Couvre :
 *   - Default false si Storage indisponible (graceful degradation)
 *   - Default false si entity absente (404)
 *   - killed=true sans killUntil → true (permanent)
 *   - killed=true + killUntil future → true
 *   - killed=true + killUntil passé → false (kill expiré)
 *   - killed=false → false
 *   - Cache TTL respecté (pas de re-fetch dans la fenêtre)
 *   - Cache TTL expiré → re-fetch
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPipelineKilled,
  _resetForTests,
  _setClientForTests,
} = require('../../../shared/pipelineControl');

function mockClient(behavior) {
  let calls = 0;
  return {
    calls: () => calls,
    getEntity: async (pk, rk) => {
      calls++;
      assert.equal(pk, 'control', 'PK doit être "control"');
      assert.equal(rk, 'kill-pipeline', 'RK doit être "kill-pipeline"');
      return behavior();
    },
  };
}

test.beforeEach(() => {
  _resetForTests();
});

test('isPipelineKilled — Storage indisponible (pas de client) → false', async () => {
  // Pas de _setClientForTests → getClient() retourne null car AzureWebJobsStorage
  // n'est probablement pas posé dans l'env de test. On force le reset.
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const killed = await isPipelineKilled({ cacheTtlMs: 0 });
    assert.equal(killed, false, 'pas de Storage = pipeline vivant par défaut');
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('isPipelineKilled — entity 404 → false', async () => {
  const client = mockClient(() => {
    const err = new Error('ResourceNotFound');
    err.statusCode = 404;
    throw err;
  });
  _setClientForTests(client);
  const killed = await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(killed, false);
  assert.equal(client.calls(), 1);
});

test('isPipelineKilled — killed=true sans killUntil → true (permanent)', async () => {
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: true,
    reason: 'incident manuel Paul',
  }));
  _setClientForTests(client);
  const killed = await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(killed, true);
});

test('isPipelineKilled — killed=true + killUntil future → true', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: true,
    killUntil: future,
  }));
  _setClientForTests(client);
  const killed = await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(killed, true);
});

test('isPipelineKilled — killed=true + killUntil passé → false (kill expiré)', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: true,
    killUntil: past,
  }));
  _setClientForTests(client);
  const killed = await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(killed, false);
});

test('isPipelineKilled — killed=false → false', async () => {
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: false,
  }));
  _setClientForTests(client);
  const killed = await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(killed, false);
});

test('isPipelineKilled — cache TTL respecté (2 appels en <5s → 1 fetch Storage)', async () => {
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: true,
  }));
  _setClientForTests(client);
  await isPipelineKilled(); // fetch
  await isPipelineKilled(); // cache hit
  assert.equal(client.calls(), 1, '2ème appel doit utiliser le cache');
});

test('isPipelineKilled — cache TTL=0 → re-fetch à chaque appel', async () => {
  const client = mockClient(() => ({
    partitionKey: 'control',
    rowKey: 'kill-pipeline',
    killed: true,
  }));
  _setClientForTests(client);
  await isPipelineKilled({ cacheTtlMs: 0 });
  await isPipelineKilled({ cacheTtlMs: 0 });
  assert.equal(client.calls(), 2);
});
