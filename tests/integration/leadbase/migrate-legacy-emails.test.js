/**
 * Tests intégration migration emails legacy LeadBase.emailDirigeant
 * → LeadContacts v1.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1 §8.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasLegacyEmailToMigrate,
  buildLeadContactFromLegacyEmail,
  buildLeadContactRowKey,
  migrateLegacyEmailToLeadContact,
  LEGACY_MIGRATION_SOURCE,
  LEGACY_MIGRATION_CONFIDENCE,
} = require('../../../shared/leadbase/migrate-legacy-emails');

function fixtureV1WithLegacyEmail(overrides = {}) {
  return {
    partitionKey: '75',
    rowKey: '552081317',
    siren: '552081317',
    nom: 'EXEMPLE LEGACY',
    codeNaf: '70.22Z',
    trancheEffectif: '12',
    codePostal: '75002',
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-1778083858456-dc261214',
    schema_version: '1.0',
    // Capital legacy
    emailDirigeant: 'jean.dupont@exemple.com',
    prenomDirigeant: 'Jean',
    nomDirigeant: 'Dupont',
    siteWeb: 'https://exemple.com',
    ...overrides,
  };
}

function makeMockLeadContactsClient(existingEntities = {}) {
  const writes = [];
  return {
    _entities: existingEntities,
    _writes: writes,
    async getEntity(pk, rk) {
      const e = existingEntities[`${pk}:${rk}`];
      if (!e) {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      }
      return e;
    },
    async createEntity(entity) { writes.push(entity); },
  };
}

// ─── hasLegacyEmailToMigrate ───────────────────────────────────────────────

test('hasLegacyEmailToMigrate — entrée v1 avec emailDirigeant : true', () => {
  assert.equal(hasLegacyEmailToMigrate(fixtureV1WithLegacyEmail()), true);
});

test('hasLegacyEmailToMigrate — entrée v1 sans emailDirigeant : false', () => {
  const e = fixtureV1WithLegacyEmail();
  delete e.emailDirigeant;
  assert.equal(hasLegacyEmailToMigrate(e), false);
});

test('hasLegacyEmailToMigrate — emailDirigeant invalide (sans @) : false', () => {
  const e = fixtureV1WithLegacyEmail({ emailDirigeant: 'pas-un-email' });
  assert.equal(hasLegacyEmailToMigrate(e), false);
});

test('hasLegacyEmailToMigrate — entrée legacy (sans schema_version) : false', () => {
  const e = fixtureV1WithLegacyEmail();
  delete e.schema_version;
  assert.equal(hasLegacyEmailToMigrate(e), false);
});

test('hasLegacyEmailToMigrate — entrée null : false', () => {
  assert.equal(hasLegacyEmailToMigrate(null), false);
});

// ─── buildLeadContactFromLegacyEmail ───────────────────────────────────────

test('build — produit entrée LeadContacts v1 conforme', () => {
  const c = buildLeadContactFromLegacyEmail(fixtureV1WithLegacyEmail(), {
    migrationRunId: 'm1',
  });
  assert.ok(c);
  assert.equal(c.partitionKey, '552081317');
  assert.equal(c.rowKey, 'email_jean_dupont');
  assert.equal(c.email, 'jean.dupont@exemple.com');
  assert.equal(c.confidence, LEGACY_MIGRATION_CONFIDENCE);
  assert.equal(c.source, LEGACY_MIGRATION_SOURCE);
  assert.equal(c.schema_version, '1.0');
  assert.equal(c.leadBaseSchemaVersion, '1.0');
  assert.equal(c.firstName, 'jean');
  assert.equal(c.lastName, 'dupont');
  assert.equal(c.naf, '70.22Z');
  assert.equal(c.tranche, '12');
  assert.equal(c.domain, 'exemple.com');
  assert.equal(c.beneficiaryId, 'oseys');
  assert.equal(c.migrationRunId, 'm1');
  assert.ok(c.migratedFromLegacyEmailAt);
  // Rétrocompat costCents + cost_cents
  assert.equal(c.costCents, 0);
  assert.equal(c.cost_cents, 0);
});

test('build — confidence < seuil 0.8 : volontairement prudent', () => {
  const c = buildLeadContactFromLegacyEmail(fixtureV1WithLegacyEmail());
  assert.ok(c.confidence < 0.8,
    `confidence=${c.confidence} doit rester < seuil 0.8 (David ne doit pas envoyer sans re-vérification)`);
});

test('build — siren invalide : null', () => {
  const e = fixtureV1WithLegacyEmail({ siren: 'ABC' });
  assert.equal(buildLeadContactFromLegacyEmail(e), null);
});

test('build — sans emailDirigeant : null', () => {
  const e = fixtureV1WithLegacyEmail();
  delete e.emailDirigeant;
  assert.equal(buildLeadContactFromLegacyEmail(e), null);
});

test('build — domain dérivé de email si siteWeb absent', () => {
  const e = fixtureV1WithLegacyEmail();
  delete e.siteWeb;
  const c = buildLeadContactFromLegacyEmail(e);
  assert.equal(c.domain, 'exemple.com');
});

test('build — accents dans nom : normalisés (rowKey ASCII)', () => {
  const c = buildLeadContactFromLegacyEmail(fixtureV1WithLegacyEmail({
    prenomDirigeant: 'Éloïse',
    nomDirigeant: 'François',
  }));
  assert.equal(c.firstName, 'eloise');
  assert.equal(c.lastName, 'francois');
  assert.equal(c.rowKey, 'email_eloise_francois');
});

test('build — catch-all (firstName/lastName vides) : email__', () => {
  const c = buildLeadContactFromLegacyEmail(fixtureV1WithLegacyEmail({
    prenomDirigeant: '',
    nomDirigeant: '',
  }));
  assert.equal(c.rowKey, 'email__');
});

// ─── buildLeadContactRowKey ────────────────────────────────────────────────

test('buildLeadContactRowKey — vide vide → email__', () => {
  assert.equal(buildLeadContactRowKey('', ''), 'email__');
});

test('buildLeadContactRowKey — accents normalisés', () => {
  assert.equal(buildLeadContactRowKey('François', 'Müller'), 'email_francois_muller');
});

// ─── migrateLegacyEmailToLeadContact ───────────────────────────────────────

test('migrate — entrée valide + LeadContacts vide : créée', async () => {
  const client = makeMockLeadContactsClient();
  const result = await migrateLegacyEmailToLeadContact({
    leadContactsClient: client,
    leadBaseEntity: fixtureV1WithLegacyEmail(),
    migrationRunId: 'm1',
  });
  assert.equal(result.migrated, true);
  assert.equal(client._writes.length, 1);
  assert.equal(client._writes[0].schema_version, '1.0');
});

test('migrate — entrée déjà existante en LeadContacts : skip idempotent', async () => {
  const existing = {
    'email_jean_dupont:552081317': {
      partitionKey: '552081317',
      rowKey: 'email_jean_dupont',
      email: 'jean.dupont@exemple.com',
    },
  };
  // Note : le mock indexe par 'pk:rk', mais getEntity prend (pk, rk) donc ça doit
  // matcher. On corrige pour utiliser le bon index.
  const properExisting = {};
  properExisting['552081317:email_jean_dupont'] = {
    partitionKey: '552081317',
    rowKey: 'email_jean_dupont',
    email: 'jean.dupont@exemple.com',
  };
  const client = makeMockLeadContactsClient(properExisting);
  const result = await migrateLegacyEmailToLeadContact({
    leadContactsClient: client,
    leadBaseEntity: fixtureV1WithLegacyEmail(),
  });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'leadcontact_already_exists');
  assert.equal(client._writes.length, 0);
});

test('migrate — entrée sans email legacy : skip propre', async () => {
  const client = makeMockLeadContactsClient();
  const e = fixtureV1WithLegacyEmail();
  delete e.emailDirigeant;
  const result = await migrateLegacyEmailToLeadContact({
    leadContactsClient: client,
    leadBaseEntity: e,
  });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'no_legacy_email');
  assert.equal(client._writes.length, 0);
});

test('migrate — race 409 sur createEntity : skip idempotent', async () => {
  const client = {
    async getEntity() {
      const err = new Error('not found');
      err.statusCode = 404;
      throw err;
    },
    async createEntity() {
      const err = new Error('conflict');
      err.statusCode = 409;
      throw err;
    },
  };
  const result = await migrateLegacyEmailToLeadContact({
    leadContactsClient: client,
    leadBaseEntity: fixtureV1WithLegacyEmail(),
  });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, 'race_409');
});
