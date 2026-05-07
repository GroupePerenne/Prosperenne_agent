#!/usr/bin/env node
'use strict';

/**
 * Audit hebdomadaire intégrité LeadBase.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.4.
 * Lancé en heures creuses (cron Mac Air worker, hebdomadaire).
 *
 * Scan complet LeadBase, agrège violations par catégorie, archive le
 * résultat dans LeadBaseIntegrityRuns. Si seuil de drift dépassé ou
 * I-1 violation présente, alerte par mail (à venir, hook FA dédié).
 *
 * Usage :
 *   node scripts/audit-leadbase-integrity.js [--dry-run] [--threshold 0.1]
 *     [--connection-string $CS] [--limit N]
 *
 * Variables env :
 *   LEADBASE_STORAGE_CONNECTION_STRING (requis sauf --connection-string)
 *   LEADBASE_AUDIT_THRESHOLD_PERCENT  (défaut 0.1)
 *   LEADBASE_AUDIT_RUNS_TABLE         (défaut LeadBaseIntegrityRuns)
 */

const { TableClient } = require('@azure/data-tables');
const { aggregateAudit, shouldAlert, VIOLATION_CATEGORIES } = require('../shared/leadbase/integrity-audit');

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, threshold: null, connectionString: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--threshold') args.threshold = parseFloat(argv[++i]);
    else if (a === '--connection-string') args.connectionString = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`
Audit intégrité LeadBase (run hebdomadaire production).

Usage : node scripts/audit-leadbase-integrity.js [options]

Options :
  --dry-run                 Scan sans archivage dans LeadBaseIntegrityRuns.
  --threshold <pct>         Seuil drift % (défaut 0.1).
  --connection-string <cs>  Override CS LEADBASE_STORAGE_CONNECTION_STRING.
  --limit <n>               Limite scan (utile dev). 0 = pas de limite.
  -h, --help                Cette aide.
`);
}

function maskCs(cs) {
  if (!cs) return '<absent>';
  const m = (cs || '').match(/AccountName=([^;]+)/);
  return `${m ? m[1] : '?'}…[redacted]`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const cs = args.connectionString || process.env.LEADBASE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    console.error('LEADBASE_STORAGE_CONNECTION_STRING absent. Voir --help.');
    process.exit(1);
  }
  const threshold = args.threshold !== null
    ? args.threshold
    : Number(process.env.LEADBASE_AUDIT_THRESHOLD_PERCENT || 0.1);
  const runsTable = process.env.LEADBASE_AUDIT_RUNS_TABLE || 'LeadBaseIntegrityRuns';

  console.log('=== Audit intégrité LeadBase ===');
  console.log(`Source       : ${maskCs(cs)}`);
  console.log(`Threshold    : ${threshold}%`);
  console.log(`Mode         : ${args.dryRun ? 'DRY-RUN' : 'FULL'}`);
  console.log(`Limit        : ${args.limit || 'aucune'}`);
  console.log('');

  const startedAt = new Date();
  const leadBaseClient = TableClient.fromConnectionString(cs, 'LeadBase');

  // Scan streaming pour ne pas charger 12,8M en mémoire.
  console.log('[scan] début…');
  const entities = [];
  let scanned = 0;
  const iter = leadBaseClient.listEntities();
  for await (const entity of iter) {
    entities.push(entity);
    scanned++;
    if (scanned % 50_000 === 0) {
      console.log(`[scan] ${scanned} entrées scannées…`);
    }
    if (args.limit && scanned >= args.limit) break;
  }
  console.log(`[scan] terminé : ${scanned} entrées`);

  console.log('[audit] agrégation des violations…');
  const aggregate = aggregateAudit(entities);
  const alert = shouldAlert(aggregate, threshold);

  const elapsedMs = Date.now() - startedAt.getTime();
  const runId = `audit-${startedAt.toISOString().replace(/[:.]/g, '-')}`;

  console.log('\n=== Résumé audit ===');
  console.log(`runId        : ${runId}`);
  console.log(`scanned      : ${aggregate.scanned}`);
  console.log(`violations   : ${aggregate.total}`);
  console.log(`drift        : ${alert.driftPercent.toFixed(4)}%`);
  console.log(`alert        : ${alert.alert ? 'OUI' : 'non'}`);
  if (alert.alert) {
    console.log(`raisons      : ${alert.reasons.join(', ')}`);
  }
  console.log(`elapsedMs    : ${elapsedMs}`);
  console.log('\nViolations par catégorie :');
  const sorted = Object.entries(aggregate.byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sorted) {
    console.log(`  ${cat.padEnd(35)} ${count}`);
  }

  // Archivage dans LeadBaseIntegrityRuns
  if (!args.dryRun) {
    const runsClient = TableClient.fromConnectionString(cs, runsTable);
    try { await runsClient.createTable(); } catch { /* déjà créée */ }
    const runEntity = {
      partitionKey: startedAt.toISOString().slice(0, 10), // YYYY-MM-DD
      rowKey: runId,
      scanned: aggregate.scanned,
      violationsTotal: aggregate.total,
      driftPercent: alert.driftPercent,
      alert: alert.alert,
      alertReasons: alert.reasons.join(','),
      byCategoryJson: JSON.stringify(aggregate.byCategory),
      thresholdPercent: threshold,
      startedAt: startedAt.toISOString(),
      elapsedMs,
    };
    await runsClient.createEntity(runEntity);
    console.log(`\n[archive] run archivé dans ${runsTable}/${runId}`);
  } else {
    console.log('\n[dry-run] archivage SKIP');
  }

  // Code de sortie
  if (alert.alert) {
    console.error('\n⚠ ALERT triggered. Investigation requise.');
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFATAL :', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
