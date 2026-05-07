/**
 * Test intégration I-2 — Discrimination origine obligatoire.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-2.
 * Helper : shared/leadbase/safe-read.js
 *
 * Vérifie qu'un filter OData passé au reader contient au moins un
 * discriminant (schema_version ou sireneRunId), et que safeListLeadBaseEntities
 * refuse de lire sans discriminant.
 *
 * Cas d'origine : 351 emails comptés sur PK=75 mais sur du legacy hors-cible
 * non discriminé (constat 7 mai matin).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DISCRIMINANTS,
  assertDiscriminantInFilter,
  composeDiscriminantFilter,
  safeListLeadBaseEntities,
} = require('../../../shared/leadbase/safe-read');

const { SCHEMA_VERSION_V1 } = require('../../../shared/leadbase/schema-v1');

// ─── assertDiscriminantInFilter ────────────────────────────────────────────

test('I-2 — filter avec schema_version accepté', () => {
  const r = assertDiscriminantInFilter("schema_version eq '1.0'");
  assert.equal(r.ok, true);
});

test('I-2 — filter avec sireneRunId accepté', () => {
  const r = assertDiscriminantInFilter("sireneRunId eq 'sirene-1778083858456-dc261214'");
  assert.equal(r.ok, true);
});

test('I-2 — filter combiné AND avec discriminant accepté', () => {
  const r = assertDiscriminantInFilter("schema_version eq '1.0' and PartitionKey eq '75' and trancheEffectif eq '12'");
  assert.equal(r.ok, true);
});

test('I-2 — filter sans discriminant rejeté', () => {
  const r = assertDiscriminantInFilter("PartitionKey eq '75'");
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('no_discriminant_found'));
});

test('I-2 — filter vide rejeté', () => {
  for (const f of ['', null, undefined, '   ', 0]) {
    const r = assertDiscriminantInFilter(f);
    assert.equal(r.ok, false);
    assert.ok(r.reason.includes('filter_empty_or_missing'));
  }
});

test('I-2 — DISCRIMINANTS exporte les deux options canoniques', () => {
  assert.deepEqual([...DISCRIMINANTS], ['schema_version', 'sireneRunId']);
});

// ─── composeDiscriminantFilter ─────────────────────────────────────────────

test('I-2 — composeDiscriminantFilter pose schema_version par défaut', () => {
  const f = composeDiscriminantFilter();
  assert.ok(f.includes(`schema_version eq '${SCHEMA_VERSION_V1}'`));
  const r = assertDiscriminantInFilter(f);
  assert.equal(r.ok, true);
});

test('I-2 — composeDiscriminantFilter accepte filtres additionnels', () => {
  const f = composeDiscriminantFilter({ partitionKey: '75', trancheEffectif: '12', codeNaf: '70.22Z' });
  assert.ok(f.includes("schema_version eq '1.0'"));
  assert.ok(f.includes("PartitionKey eq '75'"));
  assert.ok(f.includes("trancheEffectif eq '12'"));
  assert.ok(f.includes("codeNaf eq '70.22Z'"));
});

// ─── safeListLeadBaseEntities ──────────────────────────────────────────────

function makeMockClient(entities = []) {
  return {
    _entities: entities,
    _lastQuery: null,
    listEntities(queryOptions) {
      this._lastQuery = queryOptions;
      const arr = entities;
      return (async function* () {
        for (const e of arr) yield e;
      })();
    },
  };
}

test('I-2 — safeListLeadBaseEntities refuse de scanner sans filter', async () => {
  const client = makeMockClient([{ partitionKey: '75', rowKey: '552081317' }]);
  await assert.rejects(async () => {
    const iter = safeListLeadBaseEntities(client); // pas de queryOptions
    for await (const _e of iter) {
      // ne devrait pas atteindre
    }
  }, /I2_violation/);
});

test('I-2 — safeListLeadBaseEntities refuse filter sans discriminant', async () => {
  const client = makeMockClient([{ partitionKey: '75', rowKey: '552081317' }]);
  await assert.rejects(async () => {
    const iter = safeListLeadBaseEntities(client, {
      queryOptions: { filter: "PartitionKey eq '75'" },
    });
    for await (const _e of iter) { /* */ }
  }, /I2_violation/);
});

test('I-2 — safeListLeadBaseEntities accepte filter avec discriminant', async () => {
  const entities = [
    { partitionKey: '75', rowKey: '552081317', schema_version: '1.0' },
    { partitionKey: '75', rowKey: '999999998', schema_version: '1.0' },
  ];
  const client = makeMockClient(entities);
  const collected = [];
  const filter = composeDiscriminantFilter({ partitionKey: '75' });
  const iter = safeListLeadBaseEntities(client, { queryOptions: { filter } });
  for await (const e of iter) collected.push(e);
  assert.equal(collected.length, 2);
});

test('I-2 — bypass allowEmptyFilter = audit complet legacy autorisé', async () => {
  // Bypass explicite (ex. script audit-leadbase-integrity qui scanne tout).
  const entities = [{ partitionKey: '75', rowKey: '552081317' }];
  const client = makeMockClient(entities);
  const collected = [];
  const iter = safeListLeadBaseEntities(client, {}, { allowEmptyFilter: true });
  for await (const e of iter) collected.push(e);
  assert.equal(collected.length, 1);
});

test('I-2 — filter accessible aussi en top-level (pas que dans queryOptions)', async () => {
  const entities = [{ partitionKey: '75', rowKey: '552081317', schema_version: '1.0' }];
  const client = makeMockClient(entities);
  const collected = [];
  const iter = safeListLeadBaseEntities(client, { filter: "schema_version eq '1.0'" });
  for await (const e of iter) collected.push(e);
  assert.equal(collected.length, 1);
});
