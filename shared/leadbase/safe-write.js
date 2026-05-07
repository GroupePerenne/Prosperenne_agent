'use strict';

/**
 * Helpers de write LeadBase enforçant les invariants doctrinaires
 * (cf. docs/LEADBASE_LESSONS_v1.md §4 et docs/LEADBASE_SCHEMA_v1.md §10).
 *
 * Ce module est le mécanisme qui matérialise les invariants — sans lui,
 * I-1 (contrat de couches strict), I-9 (sémantique unique) et I-10
 * (audit *At) resteraient théoriques.
 *
 * Tout writer Couches 2-5 (RNE, siteFinder, lead-exhauster, LinkedIn)
 * doit utiliser safeMergeCoucheN() pour ses écritures LeadBase.
 */

const { checkCouche1Prerequisite } = require('./schema-v1');

const TABLE_INTEGRITY_VIOLATIONS = process.env.LEADBASE_INTEGRITY_VIOLATIONS_TABLE
  || 'LeadBaseIntegrityViolations';

// Couches autorisées à appeler safeMergeCoucheN (les 1 et 5 ont leurs propres flots).
const VALID_LAYERS = Object.freeze(['rne', 'siteFinder', 'leadExhauster', 'linkedIn']);

// Audit fields obligatoires par couche (I-10).
const AUDIT_AT_BY_LAYER = Object.freeze({
  rne: 'rneCheckedAt',
  siteFinder: 'siteWebLastCheckedAt',
  leadExhauster: 'resolvedAt', // dans LeadContacts pas LeadBase, mais semantically equivalent
  linkedIn: 'companyLinkedInResolvedAt',
});

/**
 * Enregistre une violation d'intégrité dans la table d'audit dédiée.
 * Best-effort — n'échoue jamais l'opération de write principale.
 *
 * @param {Object} violationsClient TableClient sur LeadBaseIntegrityViolations.
 * @param {Object} violation
 * @param {string} violation.layer Couche du writer fautif (ex. "rne").
 * @param {string} violation.siren SIREN cible.
 * @param {string} violation.reason Code raison (ex. "schema_version_missing").
 * @param {Object} [violation.context] Contexte libre.
 * @param {Object} [logger] Logger safe-log compatible (optionnel).
 */
async function recordIntegrityViolation(violationsClient, violation, logger) {
  if (!violationsClient) return;
  const now = new Date().toISOString();
  const entity = {
    partitionKey: violation.layer || 'unknown',
    rowKey: `${now}-${violation.siren || 'unknown'}-${Math.random().toString(36).slice(2, 8)}`,
    layer: violation.layer || 'unknown',
    siren: violation.siren || 'unknown',
    reason: violation.reason || 'unknown',
    context: violation.context ? JSON.stringify(violation.context) : null,
    detectedAt: now,
  };
  try {
    await violationsClient.createEntity(entity);
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn(`[integrity-violation] failed to record: ${err.message}`);
    }
  }
}

/**
 * Vérifie I-9 sémantique unique : un writer ne doit toucher que ses colonnes owned.
 * Refuse l'écriture si l'entité contient des colonnes hors couche.
 *
 * @param {Object} entity Patch à écrire.
 * @param {string[]} ownedColumns Colonnes owned de la couche.
 * @returns {{ ok: boolean, violation?: string }}
 */
function checkOwnedColumnsOnly(entity, ownedColumns) {
  if (!entity || typeof entity !== 'object') return { ok: false, violation: 'entity_not_object' };
  if (!Array.isArray(ownedColumns) || ownedColumns.length === 0) {
    return { ok: false, violation: 'owned_columns_empty' };
  }
  const allowed = new Set([...ownedColumns, 'partitionKey', 'rowKey', 'etag', 'odata.etag', 'timestamp']);
  const foreign = Object.keys(entity).filter((k) => !allowed.has(k));
  if (foreign.length > 0) {
    return { ok: false, violation: `foreign_columns:${foreign.join(',')}` };
  }
  return { ok: true };
}

/**
 * Vérifie I-10 audit *At : le patch contient le timestamp d'audit attendu.
 *
 * @param {Object} entity Patch à écrire.
 * @param {string} layer Couche concernée.
 * @returns {{ ok: boolean, violation?: string }}
 */
function checkAuditAtPresent(entity, layer) {
  const auditField = AUDIT_AT_BY_LAYER[layer];
  if (!auditField) return { ok: true }; // couche inconnue, skip
  if (!entity[auditField]) {
    return { ok: false, violation: `missing_audit_at:${auditField}` };
  }
  return { ok: true };
}

/**
 * Merge safe d'une couche N≥2 sur une entrée LeadBase.
 *
 * Enforce :
 *   - I-1 : Couche 1 sur l'entrée cible doit être conforme (siren, codeNaf,
 *     trancheEffectif, codePostal, schema_version peuplés et valides).
 *   - I-9 : le patch ne contient que des colonnes owned par la couche.
 *   - I-10 : le patch contient le timestamp `*At` de la couche.
 *
 * Si une violation : ne write pas, retourne `{ ok: false, reason }` et
 * enregistre dans LeadBaseIntegrityViolations (best-effort).
 *
 * @param {Object} args
 * @param {Object} args.leadBaseClient TableClient sur LeadBase.
 * @param {Object} [args.violationsClient] TableClient sur LeadBaseIntegrityViolations.
 * @param {string} args.layer "rne" | "siteFinder" | "leadExhauster" | "linkedIn".
 * @param {string} args.partitionKey Département.
 * @param {string} args.rowKey SIREN.
 * @param {Object} args.patch Colonnes à merger (incluant audit *At).
 * @param {string[]} args.ownedColumns Colonnes owned par la couche (whitelist I-9).
 * @param {Object} [args.logger] safeLog compatible.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function safeMergeCoucheN({ leadBaseClient, violationsClient, layer, partitionKey, rowKey, patch, ownedColumns, logger }) {
  if (!VALID_LAYERS.includes(layer)) {
    return { ok: false, reason: `invalid_layer:${layer}` };
  }
  if (!leadBaseClient) {
    return { ok: false, reason: 'leadbase_client_missing' };
  }
  if (!partitionKey || !rowKey) {
    return { ok: false, reason: 'missing_pk_rk' };
  }

  // I-9 — colonnes owned uniquement
  const ownedCheck = checkOwnedColumnsOnly(patch, ownedColumns);
  if (!ownedCheck.ok) {
    if (logger && logger.warn) {
      logger.warn(`[safeMerge] layer=${layer} siren=${rowKey} I-9 violation: ${ownedCheck.violation}`);
    }
    await recordIntegrityViolation(violationsClient, {
      layer, siren: rowKey, reason: `i9_${ownedCheck.violation}`,
      context: { partitionKey },
    }, logger);
    return { ok: false, reason: `i9_${ownedCheck.violation}` };
  }

  // I-10 — audit *At
  const auditCheck = checkAuditAtPresent(patch, layer);
  if (!auditCheck.ok) {
    if (logger && logger.warn) {
      logger.warn(`[safeMerge] layer=${layer} siren=${rowKey} I-10 violation: ${auditCheck.violation}`);
    }
    await recordIntegrityViolation(violationsClient, {
      layer, siren: rowKey, reason: `i10_${auditCheck.violation}`,
      context: { partitionKey },
    }, logger);
    return { ok: false, reason: `i10_${auditCheck.violation}` };
  }

  // I-1 — précondition Couche 1
  let existing;
  try {
    existing = await leadBaseClient.getEntity(partitionKey, rowKey);
  } catch (err) {
    if (err && err.statusCode === 404) {
      if (logger && logger.warn) {
        logger.warn(`[safeMerge] layer=${layer} siren=${rowKey} I-1 violation: entry_absent`);
      }
      await recordIntegrityViolation(violationsClient, {
        layer, siren: rowKey, reason: 'i1_entry_absent',
        context: { partitionKey },
      }, logger);
      return { ok: false, reason: 'i1_entry_absent' };
    }
    throw err;
  }

  const couche1 = checkCouche1Prerequisite(existing);
  if (!couche1.ok) {
    if (logger && logger.warn) {
      logger.warn(`[safeMerge] layer=${layer} siren=${rowKey} I-1 violation: ${couche1.reason}`);
    }
    await recordIntegrityViolation(violationsClient, {
      layer, siren: rowKey, reason: `i1_${couche1.reason}`,
      context: { partitionKey, schema_version: existing.schema_version },
    }, logger);
    return { ok: false, reason: `i1_${couche1.reason}` };
  }

  // Tous les invariants OK — Merge
  await leadBaseClient.updateEntity({
    partitionKey,
    rowKey,
    ...patch,
  }, 'Merge');

  return { ok: true };
}

module.exports = {
  safeMergeCoucheN,
  recordIntegrityViolation,
  checkOwnedColumnsOnly,
  checkAuditAtPresent,
  VALID_LAYERS,
  AUDIT_AT_BY_LAYER,
  TABLE_INTEGRITY_VIOLATIONS,
};
