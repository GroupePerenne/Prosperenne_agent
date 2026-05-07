/**
 * Tests intégration migrate-capital-scrape — extraction + jointure I-1.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1, LEADBASE_LESSONS_v1.md §4 I-1, I-9, I-10.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractScrapedCapital,
  migrateLegacyCapitalToV1,
  pickColumnsIfPresent,
  COUCHE2_RNE_COLUMNS,
  COUCHE3_WEB_COLUMNS,
} = require('../../../shared/leadbase/migrate-capital-scrape');

function fixtureLegacyWithCapital(overrides = {}) {
  return {
    partitionKey: '75',
    rowKey: '552081317',
    siren: '552081317',
    nom: 'EXEMPLE LEGACY',
    // Couche 2 RNE
    dirigeants: '[{"prenom":"Jean","nom":"Dupont","role":"PRESIDENT"}]',
    rne_checked_at: '2026-04-15T10:00:00Z', // legacy snake_case
    // Couche 3 Web
    siteWeb: 'https://exemple.com',
    siteWebSource: 'ddg_search',
    siteWebConfidence: 0.85,
    siteWebLastCheckedAt: '2026-04-20T08:30:00Z',
    siteFinderResult: 'found',
    siteFinderAttempts: 3,
    ...overrides,
  };
}

function fixtureV1Conforme(siren = '552081317') {
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

function makeMockClient(entities = {}) {
  const writes = [];
  return {
    _entities: entities,
    _writes: writes,
    async getEntity(pk, rk) {
      const e = entities[`${pk}:${rk}`];
      if (!e) {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    async createEntity(e) { writes.push({ op: 'create', entity: e }); },
    async updateEntity(e, m) { writes.push({ op: 'update', entity: e, mode: m }); },
  };
}

// ─── extractScrapedCapital ─────────────────────────────────────────────────

test('extract — legacy avec capital RNE + Web : tout extrait + rename rne_checked_at', () => {
  const legacy = fixtureLegacyWithCapital();
  const r = extractScrapedCapital(legacy);
  assert.ok(r.rne);
  assert.equal(r.rne.dirigeants, legacy.dirigeants);
  assert.equal(r.rne.rneCheckedAt, '2026-04-15T10:00:00Z',
    'rne_checked_at legacy doit être renommé en rneCheckedAt');
  assert.ok(r.web);
  assert.equal(r.web.siteWeb, 'https://exemple.com');
  assert.equal(r.web.siteWebSource, 'ddg_search');
});

test('extract — legacy sans capital : retourne null par couche', () => {
  const legacy = { partitionKey: '75', rowKey: '552081317', siren: '552081317', nom: 'X' };
  const r = extractScrapedCapital(legacy);
  assert.equal(r.rne, null);
  assert.equal(r.web, null);
  assert.equal(r.linkedIn, null);
});

test('extract — entité null/invalid : invalidInput', () => {
  assert.equal(extractScrapedCapital(null).summary.invalidInput, true);
  assert.equal(extractScrapedCapital('string').summary.invalidInput, true);
});

test('extract — colonnes vides ne sont pas extraites', () => {
  const legacy = {
    partitionKey: '75', rowKey: '552081317',
    siteWeb: '', // vide
    siteWebSource: null, // null
    dirigeants: '[]', // string non vide → extrait
  };
  const r = extractScrapedCapital(legacy);
  assert.equal(r.web, null, 'siteWeb="" et siteWebSource=null → pas de capital web');
  assert.ok(r.rne);
  assert.equal(r.rne.dirigeants, '[]');
});

test('extract — summary contient siren', () => {
  const legacy = fixtureLegacyWithCapital();
  const r = extractScrapedCapital(legacy);
  assert.equal(r.summary.siren, '552081317');
  assert.equal(r.summary.hasRne, true);
  assert.equal(r.summary.hasWeb, true);
});

// ─── pickColumnsIfPresent ──────────────────────────────────────────────────

test('pickColumns — colonnes whitelist extraites, autres ignorées', () => {
  const e = { dirigeants: '[]', rneCheckedAt: 'x', siteWeb: 'y', random: 'z' };
  const r = pickColumnsIfPresent(e, COUCHE2_RNE_COLUMNS);
  assert.deepEqual(r, { dirigeants: '[]', rneCheckedAt: 'x' });
});

test('pickColumns — aucune colonne whitelist présente : null', () => {
  const r = pickColumnsIfPresent({ random: 'x' }, COUCHE2_RNE_COLUMNS);
  assert.equal(r, null);
});

// ─── migrateLegacyCapitalToV1 ──────────────────────────────────────────────

test('migrate I-1 — legacy avec capital + v1 conforme : merge OK', async () => {
  const legacy = fixtureLegacyWithCapital();
  const v1 = fixtureV1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': v1 });
  const violationsClient = makeMockClient();

  const result = await migrateLegacyCapitalToV1({
    leadBaseClient,
    violationsClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
    migrationRunId: 'migrate-test-run',
  });

  assert.equal(result.rne.merged, true);
  assert.equal(result.web.merged, true);
  assert.equal(result.totalMerged, 2); // RNE + Web
  assert.equal(leadBaseClient._writes.length, 2);
  assert.equal(violationsClient._writes.length, 0);
});

test('migrate I-1 — v1 absent : refus + audit violations', async () => {
  const legacy = fixtureLegacyWithCapital();
  const leadBaseClient = makeMockClient(); // v1 absent
  const violationsClient = makeMockClient();

  const result = await migrateLegacyCapitalToV1({
    leadBaseClient,
    violationsClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
  });

  assert.equal(result.rne.merged, false);
  assert.equal(result.rne.reason, 'i1_entry_absent');
  assert.equal(result.web.merged, false);
  assert.equal(result.totalMerged, 0);
  assert.ok(result.totalSkipped >= 2);
  assert.equal(leadBaseClient._writes.length, 0);
  assert.ok(violationsClient._writes.length >= 1);
});

test('migrate I-10 — RNE sans rneCheckedAt legacy : injecte migrationAt', async () => {
  const legacy = {
    partitionKey: '75',
    rowKey: '552081317',
    dirigeants: '[]',
    // rneCheckedAt / rne_checked_at absents
  };
  const v1 = fixtureV1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': v1 });

  const result = await migrateLegacyCapitalToV1({
    leadBaseClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
    migrationRunId: 'r',
  });

  assert.equal(result.rne.merged, true);
  const write = leadBaseClient._writes[0];
  assert.ok(write.entity.rneCheckedAt, 'rneCheckedAt doit être injecté pour I-10');
  // Doit être un timestamp ISO récent
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(write.entity.rneCheckedAt));
});

test('migrate — migratedFromLegacyAt audit présent si runId fourni', async () => {
  const legacy = fixtureLegacyWithCapital();
  const v1 = fixtureV1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': v1 });

  await migrateLegacyCapitalToV1({
    leadBaseClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
    migrationRunId: 'migrate-test-run',
  });

  for (const w of leadBaseClient._writes) {
    assert.ok(w.entity.migratedFromLegacyAt, 'audit migration doit être présent');
  }
});

test('migrate — capital absent : skip propre sans erreur', async () => {
  const legacy = { partitionKey: '75', rowKey: '552081317', nom: 'X' }; // pas de capital
  const v1 = fixtureV1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': v1 });

  const result = await migrateLegacyCapitalToV1({
    leadBaseClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
  });

  assert.equal(result.totalMerged, 0);
  assert.equal(result.rne.reason, 'no_capital');
  assert.equal(result.web.reason, 'no_capital');
  assert.equal(leadBaseClient._writes.length, 0);
});

test('migrate I-9 — patch RNE ne contient pas colonnes Web (sémantique)', async () => {
  const legacy = fixtureLegacyWithCapital();
  const v1 = fixtureV1Conforme();
  const leadBaseClient = makeMockClient({ '75:552081317': v1 });

  await migrateLegacyCapitalToV1({
    leadBaseClient,
    legacyEntity: legacy,
    partitionKey: '75',
    rowKey: '552081317',
  });

  // Premier write = RNE (couches dans l'ordre du code), deuxième = Web
  const writes = leadBaseClient._writes;
  // Trouver le write RNE
  const rneWrite = writes.find((w) => w.entity.dirigeants !== undefined);
  const webWrite = writes.find((w) => w.entity.siteWeb !== undefined);
  assert.ok(rneWrite);
  assert.ok(webWrite);
  // Le patch RNE ne doit PAS contenir siteWeb
  assert.equal(rneWrite.entity.siteWeb, undefined);
  // Le patch Web ne doit PAS contenir dirigeants
  assert.equal(webWrite.entity.dirigeants, undefined);
});
