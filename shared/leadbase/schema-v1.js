'use strict';

/**
 * Module source de vérité runtime du schéma LeadBase v1.
 *
 * Cohérent avec docs/LEADBASE_SCHEMA_v1.md v1.1 (commit 21fbd1c).
 * Tout writer/reader LeadBase doit valider via ce module avant write,
 * et tout test d'intégrité importe les validators d'ici.
 *
 * Doctrine de référence : docs/LEADBASE_LESSONS_v1.md (invariants I-1 à I-10).
 */

const SCHEMA_VERSION_V1 = '1.0';

// PartitionKey LeadBase = département français valide.
// Métropole : 01-19, 21-95 (le 20 est remplacé par 2A/2B en Corse). DOM : 971-976.
const PK_LEADBASE_REGEX = /^(0[1-9]|1[0-9]|2[1-9]|[3-8][0-9]|9[0-5]|2A|2B|97[1-6])$/;

// RowKey LeadBase = SIREN 9 chiffres.
const RK_LEADBASE_REGEX = /^[0-9]{9}$/;

// PartitionKey LeadContacts = SIREN.
const PK_LEADCONTACTS_REGEX = /^[0-9]{9}$/;

// RowKey LeadContacts = email_{normFirstName}_{normLastName}.
// Le format normalisé autorise lowercase, chiffres, underscores et tirets.
// Catch-all : email__ (firstName et lastName vides).
const RK_LEADCONTACTS_REGEX = /^email_[a-z0-9-]*_[a-z0-9-]*$/;

// Code NAF : 2 chiffres + . + 2 chiffres + lettre optionnelle.
const NAF_REGEX = /^[0-9]{2}\.[0-9]{2}[A-Z]?$/;

// Codes INSEE TEFEN valides (cf. shared/sirene/mapper.js).
const TRANCHE_VALID_CODES = Object.freeze([
  'NN', '00', '01', '02', '03',
  '11', '12', '21', '22', '31', '32',
  '41', '42', '51', '52', '53',
]);

// Tranches sweet spot Pérenne par défaut (6-49 salariés).
const TRANCHE_SWEET_SPOT_PERENNE = Object.freeze(['03', '11', '12']);

// Couche 1 — colonnes obligatoires (NULL non toléré) sur entrée v1.0 valide.
const LEADBASE_COUCHE1_REQUIRED = Object.freeze([
  'siren',
  'nom',
  'codeNaf',
  'trancheEffectif',
  'codePostal',
  'sireneSourcedAt',
  'sireneSnapshotVersion',
  'sireneRunId',
  'schema_version',
]);

// LeadContacts v1 — colonnes obligatoires.
const LEADCONTACTS_REQUIRED = Object.freeze([
  'siren',
  'email',
  'confidence',
  'source',
  'costCents',
  'resolvedAt',
  'beneficiaryId',
  'schema_version',
  'leadBaseSchemaVersion',
]);

// Sources email valides (cohérent avec shared/lead-exhauster/schemas.js SOURCES).
const LEADCONTACTS_VALID_SOURCES = Object.freeze([
  'internal_patterns',
  'internal_scraping',
  'google_site',
  'linkedin_signal',
  'dropcontact',
  'cache',
]);

/**
 * Valide une entité LeadBase v1 contre le schéma Couche 1 (identité SIRENE).
 *
 * Ne valide PAS les couches 2-5 (RNE, web, email, LinkedIn) — elles ont leurs
 * validators dédiés (à créer en suite) ou n'ont pas de NULLability obligatoire.
 *
 * @param {Object} entity Entrée Storage Table.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLeadBaseEntity(entity) {
  const errors = [];

  if (!entity || typeof entity !== 'object') {
    return { valid: false, errors: ['entity_not_object'] };
  }

  // Identifiants
  if (!entity.partitionKey) {
    errors.push('missing_partitionKey');
  } else if (!PK_LEADBASE_REGEX.test(entity.partitionKey)) {
    errors.push(`invalid_partitionKey:${entity.partitionKey}`);
  }

  if (!entity.rowKey) {
    errors.push('missing_rowKey');
  } else if (!RK_LEADBASE_REGEX.test(entity.rowKey)) {
    errors.push(`invalid_rowKey:${entity.rowKey}`);
  }

  // Colonnes obligatoires Couche 1
  for (const col of LEADBASE_COUCHE1_REQUIRED) {
    if (entity[col] === undefined || entity[col] === null || entity[col] === '') {
      errors.push(`missing_required:${col}`);
    }
  }

  // Validation typée
  if (entity.siren && !/^[0-9]{9}$/.test(entity.siren)) {
    errors.push(`invalid_siren_format:${entity.siren}`);
  }

  // Cohérence siren ↔ rowKey
  if (entity.siren && entity.rowKey && entity.siren !== entity.rowKey) {
    errors.push(`siren_rowkey_mismatch:${entity.siren}!=${entity.rowKey}`);
  }

  if (entity.codeNaf && !NAF_REGEX.test(entity.codeNaf)) {
    errors.push(`invalid_naf:${entity.codeNaf}`);
  }

  if (entity.trancheEffectif && !TRANCHE_VALID_CODES.includes(entity.trancheEffectif)) {
    errors.push(`invalid_tranche:${entity.trancheEffectif}`);
  }

  if (entity.schema_version && entity.schema_version !== SCHEMA_VERSION_V1) {
    errors.push(`unexpected_schema_version:${entity.schema_version}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valide une entité LeadContacts v1.
 *
 * @param {Object} entity Entrée Storage Table LeadContacts.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateLeadContactEntity(entity) {
  const errors = [];

  if (!entity || typeof entity !== 'object') {
    return { valid: false, errors: ['entity_not_object'] };
  }

  if (!entity.partitionKey) {
    errors.push('missing_partitionKey');
  } else if (!PK_LEADCONTACTS_REGEX.test(entity.partitionKey)) {
    errors.push(`invalid_partitionKey:${entity.partitionKey}`);
  }

  if (!entity.rowKey) {
    errors.push('missing_rowKey');
  } else if (!RK_LEADCONTACTS_REGEX.test(entity.rowKey)) {
    errors.push(`invalid_rowKey:${entity.rowKey}`);
  }

  for (const col of LEADCONTACTS_REQUIRED) {
    if (entity[col] === undefined || entity[col] === null || entity[col] === '') {
      errors.push(`missing_required:${col}`);
    }
  }

  if (entity.confidence !== undefined && entity.confidence !== null) {
    if (typeof entity.confidence !== 'number' || entity.confidence < 0 || entity.confidence > 1) {
      errors.push(`invalid_confidence:${entity.confidence}`);
    }
  }

  if (entity.source && !LEADCONTACTS_VALID_SOURCES.includes(entity.source)) {
    errors.push(`invalid_source:${entity.source}`);
  }

  if (entity.costCents !== undefined && entity.costCents !== null) {
    if (typeof entity.costCents !== 'number' || entity.costCents < 0) {
      errors.push(`invalid_costCents:${entity.costCents}`);
    }
  }

  // Cohérence siren ↔ partitionKey
  if (entity.siren && entity.partitionKey && entity.siren !== entity.partitionKey) {
    errors.push(`siren_pk_mismatch:${entity.siren}!=${entity.partitionKey}`);
  }

  if (entity.schema_version && entity.schema_version !== SCHEMA_VERSION_V1) {
    errors.push(`unexpected_schema_version:${entity.schema_version}`);
  }

  // Détection legacy : présence de cost_cents sans costCents = pas conforme v1
  if (entity.cost_cents !== undefined && entity.costCents === undefined) {
    errors.push('legacy_cost_cents_only');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Vérifie qu'une entrée LeadBase satisfait le contrat Couche 1 strict (I-1).
 * Utilisé par les writers Couches 2-5 avant d'écrire (précondition).
 *
 * Plus permissif que validateLeadBaseEntity : tolère que sireneRunId soit absent
 * (legacy migration en cours), mais exige siren/codeNaf/trancheEffectif/codePostal.
 *
 * @param {Object} entity Entité existante en LeadBase.
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkCouche1Prerequisite(entity) {
  if (!entity) return { ok: false, reason: 'entity_absent' };
  if (!entity.siren || !/^[0-9]{9}$/.test(entity.siren)) {
    return { ok: false, reason: 'siren_missing_or_invalid' };
  }
  if (!entity.codeNaf || !NAF_REGEX.test(entity.codeNaf)) {
    return { ok: false, reason: 'codeNaf_missing_or_invalid' };
  }
  if (!entity.trancheEffectif || !TRANCHE_VALID_CODES.includes(entity.trancheEffectif)) {
    return { ok: false, reason: 'trancheEffectif_missing_or_invalid' };
  }
  if (!entity.codePostal) {
    return { ok: false, reason: 'codePostal_missing' };
  }
  if (!entity.schema_version) {
    return { ok: false, reason: 'schema_version_missing' };
  }
  return { ok: true };
}

module.exports = {
  SCHEMA_VERSION_V1,
  PK_LEADBASE_REGEX,
  RK_LEADBASE_REGEX,
  PK_LEADCONTACTS_REGEX,
  RK_LEADCONTACTS_REGEX,
  NAF_REGEX,
  TRANCHE_VALID_CODES,
  TRANCHE_SWEET_SPOT_PERENNE,
  LEADBASE_COUCHE1_REQUIRED,
  LEADCONTACTS_REQUIRED,
  LEADCONTACTS_VALID_SOURCES,
  validateLeadBaseEntity,
  validateLeadContactEntity,
  checkCouche1Prerequisite,
};
