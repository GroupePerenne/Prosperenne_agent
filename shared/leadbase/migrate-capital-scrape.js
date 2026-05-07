'use strict';

/**
 * Helpers de migration capital scrapé legacy → LeadBase v1.
 *
 * Doctrine : docs/LEADBASE_SCHEMA_v1.md v1.1, docs/LEADBASE_LESSONS_v1.md
 * §4 invariants I-1, I-9, I-10.
 *
 * Cas d'usage : la LeadBase legacy 12,8M (peuplée historiquement par
 * Constantin + AirWorker pré-v1) contient du capital scrapé Couches 2-5
 * (siteWeb, dirigeants RNE, parfois emailDirigeant) sur des SIRENs qui
 * peuvent ou non se retrouver dans LeadBase v1 (SIRENE bulk filtré sweet
 * spot OSEYS).
 *
 * Migration : pour chaque SIREN présent à la fois en legacy et en v1
 * (jointure naturelle par RowKey=siren), on extrait le capital Couches 2-5
 * du legacy et on le pose sur l'entrée v1 via safeMergeCoucheN (qui
 * enforce I-1, I-9, I-10).
 *
 * Capital extrait :
 *   - Couche 2 RNE  : dirigeants (JSON), rneCheckedAt
 *   - Couche 3 Web  : siteWeb*, siteFinder* audit
 *   - Couche 5 LkIn : companyLinkedInUrl* (futur, vide en v1)
 *
 * Couche 4 Email : NE TRAITE PAS LeadBase legacy (emails directs).
 * Cas séparé migrate-legacy-emails-to-leadcontacts.js (sous-palier suivant).
 */

const { safeMergeCoucheN } = require('./safe-write');

// Whitelists colonnes par couche (cohérent docs/LEADBASE_SCHEMA_v1.md §6-9).
const COUCHE2_RNE_COLUMNS = Object.freeze(['dirigeants', 'rneCheckedAt']);
const COUCHE3_WEB_COLUMNS = Object.freeze([
  'siteWeb',
  'siteWebConfidence',
  'siteWebSource',
  'siteWebProofType',
  'siteWebVersion',
  'siteWebValidatedAt',
  'siteWebLastCheckedAt',
  'siteFinderResult',
  'siteFinderAttempts',
  'siteFinderCacheHits',
  'siteFinderCostCents',
  'siteFinderMeta',
  'siteFinderOk',
  'siteFinderSkipped',
]);
const COUCHE5_LINKEDIN_COLUMNS = Object.freeze([
  'companyLinkedInUrl',
  'companyLinkedInResolvedAt',
  'companyLinkedInSource',
]);

/**
 * Mapping legacy field name → camelCase v1 quand il y a divergence.
 * Le legacy peut avoir snake_case (rne_checked_at). v1 = camelCase strict.
 */
const LEGACY_FIELD_RENAMES = Object.freeze({
  rne_checked_at: 'rneCheckedAt',
});

/**
 * Extrait le capital scrapé d'une entité LeadBase legacy.
 * Regroupe par couche pour faciliter la migration via safeMergeCoucheN.
 *
 * Idempotent / pure function : pas d'IO, retourne un objet structuré.
 *
 * @param {Object} legacy Entité LeadBase legacy (peut contenir Couches 1-5 mélangées).
 * @returns {{ rne: Object|null, web: Object|null, linkedIn: Object|null, summary: Object }}
 */
function extractScrapedCapital(legacy) {
  if (!legacy || typeof legacy !== 'object') {
    return { rne: null, web: null, linkedIn: null, summary: { invalidInput: true } };
  }

  // Normalise les renames legacy → camelCase
  const normalized = { ...legacy };
  for (const [oldName, newName] of Object.entries(LEGACY_FIELD_RENAMES)) {
    if (normalized[oldName] !== undefined && normalized[newName] === undefined) {
      normalized[newName] = normalized[oldName];
    }
  }

  // Couche 2 RNE
  const rne = pickColumnsIfPresent(normalized, COUCHE2_RNE_COLUMNS);

  // Couche 3 Web
  const web = pickColumnsIfPresent(normalized, COUCHE3_WEB_COLUMNS);

  // Couche 5 LinkedIn
  const linkedIn = pickColumnsIfPresent(normalized, COUCHE5_LINKEDIN_COLUMNS);

  return {
    rne,
    web,
    linkedIn,
    summary: {
      hasRne: rne !== null,
      hasWeb: web !== null,
      hasLinkedIn: linkedIn !== null,
      siren: legacy.rowKey || legacy.siren || null,
    },
  };
}

/**
 * Extrait les colonnes whitelist d'un objet, retourne null si aucune
 * colonne owned n'est présente avec une valeur non-null/non-undefined.
 */
function pickColumnsIfPresent(entity, columns) {
  const out = {};
  let hasAny = false;
  for (const col of columns) {
    const v = entity[col];
    if (v !== undefined && v !== null && v !== '') {
      out[col] = v;
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

/**
 * Migre le capital scrapé d'une entité legacy vers son équivalent LeadBase v1.
 *
 * Pré-requis : l'entrée v1 doit déjà exister (créée par sireneIngestion).
 * Si elle n'existe pas, le contrat I-1 (safeMergeCoucheN) refuse l'écriture.
 *
 * Stratégie : pour chaque couche peuplée dans le legacy, appel séparé à
 * safeMergeCoucheN avec audit `*At` injecté si manquant (I-10). Si une
 * couche n'a pas son `*At` legacy (cas RNE legacy sans rneCheckedAt),
 * on pose l'audit avec timestamp migration pour ne pas violer I-10.
 *
 * @param {Object} args
 * @param {Object} args.leadBaseClient TableClient sur LeadBase v1.
 * @param {Object} [args.violationsClient] TableClient violations (best-effort).
 * @param {Object} args.legacyEntity Entité legacy source.
 * @param {string} args.partitionKey PK v1 (département cohérent avec rowKey siren).
 * @param {string} args.rowKey RK v1 (= siren).
 * @param {string} [args.migrationRunId] Trace audit migration.
 * @param {Object} [args.logger] safeLog compatible.
 * @returns {Promise<{ rne: Object, web: Object, linkedIn: Object, totalMerged: number, totalSkipped: number }>}
 */
async function migrateLegacyCapitalToV1({
  leadBaseClient,
  violationsClient,
  legacyEntity,
  partitionKey,
  rowKey,
  migrationRunId,
  logger,
}) {
  const capital = extractScrapedCapital(legacyEntity);
  const result = {
    rne: { merged: false, reason: null },
    web: { merged: false, reason: null },
    linkedIn: { merged: false, reason: null },
    totalMerged: 0,
    totalSkipped: 0,
  };
  const migrationAt = new Date().toISOString();

  // Couche 2 RNE
  if (capital.rne) {
    const patch = { ...capital.rne };
    if (!patch.rneCheckedAt) patch.rneCheckedAt = migrationAt;
    if (migrationRunId) patch.migratedFromLegacyAt = migrationAt;
    const ownedColumns = [...COUCHE2_RNE_COLUMNS, 'migratedFromLegacyAt'];
    const r = await safeMergeCoucheN({
      leadBaseClient, violationsClient, layer: 'rne',
      partitionKey, rowKey, patch, ownedColumns, logger,
    });
    result.rne = r.ok ? { merged: true, reason: null } : { merged: false, reason: r.reason };
    if (r.ok) result.totalMerged++; else result.totalSkipped++;
  } else {
    result.rne.reason = 'no_capital';
  }

  // Couche 3 Web
  if (capital.web) {
    const patch = { ...capital.web };
    if (!patch.siteWebLastCheckedAt) patch.siteWebLastCheckedAt = migrationAt;
    if (migrationRunId) patch.migratedFromLegacyAt = migrationAt;
    const ownedColumns = [...COUCHE3_WEB_COLUMNS, 'migratedFromLegacyAt'];
    const r = await safeMergeCoucheN({
      leadBaseClient, violationsClient, layer: 'siteFinder',
      partitionKey, rowKey, patch, ownedColumns, logger,
    });
    result.web = r.ok ? { merged: true, reason: null } : { merged: false, reason: r.reason };
    if (r.ok) result.totalMerged++; else result.totalSkipped++;
  } else {
    result.web.reason = 'no_capital';
  }

  // Couche 5 LinkedIn (improbable en legacy, mais trace conformité)
  if (capital.linkedIn) {
    const patch = { ...capital.linkedIn };
    if (!patch.companyLinkedInResolvedAt) patch.companyLinkedInResolvedAt = migrationAt;
    if (migrationRunId) patch.migratedFromLegacyAt = migrationAt;
    const ownedColumns = [...COUCHE5_LINKEDIN_COLUMNS, 'migratedFromLegacyAt'];
    const r = await safeMergeCoucheN({
      leadBaseClient, violationsClient, layer: 'linkedIn',
      partitionKey, rowKey, patch, ownedColumns, logger,
    });
    result.linkedIn = r.ok ? { merged: true, reason: null } : { merged: false, reason: r.reason };
    if (r.ok) result.totalMerged++; else result.totalSkipped++;
  } else {
    result.linkedIn.reason = 'no_capital';
  }

  return result;
}

module.exports = {
  extractScrapedCapital,
  migrateLegacyCapitalToV1,
  pickColumnsIfPresent,
  COUCHE2_RNE_COLUMNS,
  COUCHE3_WEB_COLUMNS,
  COUCHE5_LINKEDIN_COLUMNS,
  LEGACY_FIELD_RENAMES,
};
