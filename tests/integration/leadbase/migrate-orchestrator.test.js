/**
 * Test intégration runMigration — orchestrateur scripts/migrate-legacy-capital-to-v1.js
 *
 * Vérifie que le scan + jointure + appel migrateLegacyCapitalToV1 fonctionne
 * sur un small dataset mock, en respectant I-1, I-2, idempotence.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runMigration } = require('../../../scripts/migrate-legacy-capital-to-v1');

// Mock TableClient compatible avec safeListLeadBaseEntities + safeMergeCoucheN.
function makeMockLeadBaseClient(entities) {
  const writes = [];
  return {
    _entities: entities,
    _writes: writes,
    listEntities(queryOptions) {
      const filter = (queryOptions && (queryOptions.queryOptions?.filter || queryOptions.filter)) || '';
      // Filtre simulé : ne retourne que les entrées avec schema_version='1.0'
      // si le filter contient schema_version eq '1.0'
      const matching = filter.includes("schema_version eq '1.0'")
        ? entities.filter((e) => e.schema_version === '1.0')
        : entities;
      return (async function* () {
        for (const e of matching) yield e;
      })();
    },
    async getEntity(pk, rk) {
      const e = entities.find((x) => x.partitionKey === pk && x.rowKey === rk);
      if (!e) {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    async updateEntity(entity, mode) {
      writes.push({ op: 'update', entity, mode });
    },
  };
}

function makeMockRunsClient() {
  const writes = [];
  return {
    _writes: writes,
    async createTable() { /* noop */ },
    async createEntity(e) { writes.push(e); },
  };
}

function fixtureV1WithCapital(siren, dept = '75', overrides = {}) {
  return {
    partitionKey: dept,
    rowKey: siren,
    siren,
    nom: 'EXEMPLE',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    codePostal: `${dept}002`,
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-run-1',
    schema_version: '1.0',
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test('runMigration — dataset vide : 0 scanned 0 migrated', async () => {
  const leadBaseClient = makeMockLeadBaseClient([]);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: true },
    leadBaseClient,
    runsClient,
  });
  assert.equal(result.counters.scanned, 0);
  assert.equal(result.counters.migrated, 0);
});

test('runMigration — entrée v1 sans capital : scannée, pas migrée', async () => {
  const entities = [fixtureV1WithCapital('552081317')];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: true },
    leadBaseClient,
    runsClient,
  });
  assert.equal(result.counters.scanned, 1);
  assert.equal(result.counters.needsMigration, 0);
  assert.equal(result.counters.migrated, 0);
});

test('runMigration — entrée v1 avec capital RNE legacy : needsMigration', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    dirigeants: '[{"prenom":"Jean","nom":"Dupont"}]',
    rne_checked_at: '2026-04-15T10:00:00Z', // legacy snake_case
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: false },
    leadBaseClient,
    runsClient,
  });
  assert.equal(result.counters.scanned, 1);
  assert.equal(result.counters.needsMigration, 1);
  assert.equal(result.counters.capitalRne, 1);
  assert.equal(result.counters.migrated, 1);
  assert.ok(leadBaseClient._writes.length >= 1);
});

test('runMigration — dry-run : no writes même avec capital', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    siteWeb: 'https://exemple.com', siteWebSource: 'ddg_search',
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  await runMigration({
    args: { dryRun: true },
    leadBaseClient,
    runsClient,
  });
  assert.equal(leadBaseClient._writes.length, 0, 'dry-run : pas de write');
});

test('runMigration — entrée déjà migrée (migratedFromLegacyAt) : skip idempotent', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    dirigeants: '[]',
    rneCheckedAt: '2026-05-07T10:00:00Z',
    migratedFromLegacyAt: '2026-05-07T11:00:00Z', // déjà migrée
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: false },
    leadBaseClient,
    runsClient,
  });
  assert.equal(result.counters.scanned, 1);
  assert.equal(result.counters.skipped, 1);
  assert.equal(result.counters.migrated, 0);
});

test('runMigration — I-2 filtre : ignore entrées legacy sans schema_version', async () => {
  const entities = [
    { partitionKey: '75', rowKey: '111111111', dirigeants: '[]' }, // legacy seul
    fixtureV1WithCapital('222222222', '75', { dirigeants: '[]', rne_checked_at: 'x' }),
  ];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: true },
    leadBaseClient,
    runsClient,
  });
  // Seule l'entrée v1 est scannée (filter schema_version eq 1.0)
  assert.equal(result.counters.scanned, 1);
});

test('runMigration — limit respecté', async () => {
  const entities = [];
  for (let i = 0; i < 50; i++) {
    entities.push(fixtureV1WithCapital(String(100000000 + i), '75'));
  }
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  const result = await runMigration({
    args: { dryRun: true, limit: 10 },
    leadBaseClient,
    runsClient,
  });
  // limit=10 : on s'arrête après avoir scanné 11 (le check est `> args.limit`)
  assert.ok(result.counters.scanned <= 11);
});

test('runMigration — flot intégré : email legacy → LeadContacts en parallèle du capital', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    dirigeants: '[]',
    rne_checked_at: 'x',
    emailDirigeant: 'jean.dupont@exemple.com',
    prenomDirigeant: 'Jean',
    nomDirigeant: 'Dupont',
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  // Mock LeadContacts client
  const leadContactsWrites = [];
  const leadContactsClient = {
    async createTable() { /* noop */ },
    async getEntity() {
      const err = new Error('not found');
      err.statusCode = 404;
      throw err;
    },
    async createEntity(e) { leadContactsWrites.push(e); },
  };
  const result = await runMigration({
    args: { dryRun: false },
    leadBaseClient,
    runsClient,
    leadContactsClient,
  });
  // Capital RNE migré
  assert.equal(result.counters.migrated, 1);
  // Email legacy détecté + migré
  assert.equal(result.counters.legacyEmailsDetected, 1);
  assert.equal(result.counters.legacyEmailsMigrated, 1);
  // LeadContacts créée avec schema_version v1
  assert.equal(leadContactsWrites.length, 1);
  assert.equal(leadContactsWrites[0].schema_version, '1.0');
  assert.equal(leadContactsWrites[0].source, 'legacy_migration');
});

test('runMigration — pas de leadContactsClient : skip email migration sans crash', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    emailDirigeant: 'a@b.com',
    prenomDirigeant: 'A', nomDirigeant: 'B',
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  // pas de leadContactsClient passé
  const result = await runMigration({
    args: { dryRun: false },
    leadBaseClient,
    runsClient,
  });
  assert.equal(result.counters.legacyEmailsDetected, 1);
  assert.equal(result.counters.legacyEmailsMigrated, 0); // pas migré faute de client
});

test('runMigration — archivage LeadBaseMigrationRuns en mode full', async () => {
  const entities = [fixtureV1WithCapital('552081317', '75', {
    dirigeants: '[]', rne_checked_at: 'x',
  })];
  const leadBaseClient = makeMockLeadBaseClient(entities);
  const runsClient = makeMockRunsClient();
  await runMigration({
    args: { dryRun: false },
    leadBaseClient,
    runsClient,
  });
  assert.equal(runsClient._writes.length, 1);
  assert.ok(runsClient._writes[0].rowKey.startsWith('migrate-'));
  assert.ok(runsClient._writes[0].countersJson);
});
