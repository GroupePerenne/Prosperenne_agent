'use strict';

/**
 * Cascade de résolution de la connection string LeadBase.
 *
 * Sprint 1 Variante A — storage cutover oseysjeannotst → pereneoleadsst.
 * Les tests d'intégration leadSelector court-circuitent cette cascade via
 * un tableClient injecté ; ces tests unitaires ferment la maille en local.
 * Validation runtime réelle = smoke prod côté Paul après merge.
 *
 * Ordre de priorité attendu :
 *   1. opts.connectionString
 *   2. process.env.LEADBASE_STORAGE_CONNECTION_STRING
 *   3. process.env.AzureWebJobsStorage
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LeadBaseAdapter } = require('../../../../shared/adapters/leadbase/leadbase-table');

const ENV_KEYS = ['LEADBASE_STORAGE_CONNECTION_STRING', 'AzureWebJobsStorage'];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

test('cascade priorité 1 — opts.connectionString gagne sur les deux env vars', () => {
  const snap = snapshotEnv();
  try {
    process.env.LEADBASE_STORAGE_CONNECTION_STRING = 'leadbase-cs-should-be-ignored';
    process.env.AzureWebJobsStorage = 'awjs-should-be-ignored';
    const opts = { connectionString: 'DefaultEndpointsProtocol=https;AccountName=test1;sentinel=opts-wins' };
    const adapter = new LeadBaseAdapter(opts);
    assert.equal(adapter._connectionString, opts.connectionString);
  } finally {
    restoreEnv(snap);
  }
});

test('cascade priorité 2 — LEADBASE_STORAGE_CONNECTION_STRING gagne sur AzureWebJobsStorage', () => {
  const snap = snapshotEnv();
  try {
    process.env.LEADBASE_STORAGE_CONNECTION_STRING = 'leadbase-cs-sentinel';
    process.env.AzureWebJobsStorage = 'awjs-sentinel';
    const adapter = new LeadBaseAdapter({});
    assert.equal(adapter._connectionString, 'leadbase-cs-sentinel');
  } finally {
    restoreEnv(snap);
  }
});

test('cascade priorité 3 — fallback AzureWebJobsStorage seul (compat historique)', () => {
  const snap = snapshotEnv();
  try {
    delete process.env.LEADBASE_STORAGE_CONNECTION_STRING;
    process.env.AzureWebJobsStorage = 'awjs-only';
    const adapter = new LeadBaseAdapter({});
    assert.equal(adapter._connectionString, 'awjs-only');
  } finally {
    restoreEnv(snap);
  }
});
