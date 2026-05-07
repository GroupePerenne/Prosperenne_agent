/**
 * Tests conformité v1 du pipeline SIRENE.
 *
 * Vérifie que le mapper SIRENE produit des entités conformes au schéma
 * LeadBase v1 (cf. docs/LEADBASE_SCHEMA_v1.md), passant le validator
 * shared/leadbase/schema-v1.js sans erreur.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapSireneRowToLeadBase } = require('../../../shared/sirene/mapper');
const { SIRENE_OWNED_COLUMNS } = require('../../../shared/sirene/writer');
const { validateLeadBaseEntity, SCHEMA_VERSION_V1 } = require('../../../shared/leadbase/schema-v1');

// Fixture ligne CSV OpenDataSoft simulée (champs minimum nécessaires).
function fixtureSireneRow(overrides = {}) {
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
    ...overrides,
  };
}

// ─── Conformité mapper → schéma v1 ─────────────────────────────────────────

test('conformité v1 — mapper pose schema_version=1.0', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow(), { runId: 'test-run' });
  assert.equal(result.valid, true);
  assert.equal(result.entity.schema_version, SCHEMA_VERSION_V1);
});

test('conformité v1 — entité mappée passe validateLeadBaseEntity', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow(), { runId: 'test-run' });
  assert.equal(result.valid, true);
  const validation = validateLeadBaseEntity(result.entity);
  assert.equal(validation.valid, true,
    `Validation échouée : ${validation.errors.join(', ')}`);
});

test('conformité v1 — schema_version dans SIRENE_OWNED_COLUMNS', () => {
  assert.ok(
    SIRENE_OWNED_COLUMNS.includes('schema_version'),
    'schema_version doit être owned par writer SIRENE pour être propagé en Merge',
  );
});

test('conformité v1 — sireneRunId présent et propagé', () => {
  const runId = 'sirene-1778083858456-dc261214';
  const result = mapSireneRowToLeadBase(fixtureSireneRow(), { runId });
  assert.equal(result.entity.sireneRunId, runId);
  assert.ok(SIRENE_OWNED_COLUMNS.includes('sireneRunId'));
});

test('conformité v1 — entité société : prenomDirigeant absent (sémantique I-9)', () => {
  // Société (catégorie juridique 5710 = SAS) : pas de prenomDirigeant SIRENE.
  // Les dirigeants sociétés viennent de Couche 2 RNE uniquement.
  const result = mapSireneRowToLeadBase(fixtureSireneRow({
    categoriejuridiqueunitelegale: '5710',
  }));
  assert.equal(result.entity.prenomDirigeant, undefined,
    'Société : prenomDirigeant ne doit pas être peuplé par SIRENE (I-9)');
});

test('conformité v1 — entité EI : prenomDirigeant présent (sémantique I-9)', () => {
  // EI (catégorie juridique 1xxx) : prenomDirigeant peuplé par SIRENE.
  const result = mapSireneRowToLeadBase(fixtureSireneRow({
    categoriejuridiqueunitelegale: '1000',
    prenom1unitelegale: 'Jean',
    nomunitelegale: 'Dupont',
  }));
  assert.equal(result.entity.prenomDirigeant, 'Jean');
  assert.equal(result.entity.nomDirigeant, 'Dupont');
});

test('conformité v1 — partitionKey + rowKey conformes regex schéma', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow(), { runId: 'test-run' });
  const validation = validateLeadBaseEntity(result.entity);
  assert.equal(validation.valid, true,
    `Validation échouée : ${validation.errors.join(', ')}`);
  assert.equal(result.entity.partitionKey, '75');
  assert.equal(result.entity.rowKey, '552081317');
});

test('conformité v1 — Corse : PK 2A correctement extraite (regex stricte)', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow({
    codepostaletablissement: '20100',
    libellecommuneetablissement: 'SARTENE',
  }), { runId: 'test-run' });
  assert.equal(result.entity.partitionKey, '2A');
  const validation = validateLeadBaseEntity(result.entity);
  assert.equal(validation.valid, true,
    `Validation échouée : ${validation.errors.join(', ')}`);
});

test('conformité v1 — DOM 974 : PK 974 valide', () => {
  const result = mapSireneRowToLeadBase(fixtureSireneRow({
    codepostaletablissement: '97400',
    libellecommuneetablissement: 'SAINT-DENIS',
  }), { runId: 'test-run' });
  assert.equal(result.entity.partitionKey, '974');
  const validation = validateLeadBaseEntity(result.entity);
  assert.equal(validation.valid, true,
    `Validation échouée : ${validation.errors.join(', ')}`);
});
