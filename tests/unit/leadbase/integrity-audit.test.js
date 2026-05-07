/**
 * Tests unitaires sur shared/leadbase/integrity-audit.js
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.4.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VIOLATION_CATEGORIES,
  auditLeadBaseEntity,
  aggregateAudit,
  shouldAlert,
} = require('../../../shared/leadbase/integrity-audit');

function fixtureValid(overrides = {}) {
  return {
    partitionKey: '75',
    rowKey: '552081317',
    siren: '552081317',
    nom: 'EXEMPLE SAS',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    codePostal: '75002',
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-1778083858456-dc261214',
    schema_version: '1.0',
    ...overrides,
  };
}

// ─── auditLeadBaseEntity ───────────────────────────────────────────────────

test('audit — entrée valide : 0 violation', () => {
  const v = auditLeadBaseEntity(fixtureValid());
  assert.deepEqual(v, []);
});

test('audit — entité null : MISSING_SCHEMA_VERSION', () => {
  assert.deepEqual(auditLeadBaseEntity(null), [VIOLATION_CATEGORIES.MISSING_SCHEMA_VERSION]);
  assert.deepEqual(auditLeadBaseEntity(undefined), [VIOLATION_CATEGORIES.MISSING_SCHEMA_VERSION]);
});

test('audit — schema_version absent', () => {
  const e = fixtureValid();
  delete e.schema_version;
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.MISSING_SCHEMA_VERSION));
});

test('audit — schema_version drift v1', () => {
  const e = fixtureValid({ schema_version: '0.9' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.SCHEMA_VERSION_DRIFT));
});

test('audit — PK invalide', () => {
  const e = fixtureValid({ partitionKey: '99' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.INVALID_PK));
});

test('audit — RK invalide', () => {
  const e = fixtureValid({ rowKey: 'ABC' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.INVALID_RK));
});

test('audit — tranche invalide', () => {
  const e = fixtureValid({ trancheEffectif: 'XX' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.INVALID_TRANCHE));
});

test('audit — NAF invalide', () => {
  const e = fixtureValid({ codeNaf: 'WRONG' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.INVALID_NAF));
});

test('audit — siteWeb peuplé sans siteWebSource', () => {
  const e = fixtureValid({ siteWeb: 'https://exemple.com' });
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.SITE_WEB_NO_SOURCE));
});

test('audit — siteWeb avec siteWebSource : pas de violation siteWeb', () => {
  const e = fixtureValid({ siteWeb: 'https://exemple.com', siteWebSource: 'ddg_search' });
  const v = auditLeadBaseEntity(e);
  assert.ok(!v.includes(VIOLATION_CATEGORIES.SITE_WEB_NO_SOURCE));
});

test('audit — Couche 2 peuplée sans Couche 1 conforme : COUCHE_N_WITHOUT_COUCHE_1', () => {
  const e = fixtureValid({ dirigeants: '[]' });
  delete e.codeNaf; // Couche 1 cassée
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.COUCHE_N_WITHOUT_COUCHE_1));
});

test('audit — dirigeants peuplé sans rneCheckedAt : RNE_NO_AUDIT_AT', () => {
  const e = fixtureValid({ dirigeants: '[]' });
  // pas de rneCheckedAt
  const v = auditLeadBaseEntity(e);
  assert.ok(v.includes(VIOLATION_CATEGORIES.RNE_NO_AUDIT_AT));
});

test('audit — dirigeants + rneCheckedAt : pas de violation RNE_NO_AUDIT_AT', () => {
  const e = fixtureValid({ dirigeants: '[]', rneCheckedAt: '2026-05-07T00:00:00Z' });
  const v = auditLeadBaseEntity(e);
  assert.ok(!v.includes(VIOLATION_CATEGORIES.RNE_NO_AUDIT_AT));
});

// ─── aggregateAudit ────────────────────────────────────────────────────────

test('aggregateAudit — 100 valides + 5 violations PK = 5 alertes', () => {
  const entities = [];
  for (let i = 0; i < 100; i++) entities.push(fixtureValid({ rowKey: String(i).padStart(9, '0') }));
  for (let i = 0; i < 5; i++) entities.push(fixtureValid({ partitionKey: '99' }));
  const agg = aggregateAudit(entities);
  assert.equal(agg.scanned, 105);
  assert.equal(agg.byCategory[VIOLATION_CATEGORIES.INVALID_PK], 5);
  assert.equal(agg.total, 5);
});

test('aggregateAudit — un même entry peut générer N violations', () => {
  const e = fixtureValid({ partitionKey: '99', rowKey: 'ABC', codeNaf: 'WRONG' });
  const agg = aggregateAudit([e]);
  assert.equal(agg.total, 3);
  assert.equal(agg.byCategory[VIOLATION_CATEGORIES.INVALID_PK], 1);
  assert.equal(agg.byCategory[VIOLATION_CATEGORIES.INVALID_RK], 1);
  assert.equal(agg.byCategory[VIOLATION_CATEGORIES.INVALID_NAF], 1);
});

// ─── shouldAlert ────────────────────────────────────────────────────────────

test('shouldAlert — drift sous seuil : pas d alerte', () => {
  // 10/100k = 0.01% (sous 0.1% par défaut)
  const agg = { total: 10, scanned: 100_000, byCategory: { invalid_pk: 10 } };
  const r = shouldAlert(agg);
  assert.equal(r.alert, false);
  assert.ok(r.driftPercent < 0.1);
});

test('shouldAlert — drift au-dessus seuil : alerte', () => {
  // 200/100k = 0.2% (au-dessus 0.1%)
  const agg = { total: 200, scanned: 100_000, byCategory: { invalid_pk: 200 } };
  const r = shouldAlert(agg);
  assert.equal(r.alert, true);
  assert.ok(r.reasons.some((x) => x.startsWith('drift_above_threshold')));
});

test('shouldAlert — I-1 violation présente : alerte immédiate', () => {
  const agg = {
    total: 1, scanned: 100_000,
    byCategory: { [VIOLATION_CATEGORIES.COUCHE_N_WITHOUT_COUCHE_1]: 1 },
  };
  const r = shouldAlert(agg);
  assert.equal(r.alert, true);
  assert.ok(r.reasons.includes('i1_violation_present'));
});

test('shouldAlert — schema drift : alerte', () => {
  const agg = {
    total: 1, scanned: 100_000,
    byCategory: { [VIOLATION_CATEGORIES.SCHEMA_VERSION_DRIFT]: 1 },
  };
  const r = shouldAlert(agg);
  assert.equal(r.alert, true);
  assert.ok(r.reasons.includes('schema_drift_detected'));
});

test('shouldAlert — scan vide : pas d alerte', () => {
  const r = shouldAlert({ total: 0, scanned: 0, byCategory: {} });
  assert.equal(r.alert, false);
  assert.deepEqual(r.reasons, ['no_scan']);
});

test('shouldAlert — seuil custom respecté', () => {
  const agg = { total: 50, scanned: 100_000, byCategory: { invalid_pk: 50 } };
  // 0.05% sous 0.1% par défaut
  assert.equal(shouldAlert(agg, 0.1).alert, false);
  // 0.05% au-dessus 0.01%
  assert.equal(shouldAlert(agg, 0.01).alert, true);
});
