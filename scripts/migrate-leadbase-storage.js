#!/usr/bin/env node
'use strict';

/**
 * Migration tables LeadBase + LeadSelectorTrace de oseysjeannotst vers
 * pereneoleadsst (Sprint 1 Variante A, décision Paul 2026-04-28).
 *
 * Modes :
 *   --dry-run             Itère lecture source, n'écrit pas, distribution PK
 *   --sample N            Lit N entités source, écrit sur cible (upsert), bench
 *   --table NAME          Limite à une table (LeadBase | LeadSelectorTrace)
 *   --resume              Reprise après interruption (upsert + checkpoint)
 *   --skip-conflicts      En mode full run, n'abort pas sur 409 (skip + log)
 *   --source-cs / --target-cs   Override CLI (priorité sur env / KV)
 *
 * Cascade cs (par sens) :
 *   1) --source-cs / --target-cs CLI
 *   2) MIGRATION_SOURCE_CS / MIGRATION_TARGET_CS env
 *   3) KV pereneo-prod-kv : OSEYSJEANNOT-STORAGE-CS / LEADBASE-STORAGE-CS
 *
 * R-CRED : connection strings jamais loggées en clair, masquage AccountName only.
 *
 * Tables migrées : LeadBase, LeadSelectorTrace.
 * NON migrée (D3 Paul 2026-04-28) : ScanStatus.
 */

const { TableClient } = require('@azure/data-tables');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Constantes ─────────────────────────────────────────────────────────────
const TABLES_ALLOWED = ['LeadBase', 'LeadSelectorTrace'];
const BATCH_SIZE = 100; // limite Azure submitTransaction
const PROGRESS_INTERVAL = 10000;
const MAX_RETRIES = 5;
const KV_NAME = 'pereneo-prod-kv';
const KV_SOURCE_SECRET = 'OSEYSJEANNOT-STORAGE-CS';
const KV_TARGET_SECRET = 'LEADBASE-STORAGE-CS';
const CHECKPOINT_FILE = path.resolve(__dirname, '..', '.migration-checkpoint.json');

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    dryRun: false,
    sample: null,
    table: null,
    resume: false,
    skipConflicts: false,
    sourceCs: null,
    targetCs: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (a === '--table') args.table = argv[++i];
    else if (a === '--resume') args.resume = true;
    else if (a === '--skip-conflicts') args.skipConflicts = true;
    else if (a === '--source-cs') args.sourceCs = argv[++i];
    else if (a === '--target-cs') args.targetCs = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Argument inconnu : ${a}\n`);
      printHelp();
      process.exit(1);
    }
  }
  if (args.table && !TABLES_ALLOWED.includes(args.table)) {
    console.error(`--table invalide : ${args.table}. Autorisées : ${TABLES_ALLOWED.join(', ')}`);
    process.exit(1);
  }
  if (args.sample !== null && (!Number.isFinite(args.sample) || args.sample <= 0)) {
    console.error(`--sample doit être un entier positif (reçu : ${args.sample})`);
    process.exit(1);
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/migrate-leadbase-storage.js [options]

Options :
  --dry-run                 Lecture seule, log distribution PartitionKey
  --sample N                Migre N premières entités (upsert), mesure débit
  --table NAME              LeadBase | LeadSelectorTrace (défaut : les deux)
  --resume                  Reprise après interruption via checkpoint
  --skip-conflicts          Tolère 409 en full run (sinon abort)
  --source-cs <cs>          Override CS source
  --target-cs <cs>          Override CS cible
  -h, --help                Cette aide

Exemples :
  node scripts/migrate-leadbase-storage.js --dry-run --table LeadBase
  node scripts/migrate-leadbase-storage.js --sample 10000 --table LeadBase
  node scripts/migrate-leadbase-storage.js --resume
  node scripts/migrate-leadbase-storage.js   # full run

Cascade cs : args > env (MIGRATION_SOURCE_CS / MIGRATION_TARGET_CS) > KV ${KV_NAME}.
`);
}

// ─── Connection strings (cascade) ──────────────────────────────────────────
function maskCs(cs) {
  if (!cs) return '<absent>';
  const m = cs.match(/AccountName=([^;]+)/);
  const account = m ? m[1] : '?';
  return `${account}…[redacted]`;
}

function getCsFromKv(secretName) {
  try {
    const out = execSync(
      `az keyvault secret show --vault-name ${KV_NAME} --name ${secretName} --query value -o tsv`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function failNoCs(role, kvSecret, accountHint) {
  console.error(`
ERROR: connection string ${role} introuvable.

Cascade testée :
  1. --source-cs / --target-cs CLI
  2. MIGRATION_${role.toUpperCase()}_CS env
  3. KV ${KV_NAME}/${kvSecret}

Pour la poser en KV (R-CRED stricte, cs jamais affichée) :

  CS=$(az storage account show-connection-string \\
        --name ${accountHint} \\
        --resource-group oseys-prospection-rg \\
        --query connectionString -o tsv)
  az keyvault secret set --vault-name ${KV_NAME} --name ${kvSecret} --value "$CS"
  unset CS
`);
  process.exit(1);
}

function resolveCs(args, role) {
  const cliKey = role === 'source' ? args.sourceCs : args.targetCs;
  if (cliKey) return cliKey;
  const envKey = role === 'source' ? 'MIGRATION_SOURCE_CS' : 'MIGRATION_TARGET_CS';
  if (process.env[envKey]) return process.env[envKey];
  const kvSecret = role === 'source' ? KV_SOURCE_SECRET : KV_TARGET_SECRET;
  const cs = getCsFromKv(kvSecret);
  if (cs) return cs;
  const accountHint = role === 'source' ? 'oseysjeannotst' : 'pereneoleadsst';
  failNoCs(role, kvSecret, accountHint);
  return null; // unreachable
}

// ─── Checkpoint ─────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveCheckpoint(state) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[checkpoint] write failed: ${err.message}`);
  }
}

// ─── Migration core ─────────────────────────────────────────────────────────
async function ensureTargetTable(client, tableName) {
  try {
    await client.createTable();
  } catch (err) {
    const status = err && err.statusCode;
    if (status === 409 || /TableAlreadyExists/i.test(err.message || '')) return;
    throw err;
  }
}

async function flushBatch({ client, tableName, pk, entities, opts, counters }) {
  if (entities.length === 0) return;
  const action = opts.resume || opts.sample || opts.skipConflicts ? 'upsert' : 'create';
  const transaction = entities.map((e) => [action, e]);

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      await client.submitTransaction(transaction);
      counters.success += entities.length;
      return;
    } catch (err) {
      const status = err && err.statusCode;
      if (status === 409 && opts.skipConflicts && action === 'create') {
        counters.skipped += entities.length;
        return;
      }
      if (status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        attempt++;
        if (attempt > MAX_RETRIES) break;
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
        console.warn(`[retry] ${tableName} pk=${pk} attempt=${attempt}/${MAX_RETRIES} backoff=${delay}ms code=${status || err.code}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      counters.errored += entities.length;
      throw err;
    }
  }
  counters.errored += entities.length;
  throw new Error(`Max retries dépassés ${tableName} pk=${pk}`);
}

function shouldSkipResume(entity, resumePoint) {
  if (!resumePoint) return false;
  const pk = entity.partitionKey;
  const rk = entity.rowKey;
  if (pk < resumePoint.lastPK) return true;
  if (pk === resumePoint.lastPK && rk <= resumePoint.lastRK) return true;
  return false;
}

async function migrateTable({ tableName, sourceClient, targetClient, opts, sharedState }) {
  const counters = { scanned: 0, success: 0, skipped: 0, errored: 0 };
  const startTime = Date.now();
  const buckets = new Map(); // PK -> entity[]
  const dryRunDist = new Map(); // PK -> count
  let resumePoint = null;

  if (opts.resume) {
    const chk = loadCheckpoint();
    if (chk && chk.tables && chk.tables[tableName]) {
      resumePoint = chk.tables[tableName];
      console.log(`[resume] ${tableName} reprise après pk=${resumePoint.lastPK} rk=${resumePoint.lastRK}`);
    }
  }

  if (!opts.dryRun) {
    await ensureTargetTable(targetClient, tableName);
  }

  let lastFlushedPK = null;
  let lastFlushedRK = null;

  const iter = sourceClient.listEntities();
  for await (const entity of iter) {
    counters.scanned++;

    if (opts.sample && counters.scanned > opts.sample) break;

    if (resumePoint && shouldSkipResume(entity, resumePoint)) {
      counters.skipped++;
      continue;
    }

    const pk = entity.partitionKey;
    if (opts.dryRun) {
      dryRunDist.set(pk, (dryRunDist.get(pk) || 0) + 1);
      counters.success++;
    } else {
      if (!buckets.has(pk)) buckets.set(pk, []);
      buckets.get(pk).push(entity);
      if (buckets.get(pk).length >= BATCH_SIZE) {
        const batch = buckets.get(pk);
        await flushBatch({ client: targetClient, tableName, pk, entities: batch, opts, counters });
        lastFlushedPK = pk;
        lastFlushedRK = batch[batch.length - 1].rowKey;
        sharedState.tables[tableName] = { lastPK: lastFlushedPK, lastRK: lastFlushedRK };
        buckets.set(pk, []);
      }
    }

    if (counters.scanned % PROGRESS_INTERVAL === 0) {
      const elapsedMs = Date.now() - startTime;
      const throughput = ((counters.scanned / elapsedMs) * 1000).toFixed(0);
      const ts = new Date().toISOString().slice(11, 19);
      console.log(
        `[${ts}] [${tableName}] scanned=${counters.scanned} ok=${counters.success} skip=${counters.skipped} err=${counters.errored} pk_courant=${pk} thr=${throughput} ent/s`,
      );
    }
  }

  // Flush remaining
  if (!opts.dryRun) {
    for (const [pk, bucket] of buckets.entries()) {
      if (bucket.length > 0) {
        await flushBatch({ client: targetClient, tableName, pk, entities: bucket, opts, counters });
        lastFlushedPK = pk;
        lastFlushedRK = bucket[bucket.length - 1].rowKey;
      }
    }
    if (lastFlushedPK !== null) {
      sharedState.tables[tableName] = { lastPK: lastFlushedPK, lastRK: lastFlushedRK };
    }
  }

  return {
    counters,
    elapsedMs: Date.now() - startTime,
    dryRunDist: opts.dryRun ? dryRunDist : null,
  };
}

// ─── SIGINT ────────────────────────────────────────────────────────────────
const sharedState = { tables: {} };
process.on('SIGINT', () => {
  console.error('\n[SIGINT] interruption — écriture checkpoint…');
  saveCheckpoint(sharedState);
  console.error(`[SIGINT] checkpoint écrit dans ${CHECKPOINT_FILE}`);
  console.error('[SIGINT] reprise possible avec : --resume');
  process.exit(130);
});

// ─── Source counts (hors itération) ─────────────────────────────────────────
async function countSourceEntitiesApprox(client, tableName) {
  // Pas de COUNT natif Azure Tables. On échantillonne 1 page rapide pour vérifier
  // la connectivité et lever 404 tôt si table absente.
  try {
    const iter = client.listEntities({ queryOptions: { select: ['PartitionKey'] } }).byPage({ maxPageSize: 1 });
    for await (const _page of iter) {
      return 'connected';
    }
    return 'empty';
  } catch (err) {
    if (err && err.statusCode === 404) return 'missing';
    throw err;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  const sourceCs = resolveCs(args, 'source');
  const targetCs = resolveCs(args, 'target');

  console.log('=== Migration LeadBase Storage ===');
  console.log(`Source  : ${maskCs(sourceCs)}`);
  console.log(`Target  : ${maskCs(targetCs)}`);
  let mode = 'FULL RUN';
  if (args.dryRun) mode = 'DRY-RUN (lecture seule)';
  else if (args.sample) mode = `SAMPLE ${args.sample} (upsert)`;
  console.log(`Mode    : ${mode}`);
  console.log(`Resume  : ${args.resume ? 'ON' : 'OFF'}`);
  console.log(`Skip409 : ${args.skipConflicts ? 'ON' : 'OFF'}`);
  console.log('');

  const tables = args.table ? [args.table] : TABLES_ALLOWED;
  const results = {};

  for (const tableName of tables) {
    const sourceClient = TableClient.fromConnectionString(sourceCs, tableName);
    const targetClient = TableClient.fromConnectionString(targetCs, tableName);

    const presence = await countSourceEntitiesApprox(sourceClient, tableName);
    if (presence === 'missing') {
      console.error(`[${tableName}] table source ABSENTE — abort.`);
      process.exit(2);
    }
    if (presence === 'empty') {
      console.warn(`[${tableName}] table source vide — skip.`);
      results[tableName] = { counters: { scanned: 0, success: 0, skipped: 0, errored: 0 }, elapsedMs: 0 };
      continue;
    }

    console.log(`\n=== ${tableName} ===`);
    const r = await migrateTable({ tableName, sourceClient, targetClient, opts: args, sharedState });
    results[tableName] = r;

    const sec = (r.elapsedMs / 1000).toFixed(1);
    const rate = r.elapsedMs > 0 ? ((r.counters.scanned / r.elapsedMs) * 1000).toFixed(0) : '∞';
    console.log(
      `\n[${tableName}] terminé en ${sec}s — scanned=${r.counters.scanned} ok=${r.counters.success} skip=${r.counters.skipped} err=${r.counters.errored} avg=${rate} ent/s`,
    );

    if (args.dryRun && r.dryRunDist) {
      const top = [...r.dryRunDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log('Top 10 PartitionKey (dry-run) :');
      for (const [pk, count] of top) console.log(`  ${pk.padEnd(20)} ${count}`);
      console.log(`Total partitions distinctes : ${r.dryRunDist.size}`);
    }
  }

  // Résumé global
  console.log('\n=== Résumé global ===');
  let totalScanned = 0;
  let totalElapsed = 0;
  for (const [name, r] of Object.entries(results)) {
    const rate = r.elapsedMs > 0 ? ((r.counters.scanned / r.elapsedMs) * 1000).toFixed(0) : '0';
    console.log(`  ${name.padEnd(20)} scanned=${r.counters.scanned} ok=${r.counters.success} err=${r.counters.errored} ${(r.elapsedMs / 1000).toFixed(1)}s avg=${rate} ent/s`);
    totalScanned += r.counters.scanned;
    totalElapsed += r.elapsedMs;
  }

  // Extrapolation pour --sample
  if (args.sample) {
    const sampleResult = Object.values(results).find((r) => r.counters.scanned > 0);
    if (sampleResult && sampleResult.elapsedMs > 0) {
      const rateSample = (sampleResult.counters.scanned / sampleResult.elapsedMs) * 1000;
      const TARGET_LEADBASE = 12_800_000;
      const etaRawMs = (TARGET_LEADBASE / rateSample) * 1000;
      const etaMargedMs = etaRawMs * 1.3;
      const fmt = (ms) => {
        const s = ms / 1000;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
      };
      console.log('\n=== Extrapolation full run LeadBase (12,8M lignes) ===');
      console.log(`  Débit observé   : ${rateSample.toFixed(0)} ent/s`);
      console.log(`  ETA brut        : ${fmt(etaRawMs)}`);
      console.log(`  ETA avec marge x1.3 : ${fmt(etaMargedMs)}`);
    }
  }

  // Cleanup checkpoint si full run réussi (pas sample, pas dry-run)
  if (!args.sample && !args.dryRun && fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    console.log(`\nCheckpoint supprimé (${CHECKPOINT_FILE}).`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('\nFATAL :', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  saveCheckpoint(sharedState);
  process.exit(2);
});
