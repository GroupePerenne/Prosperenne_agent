#!/usr/bin/env node
'use strict';

/**
 * Enrichissement continu siteWeb de la LeadBase via site-finder.
 *
 * Conçu pour tourner H24 sur un MacBook Air dédié.
 * Boucle infinie qui scan LeadBase par département (IDF → AURA → PACA → reste),
 * identifie les TPE/PME (tranche 11/12/21) sans siteWeb récent,
 * appelle findWebsite() en mode batch (T1 api-gouv + T1bis heuristique ;
 * T2 websearch est gracieusement skippé si l'IP Mac Air est bloquée),
 * et écrit le résultat via writeSiteFinderResultToLeadBase().
 *
 * Capacité estimée : concurrency 8, ~2-5s/req batch → ~1-4 sites/s.
 * LeadBase IDF cibles (~60k) : ~5-15h. IDF+AURA+PACA : ~20-50h.
 *
 * Usage :
 *   node scripts/enrich-sites-continuous.js
 *
 * Variables d'environnement :
 *   LEADBASE_STORAGE_CONNECTION_STRING  (requis)
 *   SITE_ENRICH_CONCURRENCY=8          (défaut)
 *   SITE_ENRICH_BATCH_SIZE=200         (défaut)
 *   SITE_ENRICH_SLEEP_MS=500           (défaut, entre chaque slice de concurrency)
 *   SITE_ENRICH_PROGRESS_INTERVAL=100  (défaut, log toutes les N entités scannées)
 *   SITE_ENRICH_TTL_DAYS=30            (défaut, re-check après N jours)
 *
 * Run en background sur Mac :
 *   nohup node scripts/enrich-sites-continuous.js > /tmp/enrich-sites.log 2>&1 &
 */

const fs = require('fs');
const path = require('path');

// Non-overwrite : les vars passées en CLI priment sur local.settings.json
const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const [k, v] of Object.entries(s.Values || {})) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* best effort */ }
}

const CONNECTION = process.env.LEADBASE_STORAGE_CONNECTION_STRING;
if (!CONNECTION) {
  console.error('[enrich-sites] LEADBASE_STORAGE_CONNECTION_STRING manquant');
  process.exit(1);
}

const { TableClient } = require('@azure/data-tables');
const { findWebsite } = require('../shared/site-finder/index');
const {
  writeSiteFinderResultToLeadBase,
  writeEmailResultToLeadBase,
} = require('../shared/site-finder/writers/leadbaseWriter');
const { scrapeDomain, isJunkEmail } = require('../shared/lead-exhauster/scraping');

const TABLE_NAME = process.env.LEADBASE_TABLE || 'LeadBase';
const CONCURRENCY = Number(process.env.SITE_ENRICH_CONCURRENCY || 8);
const BATCH_SIZE = Number(process.env.SITE_ENRICH_BATCH_SIZE || 200);
const SLEEP_MS = Number(process.env.SITE_ENRICH_SLEEP_MS || 500);
const PROGRESS_INTERVAL = Number(process.env.SITE_ENRICH_PROGRESS_INTERVAL || 100);
const TTL_DAYS = Number(process.env.SITE_ENRICH_TTL_DAYS || 30);

// Tranches effectif cibles TPE/PME : 10-19, 20-49, 50-99 salariés
const TARGET_TRANCHES = new Set(['11', '12', '21']);

// Ordre de priorité des partitions : IDF → AURA → PACA → reste France + DOM
const PRIORITY_PARTITIONS = [
  // IDF
  '75', '77', '78', '91', '92', '93', '94', '95',
  // AURA
  '01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74',
  // PACA
  '04', '05', '06', '13', '83', '84',
  // Reste France métropolitaine
  '02', '08', '09', '10', '11', '12', '14', '16', '17', '18', '19',
  '21', '22', '23', '24', '25', '27', '28', '29', '2A', '2B',
  '30', '31', '32', '33', '34', '35', '36', '37', '39', '40', '41',
  '44', '45', '46', '47', '48', '49',
  '50', '51', '52', '53', '54', '55', '56', '57', '58',
  '59', '60', '61', '62', '64', '65', '66', '67', '68',
  '70', '71', '72', '76', '79', '80', '81', '82', '85', '86', '87', '88', '89', '90',
  // DOM
  '971', '972', '973', '974', '976',
];

const tableClient = TableClient.fromConnectionString(CONNECTION, TABLE_NAME);

const stats = {
  startedAt: new Date(),
  scanned: 0,
  skipped: 0,
  attempted: 0,
  found: 0,
  notFound: 0,
  errors: 0,
  emailsFound: 0,
  emailsNotFound: 0,
  emailErrors: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function isExpired(iso) {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > TTL_DAYS * 24 * 3600 * 1000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDirigeantName(dirigeantsJson) {
  if (!dirigeantsJson) return null;
  try {
    const arr = JSON.parse(dirigeantsJson);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const d = arr[0];
    const parts = [String(d.prenoms || '').trim(), String(d.nom || '').trim()].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  } catch {
    return null;
  }
}

function extractDirigeantParts(dirigeantsJson) {
  if (!dirigeantsJson) return { firstName: '', lastName: '' };
  try {
    const arr = JSON.parse(dirigeantsJson);
    if (!Array.isArray(arr) || arr.length === 0) return { firstName: '', lastName: '' };
    const d = arr[0];
    return {
      firstName: String(d.prenoms || '').trim(),
      lastName: String(d.nom || '').trim(),
    };
  } catch {
    return { firstName: '', lastName: '' };
  }
}

async function scrapeEmailForSite(siren, siteUrl, entity, pk) {
  let domain;
  try {
    domain = new URL(siteUrl).hostname;
  } catch {
    stats.emailErrors++;
    return;
  }

  const { firstName, lastName } = extractDirigeantParts(entity.dirigeants);

  let scrapeResult;
  try {
    scrapeResult = await scrapeDomain(
      { domain, firstName, lastName },
      { globalTimeoutMs: 12000, pageTimeoutMs: 4000, maxEmails: 10 },
    );
  } catch (err) {
    stats.emailErrors++;
    console.warn(`[enrich-sites] scrapeDomain error ${siren}: ${err.message}`);
    return;
  }

  const emails = Array.isArray(scrapeResult.emails) ? scrapeResult.emails : [];
  const best = emails.find((e) => !isJunkEmail(e.email));
  if (!best) {
    stats.emailsNotFound++;
    return;
  }

  const ok = await writeEmailResultToLeadBase(siren, {
    email: best.email,
    confidence: best.confidence,
    source: 'airworker_scrape',
  }, { partitionKey: pk });

  if (ok) stats.emailsFound++;
  else stats.emailErrors++;
}

async function processOne(entity) {
  const siren = String(entity.rowKey || entity.RowKey || entity.siren || '');
  if (!siren || !/^\d{9}$/.test(siren)) return;

  const tranche = String(entity.trancheEffectif || '').trim();
  if (!TARGET_TRANCHES.has(tranche)) {
    stats.skipped++;
    return;
  }

  if (!isExpired(entity.siteWebLastCheckedAt)) {
    stats.skipped++;
    return;
  }

  stats.attempted++;
  const pk = String(entity.partitionKey || entity.PartitionKey || '');
  const dirigeantName = extractDirigeantName(entity.dirigeants);

  let result;
  try {
    result = await findWebsite({
      siren,
      companyName: entity.nom || '',
      ville: entity.ville || '',
      dirigeantName,
      options: { mode: 'batch' },
    });
  } catch (err) {
    stats.errors++;
    console.warn(`[enrich-sites] findWebsite error ${siren}: ${err.message}`);
    return;
  }

  const ok = await writeSiteFinderResultToLeadBase(siren, result, { partitionKey: pk });
  if (!ok) {
    stats.errors++;
    return;
  }
  if (result && result.siteUrl) {
    stats.found++;
    await scrapeEmailForSite(siren, result.siteUrl, entity, pk);
  } else {
    stats.notFound++;
  }
}

async function processBatch(entities) {
  for (let i = 0; i < entities.length; i += CONCURRENCY) {
    const slice = entities.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(processOne));
    stats.scanned += slice.length;
    if (stats.scanned % PROGRESS_INTERVAL < CONCURRENCY) logProgress();
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }
}

function logProgress() {
  const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000;
  const rate = stats.attempted / Math.max(elapsed, 1);
  const findRate = stats.attempted > 0 ? Math.round(100 * stats.found / stats.attempted) : 0;
  const emailRate = stats.found > 0 ? Math.round(100 * stats.emailsFound / stats.found) : 0;
  console.log(
    `[${nowIso()}] scanned=${stats.scanned} attempted=${stats.attempted}` +
    ` found=${stats.found} (${findRate}%) notFound=${stats.notFound}` +
    ` skipped=${stats.skipped} errors=${stats.errors} rate=${rate.toFixed(2)} req/s` +
    ` | emails: found=${stats.emailsFound} (${emailRate}% of sites) notFound=${stats.emailsNotFound} errors=${stats.emailErrors}`,
  );
}

async function* iteratePartition(dept) {
  const pk = dept.replace(/'/g, "''");
  // Filtrer server-side sur les tranches cibles — évite de paginer des millions
  // d'entrées hors-cible (ex: partition 75 = 1M+ entrées dont 98% tranche NN).
  const filter = `PartitionKey eq '${pk}' and (trancheEffectif eq '11' or trancheEffectif eq '12' or trancheEffectif eq '21')`;
  const iter = tableClient.listEntities({
    queryOptions: {
      filter,
      select: [
        'PartitionKey', 'RowKey', 'siren', 'nom', 'ville',
        'trancheEffectif', 'dirigeants', 'siteWebLastCheckedAt',
      ],
    },
  });
  let buffer = [];
  for await (const e of iter) {
    buffer.push(e);
    if (buffer.length >= BATCH_SIZE) {
      yield buffer;
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function main() {
  console.log(`[enrich-sites] démarrage ${nowIso()}`);
  console.log(`  concurrency=${CONCURRENCY} batch=${BATCH_SIZE} sleep=${SLEEP_MS}ms ttl=${TTL_DAYS}j`);
  console.log(`  tranches cibles: ${[...TARGET_TRANCHES].join(',')}`);
  console.log(`  ${PRIORITY_PARTITIONS.length} partitions à scanner (IDF → AURA → PACA → reste)`);
  console.log('  Boucle infinie. Ctrl+C pour arrêter.\n');

  while (true) {
    try {
      for (const dept of PRIORITY_PARTITIONS) {
        console.log(`[${nowIso()}] → partition ${dept}`);
        for await (const batch of iteratePartition(dept)) {
          await processBatch(batch);
        }
      }
      console.log(`[${nowIso()}] tour complet terminé. Pause 120s avant restart.`);
      logProgress();
      await sleep(120000);
    } catch (err) {
      console.error(`[${nowIso()}] erreur top-level: ${err.message}`);
      console.error(err.stack);
      await sleep(30000);
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[enrich-sites] arrêt demandé');
  logProgress();
  process.exit(0);
});

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
