/**
 * Test intégration Bloc 4 — bascule consommateurs vers LeadBase v1.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1, LEADBASE_LESSONS_v1.md §4 invariants
 * I-1, I-2, I-9, I-10.
 *
 * Vérifie que les consommateurs principaux (lead-selector, lead-exhauster,
 * AirWorker, site-finder) ont basculé sur le schéma v1 :
 *   - Reads : filter discriminant schema_version='1.0' propagé.
 *   - Writes LeadContacts : schema_version + leadBaseSchemaVersion posés.
 *   - Writes Couches 2-5 LeadBase : safeMergeCoucheN ou équivalent.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─── lead-selector via LeadBaseAdapter ──────────────────────────────────────

test('Bloc 4 — LeadBaseAdapter buildFilter inclut schema_version', () => {
  const { buildFilter } = require('../../../shared/adapters/leadbase/leadbase-table');
  const f = buildFilter({ nafCodes: ['62.02A'], effectifCodes: ['11'], departements: ['75'] });
  assert.ok(f.includes("schema_version eq '1.0'"),
    'buildFilter doit poser schema_version (I-2 enforced)');
});

// ─── AirWorker enrich-leadbase-continuous ──────────────────────────────────

test('Bloc 4 — enrich-leadbase-continuous iterateLeadBase a un filter v1', () => {
  // Lecture du source pour vérifier statiquement (le module utilise process.exit
  // si ENV manquant, donc on ne peut pas le require directement ici).
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../../scripts/enrich-leadbase-continuous.js'),
    'utf8',
  );
  // On cherche dans iterateLeadBase qu'il y ait un filter avec schema_version
  const iterateMatch = src.match(/async function\* iterateLeadBase\(\)[\s\S]+?listEntities\(\{[\s\S]+?\}\);/);
  assert.ok(iterateMatch, 'iterateLeadBase doit contenir listEntities');
  assert.ok(iterateMatch[0].includes('schema_version'),
    'iterateLeadBase doit filtrer par schema_version (I-2 enforced)');
});

// ─── site-finder writer lookupPartitionKey ─────────────────────────────────

test('Bloc 4 — site-finder lookupPartitionKey filtre v1', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../../shared/site-finder/writers/leadbaseWriter.js'),
    'utf8',
  );
  const lookupMatch = src.match(/async function lookupPartitionKey[\s\S]+?\}\s*\}/);
  assert.ok(lookupMatch);
  assert.ok(lookupMatch[0].includes("schema_version eq '1.0'"),
    'lookupPartitionKey doit filtrer par schema_version (I-2)');
});

// ─── lead-exhauster trace.upsertLeadContact bascule v1 ─────────────────────

test('Bloc 4 — upsertLeadContact pose schema_version=1.0 + leadBaseSchemaVersion', async () => {
  const trace = require('../../../shared/lead-exhauster/trace');
  const writes = [];
  const mockClient = {
    async createTable() { /* noop */ },
    async upsertEntity(entity, mode) { writes.push({ entity, mode }); },
    async updateEntity(entity, mode) { writes.push({ entity, mode }); },
  };
  // Hijack du client interne via le helper test
  if (typeof trace._setClientForTests === 'function') {
    trace._setClientForTests(mockClient);
  }

  const ok = await trace.upsertLeadContact({
    siren: '552081317',
    email: 'jean.dupont@exemple.com',
    confidence: 0.92,
    source: 'dropcontact',
    cost_cents: 25,
    firstName: 'Jean',
    lastName: 'Dupont',
    domain: 'exemple.com',
    naf: '70.22Z',
    tranche: '12',
    beneficiaryId: 'oseys',
  });

  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  const persisted = writes[0].entity;
  assert.equal(persisted.schema_version, '1.0',
    'schema_version=1.0 doit être posé sur write LeadContacts (I-2)');
  assert.equal(persisted.leadBaseSchemaVersion, '1.0',
    'leadBaseSchemaVersion doit être posé pour détection orphelines');
  // Rétrocompat 30j : cost_cents et costCents tous deux présents
  assert.equal(persisted.cost_cents, 25);
  assert.equal(persisted.costCents, 25);

  if (typeof trace._resetForTests === 'function') trace._resetForTests();
});

test('Bloc 4 — upsertLeadContact accepte costCents (entry v1) en input', async () => {
  const trace = require('../../../shared/lead-exhauster/trace');
  const writes = [];
  const mockClient = {
    async createTable() { /* noop */ },
    async upsertEntity(entity) { writes.push(entity); },
    async updateEntity(entity) { writes.push(entity); },
  };
  if (typeof trace._setClientForTests === 'function') {
    trace._setClientForTests(mockClient);
  }

  await trace.upsertLeadContact({
    siren: '552081317',
    email: 'a@b.com',
    confidence: 0.8,
    source: 'internal_patterns',
    costCents: 0, // input v1 camelCase
    firstName: 'Marie',
    lastName: 'Curie',
    beneficiaryId: 'oseys',
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].costCents, 0);
  assert.equal(writes[0].cost_cents, 0); // rétrocompat
  assert.equal(writes[0].schema_version, '1.0');
  assert.equal(writes[0].leadBaseSchemaVersion, '1.0');

  if (typeof trace._resetForTests === 'function') trace._resetForTests();
});
