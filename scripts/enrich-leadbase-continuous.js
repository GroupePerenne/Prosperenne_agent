#!/usr/bin/env node
'use strict';

/**
 * Enrichissement continu de la LeadBase via API RNE.
 *
 * Conçu pour tourner H24 sur un MacBook Air dédié (worker Constantin).
 * Boucle infinie qui scan LeadBase, identifie les SIRENs sans dirigeant
 * exploitable, fetch l'API gouv.fr (free, no auth) en parallèle modéré
 * (concurrency 8, sleep 1s entre batches), met à jour LeadBase avec
 * dirigeants enrichis OU marqueur "no_match" pour ne pas re-fetch.
 *
 * Capacité estimée : ~10 req/s respectueux → ~36k SIRENs/heure → ~864k/jour
 * → LeadBase 12.8M complète en ~15 jours, puis maintenance différentielle
 * sur les ajouts.
 *
 * Usage :
 *   node scripts/enrich-leadbase-continuous.js
 *
 * Variables d'environnement :
 *   LEADBASE_STORAGE_CONNECTION_STRING (requis)
 *   ENRICH_CONCURRENCY=8 (défaut)
 *   ENRICH_BATCH_SIZE=200 (défaut, taille de chaque scan LeadBase)
 *   ENRICH_SLEEP_BETWEEN_BATCHES_MS=1000 (défaut, courtoisie API gouv.fr)
 *   ENRICH_PROGRESS_LOG_INTERVAL=50 (défaut, log toutes les N entités)
 *
 * Schéma :
 *   - Pour chaque entité LeadBase avec dirigeants=null :
 *     - GET https://recherche-entreprises.api.gouv.fr/search?q={siren}
 *     - Si dirigeants trouvés → Merge l'entité avec dirigeants JSON
 *     - Si aucun match → Merge avec dirigeants=[] et un flag rne_checked_at
 *   - Cache sur le flag rne_checked_at : skip les entités déjà tentées
 *     dans les 30 derniers jours (évite re-fetch infini sur SIRENs morts)
 *
 * Run en background sur Mac :
 *   nohup node scripts/enrich-leadbase-continuous.js > /tmp/enrich.log 2>&1 &
 * Ou via launchctl plist (cf. README pour template).
 */

const fs = require('fs');
const path = require('path');

// Charge env depuis local.settings.json si présent (dev local) sinon depuis env
const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  Object.assign(process.env, settings.Values || {});
}

const { TableClient } = require('@azure/data-tables');

const CONNECTION = process.env.LEADBASE_STORAGE_CONNECTION_STRING;
if (!CONNECTION) {
  console.error('LEADBASE_STORAGE_CONNECTION_STRING manquant');
  process.exit(1);
}

const RNE_API_BASE = 'https://recherche-entreprises.api.gouv.fr';
const TABLE_NAME = 'LeadBase';
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || 8);
const BATCH_SIZE = Number(process.env.ENRICH_BATCH_SIZE || 200);
const SLEEP_MS = Number(process.env.ENRICH_SLEEP_BETWEEN_BATCHES_MS || 1000);
const PROGRESS_INTERVAL = Number(process.env.ENRICH_PROGRESS_LOG_INTERVAL || 50);
const RNE_CHECK_TTL_DAYS = Number(process.env.RNE_CHECK_TTL_DAYS || 30);
const FETCH_TIMEOUT_MS = 6000;

const tableClient = TableClient.fromConnectionString(CONNECTION, TABLE_NAME);

// Stats globales (rolling)
const stats = {
  startedAt: new Date(),
  scanned: 0,
  enriched: 0,
  noMatch: 0,
  errors: 0,
  skippedAlreadyChecked: 0,
};

function nowIso() {
  return new Date().toISOString();
}

function isExpired(iso) {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > RNE_CHECK_TTL_DAYS * 24 * 3600 * 1000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDirigeantsRNE(siren) {
  let res;
  try {
    res = await fetch(
      `${RNE_API_BASE}/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
  } catch {
    return { error: 'fetch_failed' };
  }
  if (res.status === 429) return { error: 'rate_limit' };
  if (!res.ok) return { error: `http_${res.status}` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { error: 'parse_failed' };
  }
  const r = (data.results || [])[0];
  if (!r || String(r.siren) !== siren) return { dirigeants: [] };

  const pp = (r.dirigeants || []).filter(
    (d) => d.type_dirigeant === 'personne physique' && (d.prenoms || d.nom),
  );

  return {
    dirigeants: pp.map((d) => ({
      prenoms: String(d.prenoms || '').trim(),
      nom: String(d.nom || '').trim(),
      qualite: String(d.qualite || '').trim(),
      fonction: String(d.qualite || '').trim(),
      role: String(d.qualite || '').trim(),
      type_dirigeant: 'personne physique',
      annee_de_naissance: d.annee_de_naissance,
    })),
  };
}

async function processOne(entity) {
  if (!entity.siren) return null;
  // Skip déjà checked récemment
  if (entity.rne_checked_at && !isExpired(entity.rne_checked_at)) {
    stats.skippedAlreadyChecked++;
    return null;
  }
  // Skip si dirigeants déjà présents
  if (entity.dirigeants) {
    try {
      const parsed = JSON.parse(entity.dirigeants);
      if (Array.isArray(parsed) && parsed.length > 0) return null;
    } catch {
      /* malformed → re-fetch */
    }
  }

  const result = await fetchDirigeantsRNE(String(entity.siren));
  if (result.error) {
    stats.errors++;
    if (result.error === 'rate_limit') await sleep(5000);
    return null;
  }
  const dirigeants = result.dirigeants;

  // Update entité
  try {
    await tableClient.updateEntity(
      {
        partitionKey: entity.partitionKey,
        rowKey: entity.rowKey,
        dirigeants: JSON.stringify(dirigeants),
        rne_checked_at: nowIso(),
        rne_dirigeants_count: dirigeants.length,
      },
      'Merge',
    );
    if (dirigeants.length > 0) stats.enriched++;
    else stats.noMatch++;
  } catch (err) {
    stats.errors++;
    console.warn(`update fail ${entity.siren}: ${err.message}`);
  }
}

async function processBatch(entities) {
  for (let i = 0; i < entities.length; i += CONCURRENCY) {
    const slice = entities.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(processOne));
    stats.scanned += slice.length;
    if (stats.scanned % PROGRESS_INTERVAL < CONCURRENCY) logProgress();
  }
}

function logProgress() {
  const elapsed = (Date.now() - stats.startedAt.getTime()) / 1000;
  const rate = stats.scanned / elapsed;
  console.log(
    `[${new Date().toISOString()}] scanned=${stats.scanned} enriched=${stats.enriched} (${
      stats.scanned > 0 ? Math.round((100 * stats.enriched) / stats.scanned) : 0
    }%) noMatch=${stats.noMatch} skipped=${stats.skippedAlreadyChecked} errors=${
      stats.errors
    } rate=${rate.toFixed(1)}/s`,
  );
}

async function* iterateLeadBase() {
  // listEntities streaming avec discriminant I-2 : ne lit que les entrées v1
  // conformes (schema_version='1.0'). Le legacy 12,8M sans schema_version est
  // ignoré — il sera promu via le cron SIRENE bulk France entière mensuel.
  const iter = tableClient.listEntities({
    queryOptions: {
      filter: "schema_version eq '1.0'",
      // Fetch entités avec dirigeants null OU rneCheckedAt expiré.
      // Note v1 : rneCheckedAt camelCase (post migration Bloc 3). Pendant
      // les 30j de rétrocompat, on lit aussi rne_checked_at legacy.
      select: ['partitionKey', 'rowKey', 'siren', 'dirigeants', 'rneCheckedAt', 'rne_checked_at', 'schema_version'],
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
  console.log(`[enrich-leadbase] starting at ${nowIso()}`);
  console.log(
    `  config: concurrency=${CONCURRENCY}, batch=${BATCH_SIZE}, sleep=${SLEEP_MS}ms, rne_ttl=${RNE_CHECK_TTL_DAYS}d`,
  );
  console.log('  Boucle infinie. Ctrl+C pour arrêter.');
  console.log();

  // Loop infinie : à la fin du scan complet, repart au début (les entités
  // expirées sont automatiquement re-tentées via TTL rne_checked_at).
  while (true) {
    try {
      for await (const batch of iterateLeadBase()) {
        await processBatch(batch);
        if (SLEEP_MS > 0) await sleep(SLEEP_MS);
      }
      console.log(`[${nowIso()}] scan complet terminé. Restart dans 60s.`);
      logProgress();
      await sleep(60000);
    } catch (err) {
      console.error(`[${nowIso()}] erreur top-level: ${err.message}`);
      console.error(err.stack);
      await sleep(30000); // backoff
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n[enrich-leadbase] arrêt demandé');
  logProgress();
  process.exit(0);
});

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
