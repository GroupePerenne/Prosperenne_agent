'use strict';

/**
 * Writer LeadBase Merge idempotent pour les entités issues du dump SIRENE.
 *
 * Stratégie :
 *   - Si SIREN absent de LeadBase → CreateEntity
 *   - Si SIREN présent → Merge sur les colonnes SIRENE uniquement, sans
 *     toucher aux colonnes peuplées par d'autres workers (siteWeb, dirigeants
 *     RNE, emailDirigeant, sites enrichis par AirWorker site-finder).
 *   - Audit dans table SireneIngestionRuns : runId, départements, compteurs,
 *     timing.
 *
 * Cohérent doctrine docs/SIRENE_INGESTION_v1.md.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_LEADBASE = process.env.LEADBASE_TABLE || 'LeadBase';
const TABLE_RUNS = process.env.SIRENE_RUNS_TABLE || 'SireneIngestionRuns';

// Colonnes SIRENE : seules ces colonnes sont touchées par le writer SIRENE.
// Toute autre colonne dans la ligne LeadBase existante est préservée intacte.
const SIRENE_OWNED_COLUMNS = Object.freeze([
  'siren',
  'nom',
  'sigle',
  'codeNaf',
  'categorieJuridique',
  'trancheEffectif',
  'trancheEffectifLabel',
  'adresse',
  'codePostal',
  'ville',
  'dateCreation',
  'prenomDirigeant',
  'nomDirigeant',
  'sireneSourcedAt',
  'sireneSnapshotVersion',
  'sireneRunId',
]);

let _leadBaseClient = null;
let _runsClient = null;

function getLeadBaseClient() {
  if (_leadBaseClient) return _leadBaseClient;
  const conn = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _leadBaseClient = TableClient.fromConnectionString(conn, TABLE_LEADBASE);
    return _leadBaseClient;
  } catch {
    return null;
  }
}

function getRunsClient() {
  if (_runsClient) return _runsClient;
  const conn = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _runsClient = TableClient.fromConnectionString(conn, TABLE_RUNS);
    return _runsClient;
  } catch {
    return null;
  }
}

async function ensureTable(client) {
  if (!client) return;
  try {
    await client.createTable();
  } catch {
    // déjà créée ou autre, on ignore
  }
}

/**
 * Pick les colonnes SIRENE owned d'une entité mappée.
 * partitionKey + rowKey toujours inclus.
 */
function pickSireneColumns(entity) {
  const out = {
    partitionKey: entity.partitionKey,
    rowKey: entity.rowKey,
  };
  for (const k of SIRENE_OWNED_COLUMNS) {
    if (entity[k] !== undefined && entity[k] !== null) out[k] = entity[k];
  }
  return out;
}

/**
 * Détecte si une entité est inchangée vs sa version SIRENE actuelle (idempotence).
 * Comparaison sur les colonnes owned uniquement, hors timestamps de run.
 */
function isUnchanged(existing, fresh) {
  if (!existing) return false;
  const skipFields = new Set(['sireneSourcedAt', 'sireneRunId']);
  for (const k of SIRENE_OWNED_COLUMNS) {
    if (skipFields.has(k)) continue;
    const a = existing[k];
    const b = fresh[k];
    if ((a === undefined || a === null) && (b === undefined || b === null)) continue;
    if (String(a || '') !== String(b || '')) return false;
  }
  return true;
}

/**
 * Écrit une entité dans LeadBase. Crée si absent, merge si présent.
 * Préserve les colonnes hors SIRENE_OWNED_COLUMNS si l'entité existe.
 *
 * @param {Object} entity                Entité issue du mapper
 * @param {Object} [opts]
 * @param {Object} [opts.client]         Override TableClient (tests)
 * @returns {Promise<{ status: 'created'|'updated'|'skipped'|'error', error?:string }>}
 */
async function writeEntity(entity, opts = {}) {
  const client = opts.client || getLeadBaseClient();
  if (!client) return { status: 'error', error: 'no_storage_client' };
  if (!entity || !entity.partitionKey || !entity.rowKey) {
    return { status: 'error', error: 'invalid_entity' };
  }

  const fresh = pickSireneColumns(entity);
  let existing;
  try {
    existing = await client.getEntity(entity.partitionKey, entity.rowKey);
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
      existing = null;
    } else {
      return { status: 'error', error: `read_failed: ${err && err.message}` };
    }
  }

  if (!existing) {
    try {
      await client.createEntity(fresh);
      return { status: 'created' };
    } catch (err) {
      return { status: 'error', error: `create_failed: ${err && err.message}` };
    }
  }

  if (isUnchanged(existing, fresh)) {
    return { status: 'skipped' };
  }

  try {
    await client.updateEntity(fresh, 'Merge', { etag: existing.etag });
    return { status: 'updated' };
  } catch (err) {
    return { status: 'error', error: `update_failed: ${err && err.message}` };
  }
}

/**
 * Persiste un audit run dans SireneIngestionRuns.
 *
 * @param {Object} run
 * @param {string} run.runId
 * @param {string} run.startedAt
 * @param {string} [run.endedAt]
 * @param {string[]} run.departements
 * @param {string} [run.snapshotVersion]
 * @param {Object}  run.counters       { created, updated, skipped, error }
 * @param {string[]} [run.tranches]
 * @param {string} [run.mode]          'strict' | 'large'
 * @param {boolean} [run.dryRun]
 * @returns {Promise<boolean>}
 */
async function writeRun(run, opts = {}) {
  const client = opts.client || getRunsClient();
  if (!client) return false;
  await ensureTable(client);
  try {
    const partitionKey = (run.startedAt || new Date().toISOString()).slice(0, 10);
    const rowKey = run.runId;
    const counters = run.counters || {};
    await client.upsertEntity({
      partitionKey,
      rowKey,
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      departements: JSON.stringify(run.departements || []),
      snapshotVersion: run.snapshotVersion,
      tranches: JSON.stringify(run.tranches || []),
      mode: run.mode || 'strict',
      dryRun: Boolean(run.dryRun),
      entitiesCreated: Number(counters.created) || 0,
      entitiesUpdated: Number(counters.updated) || 0,
      entitiesSkipped: Number(counters.skipped) || 0,
      entitiesError: Number(counters.error) || 0,
      bytesDownloaded: Number(run.bytesDownloaded) || 0,
    }, 'Merge');
    return true;
  } catch {
    return false;
  }
}

function _resetForTests() {
  _leadBaseClient = null;
  _runsClient = null;
}

module.exports = {
  writeEntity,
  writeRun,
  pickSireneColumns,
  isUnchanged,
  SIRENE_OWNED_COLUMNS,
  TABLE_LEADBASE,
  TABLE_RUNS,
  _resetForTests,
};
