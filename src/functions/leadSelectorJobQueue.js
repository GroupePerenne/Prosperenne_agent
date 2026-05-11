/**
 * Queue trigger leadSelectorJobQueue — exécute le pipeline Lead Selector
 * complet en background, sans contrainte HTTP timeout (230s Front Door).
 *
 * Né de l'incident 4 mai 2026 PM : runLeadSelectorForConsultant en mode
 * synchrone HTTP timeout 504 sur les vrais runs (scan LeadBase + Dropcontact
 * + sequence Martin/Mila > 230s pour les briefs grandes zones).
 *
 * Pattern :
 *   1. PWA / endpoint HTTP poste un message JSON dans la queue
 *      lead-selector-jobs : { jobId, consultantId, batchSize, dryRun }
 *   2. Ce handler queue trigger consomme, exécute le pipeline, persiste
 *      le résultat en Storage Table leadSelectorJobs.
 *   3. Linux Consumption timeout queue trigger = 10 min par défaut
 *      (fonction host.json functionTimeout 5min couvre largement).
 *   4. La PWA peut polller GET /api/getLeadSelectorJobStatus?jobId=X.
 */

'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { enrichAndProfileBatchForConsultant } = require('../../shared/enrichAndProfileBatch');
const { launchSequenceForConsultant } = require('../../agents/david/orchestrator');
const { loadConsultantBrief } = require('../../shared/consultant-brief-loader');
const { makeSafeLogger } = require('../../shared/safe-log');
const { tryAcquireRun, markRunCompleted } = require('../../shared/storage-tables/leadSelectorRuns');

const TABLE_NAME = 'leadSelectorJobs';

app.storageQueue('leadSelectorJobQueue', {
  queueName: 'lead-selector-jobs',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    const log = makeSafeLogger(context);
    let job;
    try {
      job = typeof queueItem === 'string' ? JSON.parse(queueItem) : queueItem;
    } catch (err) {
      log.warn(`[lead-selector-job] cannot parse queue item: ${err.message}`);
      return;
    }
    const { jobId, consultantId, batchSize = 10, dryRun = false } = job;
    if (!jobId || !consultantId) {
      log.warn('[lead-selector-job] jobId/consultantId requis');
      return;
    }

    log(`[lead-selector-job] starting jobId=${jobId} consultantId=${consultantId} batch=${batchSize} dryRun=${dryRun}`);
    const tableClient = getJobsTable();
    if (tableClient) await markStatus(tableClient, jobId, 'running');

    // BL-52 (11 mai 2026) — Idempotence at-least-once delivery.
    // Azure Queue Storage peut redélivrer le message si le handler crash entre
    // enrichBatch et fin de launchSequence. Sans guard, on retraite tout →
    // doublons deals Pipedrive + ré-envoi J0 prospects. Le briefId du brief
    // consultant est la clé naturelle (1 brief = 1 run unique). On garde le
    // jobId comme fallback si pas de briefId (anciens triggers manuels).
    const briefId = (job.briefId || consultantId).toString();
    const runAcquire = await tryAcquireRun({ consultantId, briefId, jobId });
    if (!runAcquire.acquired) {
      log(`[lead-selector-job] idempotence skip jobId=${jobId} consultantId=${consultantId} briefId=${briefId} reason=${runAcquire.reason}`);
      await markStatus(tableClient, jobId, 'skipped_duplicate', { reason: runAcquire.reason, briefId });
      return;
    }
    if (runAcquire.reclaimed) {
      log.warn(`[lead-selector-job] reclaimed stale run jobId=${jobId} briefId=${briefId} — previous handler abandoned`);
    }

    try {
      const consultantPayload = await loadConsultantBrief(consultantId, context);
      if (!consultantPayload) {
        await markStatus(tableClient, jobId, 'error', { error: 'consultant_brief_missing' });
        await markRunCompleted({ consultantId, briefId, success: false, error: 'consultant_brief_missing' });
        return;
      }

      const result = await enrichAndProfileBatchForConsultant({
        brief: consultantPayload.originalBrief,
        beneficiaryId: consultantPayload.beneficiaryId,
        batchSize,
        dryRun: Boolean(dryRun),
        consultantId,
        context,
      });

      const summary = {
        status: result.status,
        candidatesConsidered: result.meta?.candidatesConsidered || 0,
        leadsCount: (result.leads || []).length,
        resolutionOk: result.meta?.resolutionOk || 0,
        unresolvable: result.meta?.resolutionUnresolvable || 0,
        costCentsTotal: result.meta?.costCentsTotal || 0,
      };

      log(`[lead-selector-job] enrich-summary jobId=${jobId} status=${summary.status} candidatesConsidered=${summary.candidatesConsidered} leadsCount=${summary.leadsCount} resolutionOk=${summary.resolutionOk} unresolvable=${summary.unresolvable} costCents=${summary.costCentsTotal}`);

      if (dryRun || result.status === 'error' || result.status === 'empty') {
        // empty / error → no-op silencieux. Le worker MacBook Air enrichit
        // LeadBase en parallèle (RNE H24) et le timer dailyLeadSelectorRefresh
        // re-déclenche chaque matin L-V. On agit avec ce qu'on a, sinon on
        // attend demain. Pas de mail "base à affiner" au consultant
        // (directive Paul 5 mai 2026 : David ne raconte pas sa vie).
        log(`[lead-selector-job] done jobId=${jobId} branch=empty_or_error status=${result.status} sequenceLaunched=false`);
        await markStatus(tableClient, jobId, 'done', { ...summary, sequenceLaunched: false });
        await markRunCompleted({ consultantId, briefId, success: true });
        return;
      }

      // insufficient → on lance la séquence sur les leads partiels
      // disponibles (David agit avec ce qu'il a). Pas de mail "base à
      // affiner" au consultant — directive Paul 5 mai 2026.

      // Lancement séquence Martin/Mila sur les leads enrichis
      log(`[lead-selector-job] launching-sequence jobId=${jobId} status=${result.status} leads=${(result.leads||[]).length}`);
      const seqResults = await launchSequenceForConsultant({
        consultant: consultantPayload.consultant,
        brief: consultantPayload.brief,
        leads: result.leads,
        context,
      });
      const okCount = seqResults.filter((r) => !r.error).length;
      const errorCount = seqResults.length - okCount;

      log(`[lead-selector-job] done jobId=${jobId} → ${okCount} ok / ${errorCount} errors / ${result.leads.length} leads`);
      await markStatus(tableClient, jobId, 'done', {
        ...summary,
        sequenceLaunched: true,
        sequenceOk: okCount,
        sequenceErrors: errorCount,
      });
      await markRunCompleted({ consultantId, briefId, success: true });
    } catch (err) {
      log.error(`[lead-selector-job] exception: ${err.message}`, err);
      await markStatus(tableClient, jobId, 'error', { error: err.message });
      await markRunCompleted({ consultantId, briefId, success: false, error: err.message });
      throw err; // BL-52 : laisser remonter pour que la queue retry. La guard
      // tryAcquireRun ci-dessus protège contre le retraitement intempestif.
    }
  },
});

function getJobsTable() {
  const cs = process.env.AzureWebJobsStorage;
  if (!cs) return null;
  try {
    return TableClient.fromConnectionString(cs, TABLE_NAME);
  } catch {
    return null;
  }
}

async function markStatus(tableClient, jobId, status, extra = {}) {
  if (!tableClient) return;
  try {
    await tableClient.createTable().catch(() => {});
    await tableClient.upsertEntity(
      {
        partitionKey: new Date().toISOString().slice(0, 10),
        rowKey: jobId,
        jobId,
        status,
        updatedAt: new Date().toISOString(),
        ...flattenForTable(extra),
      },
      'Merge',
    );
  } catch {
    // best effort
  }
}

function flattenForTable(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 32000);
    else out[k] = v;
  }
  return out;
}

