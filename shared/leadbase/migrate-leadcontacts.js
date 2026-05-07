'use strict';

/**
 * Helpers de migration LeadContacts legacy → v1.
 *
 * Doctrine : docs/LEADBASE_SCHEMA_v1.md v1.1 §8.3.
 * Cohérent avec invariants I-1, I-9, I-10.
 *
 * Migration v1 :
 *   1. Renommage colonne `cost_cents` → `costCents` (camelCase strict).
 *   2. Ajout `schema_version='1.0'` sur tout write.
 *   3. Ajout `leadBaseSchemaVersion` snapshoté au moment du write
 *      (permet de détecter les LeadContacts orphelines après évolution
 *      LeadBase via audit).
 *
 * Stratégie non-destructive : on **ajoute** les nouvelles colonnes
 * (cost_cents reste présent en parallèle pendant 30j de rétrocompat
 * lecture, cf. §8.3 SCHEMA). Suppression cost_cents legacy = palier
 * ultérieur après validation 30j prod.
 */

const { SCHEMA_VERSION_V1 } = require('./schema-v1');

/**
 * Transforme une entité LeadContact legacy en entité v1 conforme.
 * Pure function : pas d'IO, retourne un nouvel objet.
 *
 * Cas d'entrée :
 *   - Entité avec `cost_cents` (legacy) : renomme vers costCents.
 *   - Entité avec `costCents` déjà : pas de changement (idempotent).
 *   - Entité avec les deux : conserve costCents (priorité v1).
 *   - Entité sans schema_version : ajoute schema_version='1.0'.
 *   - Entité avec schema_version='1.0' : pas de changement (idempotent).
 *
 * @param {Object} legacy Entité Storage Tables LeadContact existante.
 * @param {Object} [opts]
 * @param {string} [opts.leadBaseSchemaVersion='1.0'] Version snapshot LeadBase parente.
 * @returns {{ migrated: Object, changes: string[] }}
 */
function migrateLeadContactToV1(legacy, opts = {}) {
  if (!legacy || typeof legacy !== 'object') {
    return { migrated: null, changes: ['invalid_input'] };
  }
  const leadBaseSchemaVersion = opts.leadBaseSchemaVersion || SCHEMA_VERSION_V1;
  const changes = [];
  const migrated = { ...legacy };

  // 1. cost_cents → costCents
  if (migrated.cost_cents !== undefined && migrated.costCents === undefined) {
    migrated.costCents = migrated.cost_cents;
    changes.push('renamed_cost_cents_to_costCents');
    // Note : on garde cost_cents en parallèle pendant 30j (rétrocompat).
    // Suppression deferred — cf. doctrine SCHEMA §8.3.
  }

  // 2. schema_version
  if (!migrated.schema_version) {
    migrated.schema_version = SCHEMA_VERSION_V1;
    changes.push('added_schema_version');
  } else if (migrated.schema_version !== SCHEMA_VERSION_V1) {
    // Drift inattendu : on logge mais on ne réécrit pas (sécurité).
    changes.push(`schema_version_drift:${migrated.schema_version}`);
  }

  // 3. leadBaseSchemaVersion snapshot
  if (!migrated.leadBaseSchemaVersion) {
    migrated.leadBaseSchemaVersion = leadBaseSchemaVersion;
    changes.push('added_leadBaseSchemaVersion');
  }

  return { migrated, changes };
}

/**
 * Détermine si une entité LeadContact a besoin d'une migration v1.
 * Renvoie true si au moins un des champs v1 est manquant ou dégradé.
 *
 * @param {Object} entity
 * @returns {boolean}
 */
function needsMigration(entity) {
  if (!entity || typeof entity !== 'object') return false;
  if (!entity.schema_version || entity.schema_version !== SCHEMA_VERSION_V1) return true;
  if (!entity.leadBaseSchemaVersion) return true;
  if (entity.cost_cents !== undefined && entity.costCents === undefined) return true;
  return false;
}

module.exports = {
  migrateLeadContactToV1,
  needsMigration,
};
