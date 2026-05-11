'use strict';

/**
 * Table d'idempotence des exécutions LeadSelector.
 *
 * Contexte (BL-52 incident 11 mai 2026 : 20 deals créés pour 7 prospects) :
 *   Azure Queue Storage garantit at-least-once delivery, pas at-most-once.
 *   Si leadSelectorJobQueue handler crash au milieu de launchSequenceForConsultant
 *   (post-enrichBatch, pré-fin), le message redevient visible après visibilityTimeout
 *   et un autre handler retraite — recrée tous les deals + ré-envoie tous les J0.
 *
 * Mécanisme :
 *   Avant launchSequenceForConsultant, le handler tente createEntity avec
 *   PartitionKey='run' / RowKey=`{consultantId}-{briefId|jobId}`. Insertion
 *   conflictuelle (409) → skip silencieux (un autre handler/retry travaille déjà).
 *
 * TTL stale : une entrée plus vieille que STALE_AFTER_MS est considérée comme
 * abandonnée (handler crash sans cleanup) et le retraitement est autorisé.
 * Best effort sur la cleanup automatique : on prend le risque qu'un job vraiment
 * crashé après stale soit retraité (rare, ETA <1/jour).
 *
 * Schéma :
 *   PartitionKey : 'run'
 *   RowKey       : `{consultantId}-{briefId|jobId}` (slug stable)
 *   startedAt    : ISO datetime
 *   completedAt  : ISO datetime ou null
 *   jobId        : ID du job queue
 *   consultantId : email lowercase
 *   status       : 'running' | 'completed' | 'failed'
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.LEAD_SELECTOR_RUNS_TABLE || 'LeadSelectorRuns';
const STALE_AFTER_MS = Number(process.env.LEAD_SELECTOR_RUNS_STALE_MS || 30 * 60 * 1000);

function makeRunKey(consultantId, briefId) {
  const c = String(consultantId || '').trim().toLowerCase();
  const b = String(briefId || 'no-brief').trim();
  return `${c}-${b}`.slice(0, 250);
}

/**
 * Tente d'acquérir un slot d'exécution pour ce (consultantId, briefId).
 * Retourne { acquired: true } si OK, { acquired: false, reason } si déjà pris
 * (par un handler concurrent ou retry queue) ET pas stale.
 *
 * Si une entrée stale existe, on la considère abandonnée et on l'écrase
 * via upsert mode 'Replace' pour repartir.
 */
async function tryAcquireRun({ consultantId, briefId, jobId }) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return { acquired: true, reason: 'no_storage_fallback' };
  await ensureTable(client, TABLE_NAME);

  const rowKey = makeRunKey(consultantId, briefId);
  const now = new Date().toISOString();

  // Tente createEntity (atomique : 409 si déjà existe)
  try {
    await client.createEntity({
      partitionKey: 'run',
      rowKey,
      startedAt: now,
      completedAt: null,
      jobId: String(jobId || ''),
      consultantId: String(consultantId || ''),
      status: 'running',
    });
    return { acquired: true, rowKey };
  } catch (err) {
    if (err && err.statusCode === 409) {
      // Existing entry : check si stale
      try {
        const existing = await client.getEntity('run', rowKey);
        const startedMs = Date.parse(existing.startedAt || '');
        const ageMs = Date.now() - startedMs;
        if (existing.status === 'running' && Number.isFinite(startedMs) && ageMs > STALE_AFTER_MS) {
          // Stale → on l'écrase pour relancer (etag check pour atomicité)
          await client.upsertEntity({
            partitionKey: 'run',
            rowKey,
            startedAt: now,
            completedAt: null,
            jobId: String(jobId || ''),
            consultantId: String(consultantId || ''),
            status: 'running',
            stalePreviousJobId: existing.jobId,
            staleAgeMs: ageMs,
          }, 'Replace');
          return { acquired: true, rowKey, reclaimed: true };
        }
        return { acquired: false, reason: existing.status === 'completed' ? 'already_completed' : 'already_running', rowKey };
      } catch {
        // Race : entrée supprimée entre-temps. On tente à nouveau (best effort).
        return { acquired: false, reason: 'race_check_failed', rowKey };
      }
    }
    // Erreur réseau / autre — fallback : on autorise (best effort, ne bloque pas le pipeline)
    return { acquired: true, reason: 'storage_error_fallback', error: err.message };
  }
}

/**
 * Marque le run comme terminé. Best effort, ne throw pas.
 */
async function markRunCompleted({ consultantId, briefId, success, error }) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return;
  const rowKey = makeRunKey(consultantId, briefId);
  try {
    await client.updateEntity({
      partitionKey: 'run',
      rowKey,
      completedAt: new Date().toISOString(),
      status: success ? 'completed' : 'failed',
      errorMessage: error ? String(error).slice(0, 500) : null,
    }, 'Merge');
  } catch {
    // Best effort — pas grave si update échoue
  }
}

module.exports = {
  tryAcquireRun,
  markRunCompleted,
  makeRunKey,
  // Exports pour tests :
  _STALE_AFTER_MS: STALE_AFTER_MS,
  _TABLE_NAME: TABLE_NAME,
};
