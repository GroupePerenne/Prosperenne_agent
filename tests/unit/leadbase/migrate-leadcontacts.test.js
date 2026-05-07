/**
 * Tests unitaires migrateLeadContactToV1.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1 §8.3.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateLeadContactToV1,
  needsMigration,
} = require('../../../shared/leadbase/migrate-leadcontacts');

function fixtureLegacyLeadContact(overrides = {}) {
  return {
    partitionKey: '552081317',
    rowKey: 'email_jean_dupont',
    siren: '552081317',
    email: 'jean.dupont@exemple.com',
    confidence: 0.92,
    source: 'dropcontact',
    cost_cents: 25, // legacy snake_case
    firstName: 'Jean',
    lastName: 'Dupont',
    role: 'Président',
    domain: 'exemple.com',
    naf: '70.22Z',
    tranche: '12',
    resolvedAt: '2026-05-01T09:30:00Z',
    beneficiaryId: 'oseys',
    ...overrides,
  };
}

// ─── migrateLeadContactToV1 ────────────────────────────────────────────────

test('migrate — cost_cents → costCents avec valeur préservée', () => {
  const legacy = fixtureLegacyLeadContact();
  const { migrated, changes } = migrateLeadContactToV1(legacy);
  assert.equal(migrated.costCents, 25);
  assert.equal(migrated.cost_cents, 25, 'cost_cents conservé pour rétrocompat 30j');
  assert.ok(changes.includes('renamed_cost_cents_to_costCents'));
});

test('migrate — schema_version absent : ajout 1.0', () => {
  const legacy = fixtureLegacyLeadContact();
  const { migrated, changes } = migrateLeadContactToV1(legacy);
  assert.equal(migrated.schema_version, '1.0');
  assert.ok(changes.includes('added_schema_version'));
});

test('migrate — leadBaseSchemaVersion absent : ajout 1.0', () => {
  const legacy = fixtureLegacyLeadContact();
  const { migrated, changes } = migrateLeadContactToV1(legacy);
  assert.equal(migrated.leadBaseSchemaVersion, '1.0');
  assert.ok(changes.includes('added_leadBaseSchemaVersion'));
});

test('migrate — leadBaseSchemaVersion override par opts', () => {
  const legacy = fixtureLegacyLeadContact();
  const { migrated } = migrateLeadContactToV1(legacy, { leadBaseSchemaVersion: '1.0' });
  assert.equal(migrated.leadBaseSchemaVersion, '1.0');
});

test('migrate — entité déjà v1 : idempotent (aucune modif)', () => {
  const v1 = fixtureLegacyLeadContact({
    costCents: 25,
    schema_version: '1.0',
    leadBaseSchemaVersion: '1.0',
  });
  delete v1.cost_cents;
  const { migrated, changes } = migrateLeadContactToV1(v1);
  assert.deepEqual(migrated, v1);
  assert.deepEqual(changes, []);
});

test('migrate — costCents prioritaire si les deux présents', () => {
  const dual = fixtureLegacyLeadContact({ costCents: 30 });
  const { migrated, changes } = migrateLeadContactToV1(dual);
  assert.equal(migrated.costCents, 30, 'costCents préservé, pas écrasé par cost_cents=25');
  assert.ok(!changes.includes('renamed_cost_cents_to_costCents'));
});

test('migrate — entité null : invalid_input', () => {
  assert.deepEqual(migrateLeadContactToV1(null), { migrated: null, changes: ['invalid_input'] });
  assert.deepEqual(migrateLeadContactToV1(undefined), { migrated: null, changes: ['invalid_input'] });
  assert.deepEqual(migrateLeadContactToV1('string'), { migrated: null, changes: ['invalid_input'] });
});

test('migrate — schema_version drift : signalé sans réécrire', () => {
  const drift = fixtureLegacyLeadContact({ schema_version: '0.9' });
  const { migrated, changes } = migrateLeadContactToV1(drift);
  // Pas réécrit — on respecte la valeur existante (sécurité)
  assert.equal(migrated.schema_version, '0.9');
  assert.ok(changes.some((c) => c.startsWith('schema_version_drift')));
});

// ─── needsMigration ────────────────────────────────────────────────────────

test('needsMigration — entité legacy (cost_cents seul, pas schema_version) : true', () => {
  assert.equal(needsMigration(fixtureLegacyLeadContact()), true);
});

test('needsMigration — entité v1 conforme : false', () => {
  const v1 = {
    ...fixtureLegacyLeadContact(),
    costCents: 25,
    schema_version: '1.0',
    leadBaseSchemaVersion: '1.0',
  };
  delete v1.cost_cents;
  assert.equal(needsMigration(v1), false);
});

test('needsMigration — leadBaseSchemaVersion manquant : true', () => {
  const partial = {
    ...fixtureLegacyLeadContact(),
    costCents: 25,
    schema_version: '1.0',
    // leadBaseSchemaVersion absent
  };
  delete partial.cost_cents;
  assert.equal(needsMigration(partial), true);
});

test('needsMigration — entité null/undefined : false', () => {
  assert.equal(needsMigration(null), false);
  assert.equal(needsMigration(undefined), false);
});
