/**
 * Test intégration pipeline SIRENE — conformité v1 bout-en-bout.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1 §11.3 E2E #1 étape 1.
 *
 * Vérifie en in-memory (mock TableClient) que la chaîne complète
 * mapper → writer produit une entrée LeadBase v1 conforme :
 *   1. Une ligne CSV OpenDataSoft passe par le mapper.
 *   2. L'entité produite passe validateLeadBaseEntity sans erreur.
 *   3. Le writer Merge propage schema_version + sireneRunId.
 *   4. Le writer pose seulement les colonnes SIRENE_OWNED_COLUMNS.
 *
 * Cohérent test E2E stub e2e-cascade-complete.test.js étape 1
 * (qui restera skip jusqu'à LEADBASE_E2E=1 sur infra réelle).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapSireneRowToLeadBase } = require('../../../shared/sirene/mapper');
const { writeEntity, SIRENE_OWNED_COLUMNS } = require('../../../shared/sirene/writer');
const { validateLeadBaseEntity, SCHEMA_VERSION_V1 } = require('../../../shared/leadbase/schema-v1');

function fixtureSireneRow() {
  return {
    siren: '552081317',
    denominationunitelegale: 'EXEMPLE SAS',
    sigleunitelegale: 'EXSAS',
    categoriejuridiqueunitelegale: '5710',
    trancheeffectifsetablissement: '20 à 49 salariés',
    activiteprincipaleetablissement: '70.22Z',
    numerovoieetablissement: '10',
    typevoieetablissement: 'RUE',
    libellevoieetablissement: 'DE LA PAIX',
    codepostaletablissement: '75002',
    libellecommuneetablissement: 'PARIS 2',
    datecreationetablissement: '2010-03-15',
    datederniertraitementetablissement: '2026-04',
  };
}

function makeMockClient() {
  const writes = [];
  return {
    _writes: writes,
    async getEntity() {
      const err = new Error('not found');
      err.statusCode = 404;
      throw err;
    },
    async createEntity(entity) {
      writes.push({ op: 'create', entity });
    },
    async updateEntity(entity, mode) {
      writes.push({ op: 'update', entity, mode });
    },
  };
}

// ─── Pipeline mapper → validator → writer ─────────────────────────────────

test('pipeline conformité v1 — row CSV → mapper → entité valide', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'sirene-test-run',
    snapshot: '2026-04',
  });
  assert.equal(result.valid, true);
  const validation = validateLeadBaseEntity(result.entity);
  assert.equal(validation.valid, true,
    `Validation échouée : ${validation.errors.join(', ')}`);
});

test('pipeline conformité v1 — writer crée entrée avec schema_version', async () => {
  const client = makeMockClient();
  const mapped = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'sirene-test-run',
    snapshot: '2026-04',
  });
  const writeResult = await writeEntity(mapped.entity, { client });
  assert.equal(writeResult.status, 'created');
  assert.equal(client._writes.length, 1);
  const persisted = client._writes[0].entity;
  assert.equal(persisted.schema_version, SCHEMA_VERSION_V1);
  assert.equal(persisted.sireneRunId, 'sirene-test-run');
});

test('pipeline conformité v1 — writer ne pose que SIRENE_OWNED_COLUMNS', async () => {
  const client = makeMockClient();
  const mapped = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'sirene-test-run',
    snapshot: '2026-04',
  });
  await writeEntity(mapped.entity, { client });
  const persisted = client._writes[0].entity;
  const allowedKeys = new Set([
    ...SIRENE_OWNED_COLUMNS,
    'partitionKey', 'rowKey',
  ]);
  for (const key of Object.keys(persisted)) {
    assert.ok(allowedKeys.has(key),
      `Colonne ${key} hors SIRENE_OWNED_COLUMNS — viole I-9 sémantique unique`);
  }
});

test('pipeline conformité v1 — entrée mappée a tous les champs C1 obligatoires', () => {
  const mapped = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'r1', snapshot: '2026-04',
  });
  const entity = mapped.entity;
  // Champs de §5 du schéma : LEADBASE_COUCHE1_REQUIRED
  for (const required of ['siren', 'nom', 'codeNaf', 'trancheEffectif',
    'codePostal', 'sireneSourcedAt', 'sireneSnapshotVersion',
    'sireneRunId', 'schema_version']) {
    assert.ok(entity[required],
      `Champ requis ${required} manquant après mapping`);
  }
});

test('pipeline conformité v1 — re-write idempotent (skip si inchangé)', async () => {
  // Simule entrée existante identique
  const mapped = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'sirene-test-run',
    snapshot: '2026-04',
  });
  const fresh = mapped.entity;
  const existing = { ...fresh, etag: 'abc' };
  const client = {
    _writes: [],
    async getEntity() { return existing; },
    async createEntity(e) { this._writes.push({ op: 'create', e }); },
    async updateEntity(e, m) { this._writes.push({ op: 'update', e, m }); },
  };
  const result = await writeEntity(fresh, { client });
  assert.equal(result.status, 'skipped',
    'Idempotence : entité identique ne doit pas être ré-écrite');
  assert.equal(client._writes.length, 0);
});

test('pipeline conformité v1 — Merge préserve les colonnes Couche 2-5 hors SIRENE', async () => {
  // Entrée existante avec données Couche 2 (RNE dirigeants).
  const mapped = mapSireneRowToLeadBase(fixtureSireneRow(), {
    runId: 'sirene-new-run', // run différent → trigger update
    snapshot: '2026-05',
  });
  const fresh = mapped.entity;
  const existing = {
    ...fresh,
    sireneRunId: 'sirene-OLD-run',
    sireneSnapshotVersion: '2026-04',
    dirigeants: '[{"prenom":"Jean","nom":"Dupont"}]',
    rneCheckedAt: '2026-05-06T00:00:00Z',
    siteWeb: 'https://exemple.com',
    siteWebSource: 'ddg_search',
    etag: 'abc',
  };
  const client = {
    _writes: [],
    async getEntity() { return existing; },
    async createEntity(e) { this._writes.push({ op: 'create', e }); },
    async updateEntity(e, m) { this._writes.push({ op: 'update', e, m }); },
  };
  await writeEntity(fresh, { client });
  // Le writer doit avoir update Merge (pas Replace) — Storage Tables Merge
  // préserve naturellement les colonnes hors patch.
  assert.equal(client._writes.length, 1);
  assert.equal(client._writes[0].m, 'Merge');
  // Le patch ne doit PAS contenir dirigeants/siteWeb/etc (I-9).
  const patch = client._writes[0].e;
  assert.equal(patch.dirigeants, undefined);
  assert.equal(patch.siteWeb, undefined);
  assert.equal(patch.rneCheckedAt, undefined);
});
