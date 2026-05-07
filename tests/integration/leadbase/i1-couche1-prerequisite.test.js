/**
 * Test intégration I-1 — Contrat de couches strict.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-1.
 * Schéma : LEADBASE_SCHEMA_v1.md §10.3.
 * Helper : shared/leadbase/safe-write.js safeMergeCoucheN.
 *
 * Vérifie qu'un writer Couches 2-5 ne peut pas écrire si la Couche 1
 * de l'entrée cible n'est pas conforme. Violation = pas de write +
 * audit dans LeadBaseIntegrityViolations.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { safeMergeCoucheN } = require('../../../shared/leadbase/safe-write');

// ─── Mock TableClient ──────────────────────────────────────────────────────

function makeMockClient(entities = {}) {
  const writes = [];
  return {
    _entities: entities,
    _writes: writes,
    async getEntity(pk, rk) {
      const key = `${pk}:${rk}`;
      const e = entities[key];
      if (!e) {
        const err = new Error(`Entity not found: ${key}`);
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    async updateEntity(entity, mode) {
      writes.push({ entity, mode });
    },
    async createEntity(entity) {
      writes.push({ entity, mode: 'Create' });
    },
  };
}

function makeFixtureCouche1Conforme(siren = '552081317') {
  return {
    partitionKey: '75',
    rowKey: siren,
    siren,
    nom: 'EXEMPLE SAS',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    codePostal: '75002',
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-1778083858456-dc261214',
    schema_version: '1.0',
  };
}

// Logger stub minimal pour capturer les warnings.
function makeLogger() {
  const calls = [];
  return {
    _calls: calls,
    warn: (msg) => calls.push({ level: 'warn', msg }),
    info: (msg) => calls.push({ level: 'info', msg }),
    error: (msg) => calls.push({ level: 'error', msg }),
  };
}

// ─── I-1 contrat couches : entrée absente ──────────────────────────────────

test('I-1 — write Couche 2 sur entrée absente : refus + audit', async () => {
  const leadBaseClient = makeMockClient(); // vide
  const violationsClient = makeMockClient();
  const logger = makeLogger();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      dirigeants: '[{"prenom":"Jean","nom":"Dupont","role":"PRESIDENT"}]',
      rneCheckedAt: '2026-05-07T10:00:00Z',
    },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i1_entry_absent');
  assert.equal(leadBaseClient._writes.length, 0, 'aucun write LeadBase');
  assert.equal(violationsClient._writes.length, 1, 'audit violation enregistré');
  assert.equal(violationsClient._writes[0].entity.reason, 'i1_entry_absent');
  assert.ok(logger._calls.some((c) => c.level === 'warn' && c.msg.includes('i1') === false && c.msg.includes('I-1')));
});

// ─── I-1 contrat couches : Couche 1 incomplète ─────────────────────────────

test('I-1 — write Couche 2 sur entrée Couche 1 incomplète (pas de schema_version) : refus', async () => {
  const incomplete = makeFixtureCouche1Conforme();
  delete incomplete.schema_version;

  const leadBaseClient = makeMockClient({ '75:552081317': incomplete });
  const violationsClient = makeMockClient();
  const logger = makeLogger();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      dirigeants: '[]',
      rneCheckedAt: '2026-05-07T10:00:00Z',
    },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
    logger,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i1_schema_version_missing');
  assert.equal(leadBaseClient._writes.length, 0);
  assert.equal(violationsClient._writes.length, 1);
});

test('I-1 — write Couche 2 sur entrée codeNaf invalide : refus', async () => {
  const bad = makeFixtureCouche1Conforme();
  bad.codeNaf = 'XX';

  const leadBaseClient = makeMockClient({ '75:552081317': bad });
  const violationsClient = makeMockClient();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'siteFinder',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      siteWeb: 'https://exemple.com',
      siteWebSource: 'ddg_search',
      siteWebLastCheckedAt: '2026-05-07T10:00:00Z',
    },
    ownedColumns: ['siteWeb', 'siteWebSource', 'siteWebLastCheckedAt'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i1_codeNaf_missing_or_invalid');
  assert.equal(leadBaseClient._writes.length, 0);
});

// ─── I-1 contrat couches : entrée conforme → write OK ──────────────────────

test('I-1 — write Couche 2 sur entrée conforme : Merge écrit', async () => {
  const conforme = makeFixtureCouche1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': conforme });
  const violationsClient = makeMockClient();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      dirigeants: '[{"prenom":"Jean","nom":"Dupont","role":"PRESIDENT"}]',
      rneCheckedAt: '2026-05-07T10:00:00Z',
    },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
  });

  assert.equal(result.ok, true);
  assert.equal(leadBaseClient._writes.length, 1);
  assert.equal(leadBaseClient._writes[0].mode, 'Merge');
  assert.equal(leadBaseClient._writes[0].entity.partitionKey, '75');
  assert.equal(leadBaseClient._writes[0].entity.rowKey, '552081317');
  assert.equal(violationsClient._writes.length, 0, 'aucune violation');
});

// ─── I-9 sémantique unique (colonnes owned uniquement) ─────────────────────

test('I-9 — write avec colonne hors couche owned : refus + audit', async () => {
  const conforme = makeFixtureCouche1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': conforme });
  const violationsClient = makeMockClient();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      dirigeants: '[]',
      rneCheckedAt: '2026-05-07T10:00:00Z',
      siteWeb: 'https://exemple.com', // ← colonne hors couche RNE !
    },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.startsWith('i9_foreign_columns'));
  assert.ok(result.reason.includes('siteWeb'));
  assert.equal(leadBaseClient._writes.length, 0);
  assert.equal(violationsClient._writes.length, 1);
});

// ─── I-10 audit *At ───────────────────────────────────────────────────────

test('I-10 — write sans rneCheckedAt : refus + audit', async () => {
  const conforme = makeFixtureCouche1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': conforme });
  const violationsClient = makeMockClient();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      dirigeants: '[{"prenom":"Jean","nom":"Dupont","role":"PRESIDENT"}]',
      // rneCheckedAt manquant
    },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i10_missing_audit_at:rneCheckedAt');
  assert.equal(leadBaseClient._writes.length, 0);
  assert.equal(violationsClient._writes.length, 1);
});

test('I-10 — write siteFinder sans siteWebLastCheckedAt : refus', async () => {
  const conforme = makeFixtureCouche1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': conforme });
  const violationsClient = makeMockClient();

  const result = await safeMergeCoucheN({
    leadBaseClient,
    violationsClient,
    layer: 'siteFinder',
    partitionKey: '75',
    rowKey: '552081317',
    patch: {
      siteWeb: 'https://exemple.com',
      siteWebSource: 'ddg_search',
      // siteWebLastCheckedAt manquant
    },
    ownedColumns: ['siteWeb', 'siteWebSource', 'siteWebLastCheckedAt'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i10_missing_audit_at:siteWebLastCheckedAt');
});

// ─── Layer invalide ────────────────────────────────────────────────────────

test('safeMergeCoucheN — layer invalide rejeté avant tout', async () => {
  const result = await safeMergeCoucheN({
    leadBaseClient: makeMockClient(),
    layer: 'inexistant',
    partitionKey: '75',
    rowKey: '552081317',
    patch: { foo: 'bar' },
    ownedColumns: ['foo'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.startsWith('invalid_layer'));
});

// ─── Recording violation best-effort ───────────────────────────────────────

test('safeMergeCoucheN — violationsClient absent : pas de crash', async () => {
  const leadBaseClient = makeMockClient();
  const result = await safeMergeCoucheN({
    leadBaseClient,
    // violationsClient: undefined
    layer: 'rne',
    partitionKey: '75',
    rowKey: '552081317',
    patch: { dirigeants: '[]', rneCheckedAt: '2026-05-07T10:00:00Z' },
    ownedColumns: ['dirigeants', 'rneCheckedAt'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'i1_entry_absent'); // pas de crash sur recordIntegrityViolation
});
