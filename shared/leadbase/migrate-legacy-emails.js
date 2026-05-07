'use strict';

/**
 * Helpers de migration des emails legacy directs en LeadBase
 * (colonne `emailDirigeant`) vers la table `LeadContacts` v1 conforme.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md v1.1 §8 (Couche 4 Email vit en
 * LeadContacts table dédiée, pas en LeadBase). Le legacy 12,8M Constantin
 * + AirWorker pré-v1 a parfois peuplé `emailDirigeant` directement en
 * LeadBase. Ces emails représentent du capital scrapé qui doit être
 * préservé en bascule v1.
 *
 * Stratégie :
 *   1. Détecter les entrées LeadBase v1 (schema_version='1.0') qui ont
 *      un emailDirigeant peuplé.
 *   2. Pour chaque, vérifier qu'aucune entrée LeadContacts existe déjà
 *      pour ce siren (anti-doublon).
 *   3. Créer entrée LeadContacts v1 avec :
 *      - source='legacy_migration' (marqueur traçabilité)
 *      - confidence=0.4 (prudent : on ne connaît pas la qualité d'origine)
 *      - feedbackStatus=null (pas de retour confirmé)
 *      - migratedFromLegacyEmailAt (audit)
 *   4. Idempotent : skip si entry LeadContacts existe déjà pour le siren.
 *
 * Auto-critique sur confidence=0.4 :
 *   - On ne sait pas si l'email legacy a été validé SMTP ou pas.
 *   - 0.4 < seuil 0.8 par défaut DEFAULT_CONFIDENCE_THRESHOLD.
 *   - Conséquence : ces emails ne seront pas envoyés en J0 par David
 *     tant qu'ils n'ont pas été re-vérifiés via SMTP probe ou Dropcontact.
 *   - C'est volontaire : prudence > volume, cohérent avec mandat Paul
 *     "qualité de la séquence prime".
 */

const { SOURCES } = require('../lead-exhauster/schemas');

// Source synthétique non listée dans SOURCES enum officiel mais documentée
// comme exception migration. Si SOURCES enum est étendu pour l'inclure, à
// aligner ici.
const LEGACY_MIGRATION_SOURCE = 'legacy_migration';
const LEGACY_MIGRATION_CONFIDENCE = 0.4;

/**
 * Détecte si une entrée LeadBase v1 a un email legacy à migrer.
 *
 * @param {Object} leadBaseEntity Entrée LeadBase v1 (schema_version='1.0').
 * @returns {boolean}
 */
function hasLegacyEmailToMigrate(leadBaseEntity) {
  if (!leadBaseEntity || typeof leadBaseEntity !== 'object') return false;
  if (leadBaseEntity.schema_version !== '1.0') return false;
  const email = leadBaseEntity.emailDirigeant;
  if (!email || typeof email !== 'string') return false;
  if (!email.includes('@')) return false;
  return true;
}

/**
 * Construit l'entité LeadContacts v1 à partir d'une entrée LeadBase legacy
 * avec emailDirigeant.
 *
 * @param {Object} leadBaseEntity Entrée LeadBase v1.
 * @param {Object} [opts]
 * @param {string} [opts.beneficiaryId='oseys']
 * @param {string} [opts.migrationRunId]
 * @returns {Object|null} Entité LeadContacts v1 prête à upsert, ou null si invalide.
 */
function buildLeadContactFromLegacyEmail(leadBaseEntity, opts = {}) {
  if (!hasLegacyEmailToMigrate(leadBaseEntity)) return null;
  const siren = leadBaseEntity.siren || leadBaseEntity.rowKey;
  if (!siren || !/^\d{9}$/.test(String(siren))) return null;

  const now = new Date().toISOString();
  const email = String(leadBaseEntity.emailDirigeant).trim().toLowerCase();
  const firstName = String(leadBaseEntity.prenomDirigeant || '').trim();
  const lastName = String(leadBaseEntity.nomDirigeant || '').trim();

  // Domain dérivé de l'email (fallback si siteWeb absent)
  const domain = leadBaseEntity.siteWeb
    ? new URL(leadBaseEntity.siteWeb).hostname.replace(/^www\./, '')
    : (email.split('@')[1] || '');

  // RowKey : email_{firstName}_{lastName} normalisé.
  const rowKey = buildLeadContactRowKey(firstName, lastName);

  return {
    partitionKey: String(siren),
    rowKey,
    siren: String(siren),
    email,
    confidence: LEGACY_MIGRATION_CONFIDENCE,
    source: LEGACY_MIGRATION_SOURCE,
    signals: JSON.stringify(['legacy_leadbase_email_dirigeant']),
    cost_cents: 0, // rétrocompat 30j
    costCents: 0,  // v1 camelCase
    firstName: normalizeNamePart(firstName),
    lastName: normalizeNamePart(lastName),
    role: '',
    roleSource: 'insee', // dirigeant SIRENE pour EI uniquement
    roleConfidence: 0,
    domain,
    domainSource: 'leadbase',
    naf: String(leadBaseEntity.codeNaf || ''),
    tranche: String(leadBaseEntity.trancheEffectif || ''),
    resolvedAt: now,
    lastVerifiedAt: now,
    feedbackStatus: null,
    experimentsApplied: '[]',
    beneficiaryId: opts.beneficiaryId || 'oseys',
    schema_version: '1.0',
    leadBaseSchemaVersion: '1.0',
    migratedFromLegacyEmailAt: now,
    migrationRunId: opts.migrationRunId || null,
  };
}

/**
 * Normalise une partie de nom pour rowKey (lowercase, sans accents,
 * non-alpha → '_'). Aligné avec shared/lead-exhauster/patterns.normalizeNamePart
 * (réimplémenté ici pour éviter dépendance circulaire).
 */
function normalizeNamePart(s) {
  if (!s || typeof s !== 'string') return '';
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function buildLeadContactRowKey(firstName, lastName) {
  const f = normalizeNamePart(firstName);
  const l = normalizeNamePart(lastName);
  return `email_${f}_${l}`;
}

/**
 * Migre l'email legacy d'une entrée LeadBase vers une nouvelle entrée
 * LeadContacts v1. Idempotent : skip si une entrée LeadContacts existe
 * déjà pour le couple (siren, firstName, lastName).
 *
 * @param {Object} args
 * @param {Object} args.leadContactsClient TableClient sur LeadContacts.
 * @param {Object} args.leadBaseEntity Entrée LeadBase v1 source.
 * @param {string} [args.beneficiaryId]
 * @param {string} [args.migrationRunId]
 * @returns {Promise<{ migrated: boolean, reason?: string }>}
 */
async function migrateLegacyEmailToLeadContact({
  leadContactsClient,
  leadBaseEntity,
  beneficiaryId,
  migrationRunId,
}) {
  if (!leadContactsClient) return { migrated: false, reason: 'no_client' };
  const contact = buildLeadContactFromLegacyEmail(leadBaseEntity, {
    beneficiaryId, migrationRunId,
  });
  if (!contact) return { migrated: false, reason: 'no_legacy_email' };

  // Anti-doublon idempotent : vérifier si entrée existe déjà
  try {
    const existing = await leadContactsClient.getEntity(contact.partitionKey, contact.rowKey);
    if (existing && existing.email) {
      return { migrated: false, reason: 'leadcontact_already_exists' };
    }
  } catch (err) {
    if (!err || err.statusCode !== 404) {
      return { migrated: false, reason: `read_error:${err.message}` };
    }
    // 404 = OK, on peut créer
  }

  try {
    await leadContactsClient.createEntity(contact);
    return { migrated: true };
  } catch (err) {
    if (err && err.statusCode === 409) {
      // Race condition : créé entre le getEntity et createEntity. Idempotent.
      return { migrated: false, reason: 'race_409' };
    }
    return { migrated: false, reason: `create_error:${err.message}` };
  }
}

module.exports = {
  hasLegacyEmailToMigrate,
  buildLeadContactFromLegacyEmail,
  buildLeadContactRowKey,
  migrateLegacyEmailToLeadContact,
  normalizeNamePart,
  LEGACY_MIGRATION_SOURCE,
  LEGACY_MIGRATION_CONFIDENCE,
};
