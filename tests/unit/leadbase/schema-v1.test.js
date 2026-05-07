/**
 * Tests unitaires schéma LeadBase v1.
 *
 * Couvre §11.1 de docs/LEADBASE_SCHEMA_v1.md v1.1 :
 *   - schema-v1 : entrée valide a toutes les colonnes Couche 1 NON-NULL.
 *   - pk-rk-format : regex PK et RK conformes.
 *   - tranche-codes : trancheEffectif ∈ codes INSEE TEFEN valides.
 *   - naf-format : codeNaf matche le regex.
 *   - schema-version-required : toute entrée a schema_version non vide.
 *   - leadcontacts-schema-v1 : LeadContacts v1 conforme camelCase + version.
 *   - couche1-prerequisite : checkCouche1Prerequisite enforce I-1 contrat couches.
 *   - sirenrunid-trace : test stub (validation par audit prod, pas unit).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCHEMA_VERSION_V1,
  PK_LEADBASE_REGEX,
  RK_LEADBASE_REGEX,
  PK_LEADCONTACTS_REGEX,
  RK_LEADCONTACTS_REGEX,
  NAF_REGEX,
  TRANCHE_VALID_CODES,
  validateLeadBaseEntity,
  validateLeadContactEntity,
  checkCouche1Prerequisite,
} = require('../../../shared/leadbase/schema-v1');

// ─── Fixture entrée LeadBase v1 valide ─────────────────────────────────────

function fixtureLeadBaseValid(overrides = {}) {
  return {
    partitionKey: '75',
    rowKey: '552081317',
    siren: '552081317',
    nom: 'EXEMPLE SAS',
    sigle: 'EXSAS',
    codeNaf: '70.22Z',
    categorieJuridique: '5710',
    trancheEffectif: '12',
    trancheEffectifLabel: '20 à 49 salariés',
    adresse: '10 RUE DE LA PAIX',
    codePostal: '75002',
    ville: 'PARIS 2',
    dateCreation: '2010-03-15',
    sireneSourcedAt: '2026-05-06T20:14:18Z',
    sireneSnapshotVersion: '2026-04',
    sireneRunId: 'sirene-1778083858456-dc261214',
    schema_version: '1.0',
    ...overrides,
  };
}

function fixtureLeadContactValid(overrides = {}) {
  return {
    partitionKey: '552081317',
    rowKey: 'email_jean_dupont',
    siren: '552081317',
    email: 'jean.dupont@exemple.com',
    confidence: 0.92,
    source: 'dropcontact',
    signals: '["dropcontact_qualified_v2"]',
    costCents: 25,
    firstName: 'Jean',
    lastName: 'Dupont',
    role: 'Président',
    roleSource: 'insee',
    roleConfidence: 0.85,
    domain: 'exemple.com',
    domainSource: 'leadbase',
    naf: '70.22Z',
    tranche: '12',
    resolvedAt: '2026-05-07T09:30:00Z',
    lastVerifiedAt: '2026-05-07T09:30:00Z',
    feedbackStatus: null,
    experimentsApplied: '[]',
    beneficiaryId: 'oseys',
    schema_version: '1.0',
    leadBaseSchemaVersion: '1.0',
    ...overrides,
  };
}

// ─── Test 1 — schema-v1 : entrée valide ────────────────────────────────────

test('schema-v1 — entrée Couche 1 valide passe la validation', () => {
  const entity = fixtureLeadBaseValid();
  const result = validateLeadBaseEntity(entity);
  assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
  assert.deepEqual(result.errors, []);
});

test('schema-v1 — entrée vide ou non-objet rejetée', () => {
  assert.equal(validateLeadBaseEntity(null).valid, false);
  assert.equal(validateLeadBaseEntity(undefined).valid, false);
  assert.equal(validateLeadBaseEntity('string').valid, false);
  assert.equal(validateLeadBaseEntity(42).valid, false);
});

// ─── Test 2 — pk-rk-format ─────────────────────────────────────────────────

test('pk-rk-format — PK LeadBase accepte départements valides', () => {
  for (const pk of ['01', '13', '75', '95', '2A', '2B', '971', '976']) {
    assert.equal(PK_LEADBASE_REGEX.test(pk), true, `${pk} devrait être valide`);
  }
});

test('pk-rk-format — PK LeadBase rejette formats invalides', () => {
  for (const pk of ['', '1', '755', '99', 'AA', '977', 'paris', '2C']) {
    assert.equal(PK_LEADBASE_REGEX.test(pk), false, `${pk} devrait être invalide`);
  }
});

test('pk-rk-format — RK LeadBase = SIREN 9 chiffres exactement', () => {
  assert.equal(RK_LEADBASE_REGEX.test('552081317'), true);
  assert.equal(RK_LEADBASE_REGEX.test('123456789'), true);
  assert.equal(RK_LEADBASE_REGEX.test('12345678'), false); // 8 chiffres
  assert.equal(RK_LEADBASE_REGEX.test('1234567890'), false); // 10 chiffres
  assert.equal(RK_LEADBASE_REGEX.test('5520813ZZ'), false); // alpha
});

test('pk-rk-format — siren ↔ rowKey mismatch détecté', () => {
  const entity = fixtureLeadBaseValid({ siren: '999999999' });
  const result = validateLeadBaseEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('siren_rowkey_mismatch')));
});

// ─── Test 3 — tranche-codes ────────────────────────────────────────────────

test('tranche-codes — codes INSEE TEFEN valides acceptés', () => {
  for (const code of TRANCHE_VALID_CODES) {
    const entity = fixtureLeadBaseValid({ trancheEffectif: code });
    const result = validateLeadBaseEntity(entity);
    assert.equal(result.valid, true, `${code} devrait passer (errors: ${result.errors.join(', ')})`);
  }
});

test('tranche-codes — codes hors INSEE rejetés', () => {
  for (const code of ['XX', '99', '5-10', 'large', '13']) {
    const entity = fixtureLeadBaseValid({ trancheEffectif: code });
    const result = validateLeadBaseEntity(entity);
    assert.equal(result.valid, false, `${code} devrait être rejeté`);
    assert.ok(result.errors.some((e) => e.includes('invalid_tranche')));
  }
});

// ─── Test 4 — naf-format ───────────────────────────────────────────────────

test('naf-format — codes NAF valides acceptés', () => {
  for (const naf of ['70.22Z', '85.31Z', '01.11Z', '99.00Z', '70.22']) {
    assert.equal(NAF_REGEX.test(naf), true, `${naf} devrait être valide`);
  }
});

test('naf-format — codes NAF invalides rejetés', () => {
  for (const naf of ['', '7022Z', '70-22Z', '70.222Z', 'XX.YYZ', 'free.text']) {
    assert.equal(NAF_REGEX.test(naf), false, `${naf} devrait être invalide`);
  }
});

// ─── Test 5 — schema-version-required ──────────────────────────────────────

test('schema-version-required — entrée sans schema_version rejetée', () => {
  const entity = fixtureLeadBaseValid({ schema_version: undefined });
  delete entity.schema_version;
  const result = validateLeadBaseEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e === 'missing_required:schema_version'));
});

test('schema-version-required — version inattendue détectée', () => {
  const entity = fixtureLeadBaseValid({ schema_version: '0.9' });
  const result = validateLeadBaseEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('unexpected_schema_version')));
});

test('schema-version-required — version courante v1.0 acceptée', () => {
  const entity = fixtureLeadBaseValid({ schema_version: SCHEMA_VERSION_V1 });
  const result = validateLeadBaseEntity(entity);
  assert.equal(result.valid, true);
});

// ─── Test 6 — leadcontacts-schema-v1 ───────────────────────────────────────

test('leadcontacts-schema-v1 — entrée v1 valide passe', () => {
  const entity = fixtureLeadContactValid();
  const result = validateLeadContactEntity(entity);
  assert.equal(result.valid, true, `errors: ${result.errors.join(', ')}`);
});

test('leadcontacts-schema-v1 — legacy cost_cents seul (sans costCents) rejeté', () => {
  const entity = fixtureLeadContactValid();
  delete entity.costCents;
  entity.cost_cents = 25;
  const result = validateLeadContactEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('legacy_cost_cents_only'));
});

test('leadcontacts-schema-v1 — schema_version et leadBaseSchemaVersion obligatoires', () => {
  const noSchema = fixtureLeadContactValid();
  delete noSchema.schema_version;
  assert.equal(validateLeadContactEntity(noSchema).valid, false);

  const noLeadBase = fixtureLeadContactValid();
  delete noLeadBase.leadBaseSchemaVersion;
  assert.equal(validateLeadContactEntity(noLeadBase).valid, false);
});

test('leadcontacts-schema-v1 — confidence hors [0,1] rejeté', () => {
  for (const c of [-0.1, 1.1, 'high', 2]) {
    const entity = fixtureLeadContactValid({ confidence: c });
    const result = validateLeadContactEntity(entity);
    assert.equal(result.valid, false, `confidence=${c} devrait être rejeté`);
    assert.ok(result.errors.some((e) => e.startsWith('invalid_confidence')));
  }
});

test('leadcontacts-schema-v1 — source hors enum rejetée', () => {
  const entity = fixtureLeadContactValid({ source: 'random_provider' });
  const result = validateLeadContactEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('invalid_source')));
});

test('leadcontacts-schema-v1 — RK email_{first}_{last} format', () => {
  for (const rk of ['email_jean_dupont', 'email_marie-claire_de-la-tour', 'email__']) {
    assert.equal(RK_LEADCONTACTS_REGEX.test(rk), true, `${rk} devrait être valide`);
  }
  for (const rk of ['email_jean', 'jean_dupont', 'email_J_D', 'email_jean.dupont']) {
    assert.equal(RK_LEADCONTACTS_REGEX.test(rk), false, `${rk} devrait être invalide`);
  }
});

// ─── Test 7 — couche1-prerequisite (I-1) ──────────────────────────────────

test('couche1-prerequisite — entrée Couche 1 conforme passe le contrat I-1', () => {
  const entity = fixtureLeadBaseValid();
  assert.deepEqual(checkCouche1Prerequisite(entity), { ok: true });
});

test('couche1-prerequisite — entité absente rejetée', () => {
  const result = checkCouche1Prerequisite(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'entity_absent');
});

test('couche1-prerequisite — siren invalide rejeté', () => {
  for (const siren of [undefined, '', 'ABC123456', '12345']) {
    const entity = fixtureLeadBaseValid({ siren });
    const result = checkCouche1Prerequisite(entity);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'siren_missing_or_invalid');
  }
});

test('couche1-prerequisite — codeNaf invalide rejeté', () => {
  const entity = fixtureLeadBaseValid({ codeNaf: 'XX' });
  const result = checkCouche1Prerequisite(entity);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'codeNaf_missing_or_invalid');
});

test('couche1-prerequisite — trancheEffectif hors INSEE rejeté', () => {
  const entity = fixtureLeadBaseValid({ trancheEffectif: 'XX' });
  const result = checkCouche1Prerequisite(entity);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trancheEffectif_missing_or_invalid');
});

test('couche1-prerequisite — schema_version absent rejeté', () => {
  const entity = fixtureLeadBaseValid();
  delete entity.schema_version;
  const result = checkCouche1Prerequisite(entity);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_version_missing');
});

// ─── Test 8 — PK LeadContacts ──────────────────────────────────────────────

test('leadcontacts-schema-v1 — PK = SIREN 9 chiffres', () => {
  assert.equal(PK_LEADCONTACTS_REGEX.test('552081317'), true);
  assert.equal(PK_LEADCONTACTS_REGEX.test('75'), false);
  assert.equal(PK_LEADCONTACTS_REGEX.test('siren'), false);
});

test('leadcontacts-schema-v1 — siren ↔ partitionKey mismatch détecté', () => {
  const entity = fixtureLeadContactValid({ siren: '999999999' });
  const result = validateLeadContactEntity(entity);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.startsWith('siren_pk_mismatch')));
});
