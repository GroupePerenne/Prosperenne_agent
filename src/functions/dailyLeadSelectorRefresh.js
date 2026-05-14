/**
 * Timer trigger — 8h Paris L-V (TZ Romance Standard Time).
 *
 * Re-déclenche Lead Selector chaque matin pour chaque consultant actif du
 * pilote, en postant un message sur la queue `lead-selector-jobs` consommée
 * par `leadSelectorJobQueue` (pipeline complet, timeout 10 min).
 *
 * Sans ce timer, un consultant qui termine en `status=empty` (zone trop
 * restrictive ou pool LeadBase pas encore enrichi) reste bloqué jusqu'à
 * une nouvelle soumission de formulaire. Avec ce timer, le pipeline retente
 * chaque jour ouvré et profite de l'enrichissement RNE H24 du worker MacBook
 * Air (`scripts/enrich-leadbase-continuous.js`).
 *
 * Liste des consultants actifs : env vars `MORGANE_EMAIL` + `JOHNNY_EMAIL`
 * au pilote Pérenne. Future Tranche 8 : multi-tenant via Mem0 ou Storage Table.
 *
 * Inhibé via env `LEAD_SELECTOR_DISABLED=1`.
 */

'use strict';

const { app } = require('@azure/functions');
const { QueueClient } = require('@azure/storage-queue');
const { randomUUID } = require('node:crypto');
const { makeSafeLogger } = require('../../shared/safe-log');

const QUEUE_NAME = 'lead-selector-jobs';
const ACTIVE_CONSULTANT_ENV_VARS = ['MORGANE_EMAIL', 'JOHNNY_EMAIL'];

function getActiveConsultants(env = process.env) {
  return ACTIVE_CONSULTANT_ENV_VARS
    .map((name) => env[name])
    .filter((email) => typeof email === 'string' && email.includes('@'))
    .map((email) => email.toLowerCase());
}

async function postLeadSelectorJob(queueClient, consultantId, batchSize) {
  const jobId = `daily-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = JSON.stringify({
    jobId,
    consultantId,
    batchSize,
    dryRun: false,
    source: 'dailyLeadSelectorRefresh',
  });
  await queueClient.sendMessage(Buffer.from(payload).toString('base64'));
  return jobId;
}

async function handleDailyLeadSelectorRefresh(context, deps = {}) {
  const log = makeSafeLogger(context);
  const queueClientFactory = deps.queueClientFactory
    || ((cs) => new QueueClient(cs, QUEUE_NAME));

  if (process.env.LEAD_SELECTOR_DISABLED === '1') {
    log('dailyLeadSelectorRefresh skipped (LEAD_SELECTOR_DISABLED=1)');
    return { skipped: true, reason: 'disabled', posted: 0 };
  }

  const consultants = getActiveConsultants();
  if (consultants.length === 0) {
    log.warn('dailyLeadSelectorRefresh: aucun consultant actif (env vars vides)');
    return { skipped: true, reason: 'no_active_consultants', posted: 0 };
  }

  const batchSize = Number(process.env.LEAD_SELECTOR_BATCH_SIZE || 10);
  let posted = 0;
  let failed = 0;
  const jobIds = [];

  try {
    const queueClient = queueClientFactory(process.env.AzureWebJobsStorage);
    await queueClient.createIfNotExists();

    for (const consultantId of consultants) {
      try {
        const jobId = await postLeadSelectorJob(queueClient, consultantId, batchSize);
        jobIds.push({ consultantId, jobId });
        posted += 1;
        log.info('dailyLeadSelectorRefresh.queued', { jobId, consultantId });
      } catch (err) {
        failed += 1;
        log.error(`[dailyLeadSelectorRefresh] post failed for ${consultantId}: ${err.message}`);
      }
    }
  } catch (err) {
    log.error(`[dailyLeadSelectorRefresh] queue init failed: ${err.message}`);
    return { skipped: true, reason: 'queue_init_failed', posted, failed, error: err.message };
  }

  log.info('dailyLeadSelectorRefresh.done', { posted, failed, total: consultants.length });
  return { posted, failed, total: consultants.length, jobIds };
}

app.timer('dailyLeadSelectorRefresh', {
  // 8h Paris L-V — la FA a WEBSITE_TIME_ZONE=Romance Standard Time, donc le
  // cron est interprété en heure Paris locale (gère DST automatiquement).
  // Format ncrontab Azure : sec min hour day month dayOfWeek (1=lundi, 5=vendredi).
  schedule: '0 0 8 * * 1-5',
  handler: (myTimer, context) => handleDailyLeadSelectorRefresh(context),
});

module.exports = {
  handleDailyLeadSelectorRefresh,
  getActiveConsultants,
  postLeadSelectorJob,
  ACTIVE_CONSULTANT_ENV_VARS,
};
