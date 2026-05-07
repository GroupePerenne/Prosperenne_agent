'use strict';

/**
 * Helpers d'audit d'intégrité LeadBase.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.4.
 *
 * Module testable consommé par scripts/audit-leadbase-integrity.js
 * (run hebdomadaire production). Détecte et catégorise les violations
 * d'invariants I-1 à I-10 sur les entrées scannées.
 *
 * L'audit ne corrige pas — il agrège, alerte, archive dans
 * LeadBaseIntegrityRuns table. Les corrections relèvent des writers
 * (safe-write.js) ou de l'opérateur via decision Paul/COMEX.
 */

const { SCHEMA_VERSION_V1, validateLeadBaseEntity, NAF_REGEX, TRANCHE_VALID_CODES, PK_LEADBASE_REGEX, RK_LEADBASE_REGEX } = require('./schema-v1');

const VIOLATION_CATEGORIES = Object.freeze({
  MISSING_SCHEMA_VERSION: 'missing_schema_version',
  INVALID_PK: 'invalid_pk',
  INVALID_RK: 'invalid_rk',
  INVALID_TRANCHE: 'invalid_tranche',
  INVALID_NAF: 'invalid_naf',
  SITE_WEB_NO_SOURCE: 'site_web_no_source',
  COUCHE_N_WITHOUT_COUCHE_1: 'couche_n_without_couche_1',
  RNE_NO_AUDIT_AT: 'rne_no_audit_at',
  SCHEMA_VERSION_DRIFT: 'schema_version_drift',
});

/**
 * Audite une entité LeadBase et retourne la liste des violations détectées.
 * Une entité peut avoir plusieurs violations.
 *
 * @param {Object} entity Entrée Storage Table LeadBase.
 * @returns {string[]} Liste de codes catégorie violations.
 */
function auditLeadBaseEntity(entity) {
  const violations = [];
  if (!entity || typeof entity !== 'object') {
    return [VIOLATION_CATEGORIES.MISSING_SCHEMA_VERSION];
  }

  // schema_version
  if (!entity.schema_version) {
    violations.push(VIOLATION_CATEGORIES.MISSING_SCHEMA_VERSION);
  } else if (entity.schema_version !== SCHEMA_VERSION_V1) {
    violations.push(VIOLATION_CATEGORIES.SCHEMA_VERSION_DRIFT);
  }

  // PK / RK
  if (!entity.partitionKey || !PK_LEADBASE_REGEX.test(entity.partitionKey)) {
    violations.push(VIOLATION_CATEGORIES.INVALID_PK);
  }
  if (!entity.rowKey || !RK_LEADBASE_REGEX.test(entity.rowKey)) {
    violations.push(VIOLATION_CATEGORIES.INVALID_RK);
  }

  // trancheEffectif (si peuplé, doit être valide)
  if (entity.trancheEffectif && !TRANCHE_VALID_CODES.includes(entity.trancheEffectif)) {
    violations.push(VIOLATION_CATEGORIES.INVALID_TRANCHE);
  }

  // codeNaf (si peuplé, doit être valide)
  if (entity.codeNaf && !NAF_REGEX.test(entity.codeNaf)) {
    violations.push(VIOLATION_CATEGORIES.INVALID_NAF);
  }

  // siteWeb peuplé sans siteWebSource (I-9 sémantique unique fautive)
  if (entity.siteWeb && !entity.siteWebSource) {
    violations.push(VIOLATION_CATEGORIES.SITE_WEB_NO_SOURCE);
  }

  // Couche 2-5 peuplée sans Couche 1 sous-jacente complète (I-1 violation)
  // Détection : si dirigeants ou siteWeb peuplé, alors Couche 1 doit être valide.
  const hasCoucheNData = entity.dirigeants !== undefined
    || entity.siteWeb !== undefined
    || entity.companyLinkedInUrl !== undefined;
  if (hasCoucheNData) {
    const coucheCheck = validateLeadBaseEntity(entity);
    if (!coucheCheck.valid) {
      // Ne signaler que si c'est une violation Couche 1 (pas une violation Couche N)
      const c1Errors = coucheCheck.errors.filter((e) =>
        e.includes('siren') || e.includes('codeNaf') || e.includes('trancheEffectif')
        || e.includes('codePostal') || e.includes('schema_version'));
      if (c1Errors.length > 0) {
        violations.push(VIOLATION_CATEGORIES.COUCHE_N_WITHOUT_COUCHE_1);
      }
    }
  }

  // RNE Couche 2 peuplée sans rneCheckedAt (I-10 violation)
  if (entity.dirigeants !== undefined && !entity.rneCheckedAt) {
    violations.push(VIOLATION_CATEGORIES.RNE_NO_AUDIT_AT);
  }

  return violations;
}

/**
 * Agrège les violations d'un batch d'entités. Retourne un compteur
 * par catégorie + total.
 *
 * @param {Iterable<Object>} entities Entrées à auditer.
 * @returns {{ total: number, scanned: number, byCategory: Object<string, number> }}
 */
function aggregateAudit(entities) {
  const byCategory = {};
  let total = 0;
  let scanned = 0;
  for (const entity of entities) {
    scanned++;
    const violations = auditLeadBaseEntity(entity);
    if (violations.length > 0) {
      total += violations.length;
      for (const v of violations) {
        byCategory[v] = (byCategory[v] || 0) + 1;
      }
    }
  }
  return { total, scanned, byCategory };
}

/**
 * Détermine si un audit a déclenché le seuil d'alerte.
 *
 * @param {Object} aggregate Résultat de aggregateAudit.
 * @param {number} [thresholdPercent=0.1] Seuil de drift en % (defaut 0.1%).
 * @returns {{ alert: boolean, driftPercent: number, reasons: string[] }}
 */
function shouldAlert(aggregate, thresholdPercent = 0.1) {
  const reasons = [];
  if (!aggregate || aggregate.scanned === 0) {
    return { alert: false, driftPercent: 0, reasons: ['no_scan'] };
  }
  const driftPercent = (aggregate.total / aggregate.scanned) * 100;
  if (driftPercent > thresholdPercent) {
    reasons.push(`drift_above_threshold:${driftPercent.toFixed(3)}%>${thresholdPercent}%`);
  }
  // Une seule violation I-1 (couche N sans couche 1) déclenche alerte immédiate
  if (aggregate.byCategory[VIOLATION_CATEGORIES.COUCHE_N_WITHOUT_COUCHE_1] > 0) {
    reasons.push('i1_violation_present');
  }
  // schema_version drift = sortie de v1 imprévue
  if (aggregate.byCategory[VIOLATION_CATEGORIES.SCHEMA_VERSION_DRIFT] > 0) {
    reasons.push('schema_drift_detected');
  }
  return {
    alert: reasons.length > 0,
    driftPercent,
    reasons,
  };
}

module.exports = {
  VIOLATION_CATEGORIES,
  auditLeadBaseEntity,
  aggregateAudit,
  shouldAlert,
};
