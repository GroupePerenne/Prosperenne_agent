/**
 * Tests writer SIRENE → LeadBase — shared/sirene/writer.js
 *
 * Approche : tests de logique pure (pickSireneColumns, isUnchanged) +
 * tests writeEntity avec mock client minimal. Pas d'I/O Storage Tables réelle.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const writer = require('../../../shared/sirene/writer');

// ─── pickSireneColumns ────────────────────────────────────────────────────

test('pickSireneColumns — extrait uniquement colonnes SIRENE owned', () => {
  const entity = {
    partitionKey: '75',
    rowKey: '834462061',
    siren: '834462061',
    nom: 'AUDION',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    sireneSourcedAt: '2026-05-06T17:00:00Z',
    sireneRunId: 'run-1',
    // Colonnes hors scope SIRENE — doivent être ignorées
    siteWeb: 'https://audion.fr',
    siteWebSource: 'api_gouv',
    emailDirigeant: 'someone@audion.fr',
    dirigeants: '[{"prenom":"X"}]',
    customField: 'should_not_be_picked',
  };
  const picked = writer.pickSireneColumns(entity);
  assert.equal(picked.siren, '834462061');
  assert.equal(picked.nom, 'AUDION');
  assert.equal(picked.trancheEffectif, '12');
  assert.equal(picked.partitionKey, '75');
  assert.equal(picked.rowKey, '834462061');
  // Colonnes non-SIRENE absentes
  assert.equal(picked.siteWeb, undefined);
  assert.equal(picked.siteWebSource, undefined);
  assert.equal(picked.emailDirigeant, undefined);
  assert.equal(picked.dirigeants, undefined);
  assert.equal(picked.customField, undefined);
});

test('pickSireneColumns — ignore champs null/undefined', () => {
  const picked = writer.pickSireneColumns({
    partitionKey: '75',
    rowKey: '123456789',
    siren: '123456789',
    nom: 'X',
    sigle: undefined,
    codeNaf: null,
  });
  assert.equal(picked.sigle, undefined);
  assert.equal(picked.codeNaf, undefined);
  assert.equal(picked.nom, 'X');
});

// ─── isUnchanged ──────────────────────────────────────────────────────────

test('isUnchanged — pas d\'existant → false', () => {
  assert.equal(writer.isUnchanged(null, { siren: '123456789' }), false);
});

test('isUnchanged — colonnes identiques → true (skip update)', () => {
  const existing = {
    siren: '123456789',
    nom: 'ACME',
    trancheEffectif: '12',
    codeNaf: '70.22Z',
    sireneSourcedAt: '2026-04-01',
    sireneRunId: 'old-run',
  };
  const fresh = {
    siren: '123456789',
    nom: 'ACME',
    trancheEffectif: '12',
    codeNaf: '70.22Z',
    sireneSourcedAt: '2026-05-06',
    sireneRunId: 'new-run',
  };
  // sireneSourcedAt et sireneRunId sont skipFields → différences ignorées
  assert.equal(writer.isUnchanged(existing, fresh), true);
});

test('isUnchanged — tranche modifiée → false (update requis)', () => {
  const existing = {
    siren: '123456789',
    nom: 'ACME',
    trancheEffectif: '11',
  };
  const fresh = {
    siren: '123456789',
    nom: 'ACME',
    trancheEffectif: '12', // L'entreprise a grossi
  };
  assert.equal(writer.isUnchanged(existing, fresh), false);
});

test('isUnchanged — nom différent → false', () => {
  const existing = { siren: '123', nom: 'OLD' };
  const fresh = { siren: '123', nom: 'NEW' };
  assert.equal(writer.isUnchanged(existing, fresh), false);
});

test('isUnchanged — tolérance null/undefined/empty', () => {
  const existing = { siren: '123', sigle: undefined };
  const fresh = { siren: '123', sigle: null };
  assert.equal(writer.isUnchanged(existing, fresh), true);
});

// ─── writeEntity avec mock client ─────────────────────────────────────────

function makeMockClient(opts = {}) {
  const store = new Map();
  if (opts.preload) {
    for (const e of opts.preload) {
      store.set(`${e.partitionKey}|${e.rowKey}`, { ...e, etag: 'W/"original"' });
    }
  }
  return {
    store,
    getEntity: async (pk, rk) => {
      const e = store.get(`${pk}|${rk}`);
      if (!e) {
        const err = new Error('ResourceNotFound');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    createEntity: async (e) => {
      const k = `${e.partitionKey}|${e.rowKey}`;
      if (store.has(k)) {
        const err = new Error('Conflict');
        err.statusCode = 409;
        throw err;
      }
      store.set(k, { ...e, etag: 'W/"created"' });
      return { etag: 'W/"created"' };
    },
    updateEntity: async (e, _mode, _opts) => {
      const k = `${e.partitionKey}|${e.rowKey}`;
      const cur = store.get(k);
      if (!cur) {
        const err = new Error('ResourceNotFound');
        err.statusCode = 404;
        throw err;
      }
      // Merge : conserve les colonnes existantes non touchées
      store.set(k, { ...cur, ...e, etag: 'W/"updated"' });
      return { etag: 'W/"updated"' };
    },
  };
}

test('writeEntity — création nouvelle entité', async () => {
  const client = makeMockClient();
  const entity = {
    partitionKey: '75',
    rowKey: '834462061',
    siren: '834462061',
    nom: 'AUDION',
    trancheEffectif: '12',
  };
  const r = await writer.writeEntity(entity, { client });
  assert.equal(r.status, 'created');
  assert.equal(client.store.size, 1);
});

test('writeEntity — entité existante avec données SIRENE identiques → skipped', async () => {
  const client = makeMockClient({
    preload: [{
      partitionKey: '75',
      rowKey: '834462061',
      siren: '834462061',
      nom: 'AUDION',
      trancheEffectif: '12',
    }],
  });
  const fresh = {
    partitionKey: '75',
    rowKey: '834462061',
    siren: '834462061',
    nom: 'AUDION',
    trancheEffectif: '12',
    sireneSourcedAt: '2026-05-06',
    sireneRunId: 'run-fresh',
  };
  const r = await writer.writeEntity(fresh, { client });
  assert.equal(r.status, 'skipped');
});

test('writeEntity — tranche modifiée → updated, autres colonnes préservées', async () => {
  const client = makeMockClient({
    preload: [{
      partitionKey: '75',
      rowKey: '834462061',
      siren: '834462061',
      nom: 'AUDION',
      trancheEffectif: '11', // ancien
      // Colonnes peuplées par d'autres workers, à préserver
      siteWeb: 'https://audion.fr',
      siteWebSource: 'api_gouv',
      emailDirigeant: 'contact@audion.fr',
      dirigeants: '[{"prenom":"Jean","nom":"Dupont"}]',
    }],
  });
  const fresh = {
    partitionKey: '75',
    rowKey: '834462061',
    siren: '834462061',
    nom: 'AUDION',
    trancheEffectif: '12', // nouveau
    sireneSourcedAt: '2026-05-06',
    sireneRunId: 'run-fresh',
  };
  const r = await writer.writeEntity(fresh, { client });
  assert.equal(r.status, 'updated');
  // Vérifie que les colonnes hors SIRENE sont préservées
  const stored = client.store.get('75|834462061');
  assert.equal(stored.siteWeb, 'https://audion.fr');
  assert.equal(stored.emailDirigeant, 'contact@audion.fr');
  assert.equal(stored.dirigeants, '[{"prenom":"Jean","nom":"Dupont"}]');
  assert.equal(stored.trancheEffectif, '12');
  assert.equal(stored.nom, 'AUDION');
});

test('writeEntity — entité invalide (sans partitionKey) → error', async () => {
  const client = makeMockClient();
  const r = await writer.writeEntity({ rowKey: '123' }, { client });
  assert.equal(r.status, 'error');
  assert.match(r.error, /invalid_entity/);
});

test('writeEntity — sans client (Storage indispo) → error graceful', async () => {
  // Pas de connection string : getLeadBaseClient retourne null.
  // On force via opts.client = null pour simuler.
  const r = await writer.writeEntity({
    partitionKey: '75',
    rowKey: '123456789',
    siren: '123456789',
  }, { client: null });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'no_storage_client');
});

// ─── Constantes ───────────────────────────────────────────────────────────

test('SIRENE_OWNED_COLUMNS — couvre tous les champs documentés doctrine', () => {
  // Cohérence avec docs/SIRENE_INGESTION_v1.md
  const expected = [
    'siren', 'nom', 'sigle', 'codeNaf', 'categorieJuridique',
    'trancheEffectif', 'trancheEffectifLabel',
    'adresse', 'codePostal', 'ville',
    'dateCreation',
    'prenomDirigeant', 'nomDirigeant',
    'sireneSourcedAt', 'sireneSnapshotVersion', 'sireneRunId',
  ];
  for (const c of expected) {
    assert.ok(
      writer.SIRENE_OWNED_COLUMNS.includes(c),
      `colonne ${c} manquante dans SIRENE_OWNED_COLUMNS`,
    );
  }
});
