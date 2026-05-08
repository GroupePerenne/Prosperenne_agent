'use strict';

/**
 * AirWorker Waterfall Continuous — script principal AirWorker.
 *
 * Tourne en continu (LaunchAgent macOS, KeepAlive=true) sur Mac dédié pour
 * pré-peupler la table LeadContacts avec les emails dirigeants extraits
 * des sites entreprises via Playwright (rendu JS local).
 *
 * Architecture (cf. handover passation Constantin 8 mai PM, et architecture
 * cible 8 mai PM décision Paul) :
 *   - Lit briefs consultantOnboarding (status=completed)
 *   - Calcule union filtres NAF + tranche + zone géo
 *   - Pioche batch leads SIRENE matchant filtres dans LeadBase Storage Table
 *   - Skip leads déjà résolus < 90j (cache LeadContacts fresh)
 *   - Pour chaque lead : processLead waterfall v8 complète
 *   - Écrit LeadContacts (résultat persistant)
 *   - Logs CharliBackgroundJobs + AirWorkerProgress (reprise après crash)
 *   - Sleep 30-60s entre batches, recheck briefs
 *
 * Pure code local : Storage Tables + Playwright + SMTP + Dropcontact API.
 * Aucun appel à FA Azure runtime ni Container App. La FA Azure devient
 * simple lecteur de LeadContacts pré-rempli.
 *
 * Variables d'environnement :
 *   AIRWORKER_CONCURRENCY     (défaut 2)   leads en parallèle
 *   AIRWORKER_BATCH_SIZE      (défaut 10)  taille batch
 *   AIRWORKER_SLEEP_BATCH_MS  (défaut 30000) sleep entre batches
 *   AIRWORKER_SLEEP_EMPTY_MS  (défaut 300000) sleep si pool vide (5min)
 *   AIRWORKER_DRY_RUN         (défaut '0') si '1' : pas d'écriture LeadContacts
 *   DROPCONTACT_API_KEY       requis pour étape 4 dernier recours
 *   AzureWebJobsStorage       requis pour LeadContacts/Jobs/Progress tables
 *   LEADBASE_STORAGE_CONNECTION_STRING requis pour LeadBase
 */

process.env.SITE_FINDER_WEBSEARCH_BACKENDS = process.env.SITE_FINDER_WEBSEARCH_BACKENDS || 'playwright_google';

const { TableClient } = require('@azure/data-tables');
const { chromium } = require('playwright');
const { selectCandidatesForConsultant } = require('../shared/leadSelector');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');
const { pMapLimit } = require('../shared/utils/p-map-limit');
const { processLead } = require('./airworker-process-lead');
const playwrightGoogle = require('../shared/site-finder/sources/webSearchBackends/playwrightGoogle');

const CONCURRENCY = Number(process.env.AIRWORKER_CONCURRENCY) || 2;
const BATCH_SIZE = Number(process.env.AIRWORKER_BATCH_SIZE) || 10;
const SLEEP_BATCH_MS = Number(process.env.AIRWORKER_SLEEP_BATCH_MS) || 30_000;
const SLEEP_EMPTY_MS = Number(process.env.AIRWORKER_SLEEP_EMPTY_MS) || 300_000;
const DRY_RUN = process.env.AIRWORKER_DRY_RUN === '1';

const POSITIVE_TTL_DAYS = Number(process.env.LEADCONTACTS_POSITIVE_TTL_DAYS) || 90;
const NEGATIVE_RETRY_DAYS = Number(process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS) || 7;

// ─── Storage Tables clients ────────────────────────────────────────────────

let _leadContactsClient = null;
let _consultantOnboardingClient = null;
let _backgroundJobsClient = null;
let _progressClient = null;

function getStorageConn() {
  return process.env.AzureWebJobsStorage;
}

function getLeadBaseConn() {
  return process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
}

function getLeadContactsClient() {
  if (!_leadContactsClient) {
    _leadContactsClient = TableClient.fromConnectionString(getStorageConn(), 'LeadContacts');
  }
  return _leadContactsClient;
}

function getConsultantOnboardingClient() {
  if (!_consultantOnboardingClient) {
    _consultantOnboardingClient = TableClient.fromConnectionString(getStorageConn(), 'consultantOnboarding');
  }
  return _consultantOnboardingClient;
}

function getBackgroundJobsClient() {
  if (!_backgroundJobsClient) {
    _backgroundJobsClient = TableClient.fromConnectionString(getStorageConn(), 'CharliBackgroundJobs');
  }
  return _backgroundJobsClient;
}

function getProgressClient() {
  if (!_progressClient) {
    _progressClient = TableClient.fromConnectionString(getStorageConn(), 'AirWorkerProgress');
  }
  return _progressClient;
}

async function ensureTablesExist() {
  for (const client of [getLeadContactsClient(), getBackgroundJobsClient(), getProgressClient()]) {
    try { await client.createTable(); } catch (err) { /* exists */ }
  }
}

// ─── Briefs ────────────────────────────────────────────────────────────────

async function loadActiveBriefs() {
  const client = getConsultantOnboardingClient();
  const briefs = [];
  for await (const entity of client.listEntities()) {
    let responses;
    try {
      responses = JSON.parse(entity.responses || '{}');
    } catch { continue; }
    if (responses.status === 'rejected' || !responses.email) continue;
    // Format flat compatible mapBriefToFilters
    briefs.push({
      consultantId: responses.email,
      nom: responses.display_name || responses.email,
      email: responses.email,
      secteurs: Array.isArray(responses.favorite_sectors)
        ? responses.favorite_sectors.join(',')
        : (responses.secteurs || ''),
      secteurs_autres: responses.secteurs_autres || '',
      effectif: responses.effectif || '',
      zone: responses.zone || 'default',
      zone_rayon: responses.zone_rayon || 30,
      ville: responses.ville || '',
    });
  }
  return briefs;
}

// ─── Cache LeadContacts ─────────────────────────────────────────────────────

function buildLeadContactRowKey(siren, firstName, lastName) {
  const f = String(firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = String(lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  return `email_${f}_${l}`;
}

function isFreshCacheHit(row) {
  if (!row || !row.lastVerifiedAt) return false;
  const last = Date.parse(row.lastVerifiedAt);
  if (!Number.isFinite(last)) return false;
  const ageDays = (Date.now() - last) / (24 * 3600 * 1000);
  // Negative cache hit (email=null && source=none) : retry après NEGATIVE_RETRY_DAYS
  if (!row.email && (!row.source || row.source === 'none')) {
    return ageDays <= NEGATIVE_RETRY_DAYS;
  }
  // Positive cache hit : valable POSITIVE_TTL_DAYS
  return ageDays <= POSITIVE_TTL_DAYS;
}

async function readLeadContact(siren, firstName, lastName) {
  const partitionKey = String(siren);
  const rowKey = buildLeadContactRowKey(siren, firstName, lastName);
  try {
    const entity = await getLeadContactsClient().getEntity(partitionKey, rowKey);
    return entity;
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.code || ''))) return null;
    throw err;
  }
}

async function upsertLeadContact(result) {
  if (DRY_RUN) return;
  const partitionKey = String(result.siren);
  const rowKey = buildLeadContactRowKey(result.siren, result.dirigeantName?.split(/\s+/)[0], result.dirigeantName?.split(/\s+/).slice(1).join(' '));
  const entity = {
    partitionKey,
    rowKey,
    email: result.email || null,
    confidence: Number(result.confidence) || 0,
    source: result.source || 'none',
    signals: JSON.stringify(result.signals || []),
    cost_cents: Number(result.cost_cents) || 0,
    domain: result.domain || null,
    lastVerifiedAt: new Date().toISOString(),
    elapsedMs: Number(result.elapsedMs) || 0,
  };
  try {
    await getLeadContactsClient().upsertEntity(entity, 'Replace');
  } catch (err) {
    console.warn(`[airworker] upsertLeadContact failed for ${result.siren}: ${err.message}`);
  }
}

// ─── Background jobs log ────────────────────────────────────────────────────

async function logBackgroundJob(result) {
  if (DRY_RUN) return;
  const today = new Date().toISOString().slice(0, 10);
  const partitionKey = `airworker-${today}`;
  const rowKey = `${Date.now()}_${result.siren}`;
  try {
    await getBackgroundJobsClient().upsertEntity({
      partitionKey,
      rowKey,
      siren: result.siren,
      status: result.status || 'unresolvable',
      email: result.email || null,
      confidence: Number(result.confidence) || 0,
      source: result.source || 'none',
      domain: result.domain || null,
      elapsedMs: Number(result.elapsedMs) || 0,
      timestamp: new Date().toISOString(),
    }, 'Replace');
  } catch (err) {
    console.warn(`[airworker] logBackgroundJob failed: ${err.message}`);
  }
}

// ─── Progress (reprise après crash) ────────────────────────────────────────

async function readProgress(consultantEmail) {
  try {
    const entity = await getProgressClient().getEntity('airworker-state', String(consultantEmail));
    return entity;
  } catch (err) {
    if (err && (err.statusCode === 404)) return null;
    return null;
  }
}

async function updateProgress(consultantEmail, stats) {
  if (DRY_RUN) return;
  try {
    await getProgressClient().upsertEntity({
      partitionKey: 'airworker-state',
      rowKey: String(consultantEmail),
      lastRunAt: new Date().toISOString(),
      totalProcessed: Number(stats.totalProcessed) || 0,
      totalResolved: Number(stats.totalResolved) || 0,
      totalSkippedCached: Number(stats.totalSkippedCached) || 0,
      totalErrors: Number(stats.totalErrors) || 0,
    }, 'Merge');
  } catch (err) {
    console.warn(`[airworker] updateProgress failed: ${err.message}`);
  }
}

// ─── Process batch ─────────────────────────────────────────────────────────

async function processBatchForBrief(brief, deps, stats) {
  console.log(`[airworker] briefs ${brief.email} : selectCandidatesForConsultant batch=${BATCH_SIZE}`);
  const t0 = Date.now();
  const selectorResult = await selectCandidatesForConsultant({
    brief,
    batchSize: BATCH_SIZE,
    candidateMultiplier: 1,
    consultantId: brief.email,
    briefId: brief.email,
  }).catch((err) => {
    console.warn(`[airworker] selectCandidates throw: ${err.message}`);
    return { status: 'error', candidates: [] };
  });
  const selMs = Date.now() - t0;
  console.log(`[airworker] selectCandidates done in ${Math.round(selMs / 1000)}s, status=${selectorResult.status}, count=${selectorResult.candidates?.length || 0}`);

  const candidates = (selectorResult.candidates || [])
    .filter((c) => c.firstName && c.lastName && c.companyName && /^\d{9}$/.test(String(c.siren)));
  if (candidates.length === 0) return;

  // Filtre cache : skip leads déjà fresh
  const toProcess = [];
  for (const cand of candidates) {
    const cached = await readLeadContact(cand.siren, cand.firstName, cand.lastName);
    if (cached && isFreshCacheHit(cached)) {
      stats.totalSkippedCached++;
    } else {
      toProcess.push(cand);
    }
  }
  console.log(`[airworker] ${toProcess.length}/${candidates.length} à processer (${stats.totalSkippedCached} skipped fresh cache)`);

  if (toProcess.length === 0) return;

  // Process en parallèle (concurrency configurable)
  const results = await pMapLimit(toProcess, CONCURRENCY, async (cand) => {
    try {
      const r = await processLead({
        ...cand,
        beneficiaryId: brief.email,
      }, deps);
      stats.totalProcessed++;
      if (r.status === 'ok') stats.totalResolved++;

      console.log(`[airworker] ${cand.siren} ${cand.firstName} ${cand.lastName} → ${r.status} ${r.email || '(no)'} conf=${r.confidence} src=${r.source} ${r.elapsedMs}ms`);

      await upsertLeadContact(r);
      await logBackgroundJob(r);
      return r;
    } catch (err) {
      stats.totalErrors++;
      console.warn(`[airworker] processLead failed for ${cand.siren}: ${err.message}`);
      return null;
    }
  });
  return results;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

let _shutdownRequested = false;
let _extractorBrowser = null;
let _extractorContext = null;

async function getExtractorContext() {
  if (_extractorContext) return _extractorContext;
  _extractorBrowser = await chromium.launch({ headless: true });
  _extractorContext = await _extractorBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'fr-FR',
  });
  return _extractorContext;
}

async function shutdownGracefully() {
  console.log('[airworker] shutting down...');
  try { await playwrightGoogle.closeBrowser(); } catch { /* ignore */ }
  try { if (_extractorContext) await _extractorContext.close(); } catch { /* ignore */ }
  try { if (_extractorBrowser) await _extractorBrowser.close(); } catch { /* ignore */ }
  console.log('[airworker] shutdown complete');
  process.exit(0);
}

async function mainLoop() {
  console.log(`[airworker] starting — concurrency=${CONCURRENCY}, batchSize=${BATCH_SIZE}, dryRun=${DRY_RUN}`);
  await ensureTablesExist();
  const extractorContext = await getExtractorContext();
  const dropcontactAdapter = new DropcontactAdapter();
  const deps = { extractorContext, dropcontactAdapter };

  const stats = {
    totalProcessed: 0,
    totalResolved: 0,
    totalSkippedCached: 0,
    totalErrors: 0,
  };

  while (!_shutdownRequested) {
    try {
      const briefs = await loadActiveBriefs();
      if (briefs.length === 0) {
        console.log('[airworker] no active briefs, sleep');
        await new Promise((r) => setTimeout(r, SLEEP_EMPTY_MS));
        continue;
      }

      console.log(`[airworker] cycle start, ${briefs.length} briefs actifs`);
      for (const brief of briefs) {
        if (_shutdownRequested) break;
        await processBatchForBrief(brief, deps, stats);
        await updateProgress(brief.email, stats);
        if (!_shutdownRequested) {
          await new Promise((r) => setTimeout(r, SLEEP_BATCH_MS));
        }
      }

      console.log(`[airworker] cycle done. stats: processed=${stats.totalProcessed} resolved=${stats.totalResolved} (${stats.totalProcessed > 0 ? Math.round(stats.totalResolved / stats.totalProcessed * 100) : 0}%) cached=${stats.totalSkippedCached} errors=${stats.totalErrors}`);
    } catch (err) {
      console.error(`[airworker] cycle error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 60000));
    }
  }

  await shutdownGracefully();
}

process.on('SIGTERM', () => { _shutdownRequested = true; });
process.on('SIGINT', () => { _shutdownRequested = true; });

mainLoop().catch((err) => {
  console.error('[airworker] FATAL:', err);
  process.exit(1);
});
