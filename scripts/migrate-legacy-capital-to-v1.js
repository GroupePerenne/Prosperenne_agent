#!/usr/bin/env node
'use strict';

/**
 * Script orchestrateur — migration capital scrapé legacy → LeadBase v1.
 *
 * Doctrine : docs/LEADBASE_SCHEMA_v1.md v1.1 §8.3, docs/LEADBASE_LESSONS_v1.md
 * §4 invariants I-1, I-9, I-10.
 *
 * Stratégie : la table LeadBase contient à la fois les entrées legacy
 * Constantin (sans schema_version) et les entrées v1 SIRENE bulk Paul
 * (schema_version='1.0'). Pour les SIRENs présents dans les deux populations,
 * Storage Tables a déjà fusionné les colonnes au moment du SIRENE bulk import
 * (Merge sur Couche 1, capital legacy préservé sur les autres couches).
 *
 * La migration consiste à :
 *   1. Scanner les entrées schema_version='1.0' (filtre I-2 serveur-side)
 *   2. Pour chacune, détecter si du capital scrapé legacy existe (siteWeb*,
 *      dirigeants, rne_checked_at) qu'il faut normaliser/auditer.
 *   3. Appeler migrateLegacyCapitalToV1 qui passe par safeMergeCoucheN
 *      (enforce I-1, I-9, I-10).
 *   4. Audit le run dans LeadBaseMigrationRuns.
 *
 * Idempotent : appelé deux fois, le second appel détecte les entrées
 * déjà migratedFromLegacyAt et skip (best-effort).
 *
 * Usage :
 *   node scripts/migrate-legacy-capital-to-v1.js [--dry-run] [--limit N]
 *     [--connection-string $CS]
 *
 * Variables env :
 *   LEADBASE_STORAGE_CONNECTION_STRING  (requis sauf --connection-string)
 *   LEADBASE_MIGRATION_RUNS_TABLE       (défaut LeadBaseMigrationRuns)
 */

const { TableClient } = require('@azure/data-tables');
const { randomUUID } = require('node:crypto');
const { safeListLeadBaseEntities, composeDiscriminantFilter } = require('../shared/leadbase/safe-read');
const { migrateLegacyCapitalToV1, extractScrapedCapital } = require('../shared/leadbase/migrate-capital-scrape');

// ─── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, connectionString: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--connection-string') args.connectionString = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`
Migration capital scrapé legacy → LeadBase v1.

Usage : node scripts/migrate-legacy-capital-to-v1.js [options]

Options :
  --dry-run                 Scan + extract sans write (audit summary).
  --limit <n>               Limite scan (utile dev).
  --connection-string <cs>  Override CS LEADBASE_STORAGE_CONNECTION_STRING.
  -h, --help                Cette aide.

Conformité :
  - I-1 : Couche 1 v1 doit être conforme avant write Couche 2-5 (enforced
    par safeMergeCoucheN).
  - I-2 : scan filtré schema_version='1.0' (composeDiscriminantFilter).
  - I-9 : write par couche distincte (RNE / Web / LinkedIn séparés).
  - I-10 : audit *At injecté si manquant en legacy (rneCheckedAt, etc.).
`);
}

function maskCs(cs) {
  if (!cs) return '<absent>';
  const m = cs.match(/AccountName=([^;]+)/);
  return `${m ? m[1] : '?'}…[redacted]`;
}

// ─── Migration runner ──────────────────────────────────────────────────────

async function runMigration({ args, leadBaseClient, runsClient }) {
  const startedAt = new Date();
  const runId = `migrate-${startedAt.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

  console.log(`[migrate] runId=${runId}`);
  console.log(`[migrate] mode=${args.dryRun ? 'DRY-RUN' : 'FULL'} limit=${args.limit || 'aucune'}`);

  const counters = {
    scanned: 0,
    needsMigration: 0,
    migrated: 0,
    skipped: 0,
    errored: 0,
    capitalRne: 0,
    capitalWeb: 0,
    capitalLinkedIn: 0,
  };

  // I-2 : filtre serveur-side discriminant
  const filter = composeDiscriminantFilter();
  const violationsClient = leadBaseClient.constructor === Object
    ? leadBaseClient // tests
    : null; // best-effort, peut être null en prod si table absente

  for await (const entity of safeListLeadBaseEntities(leadBaseClient, { queryOptions: { filter } })) {
    counters.scanned++;
    if (args.limit && counters.scanned > args.limit) break;

    // Skip déjà migré (idempotent)
    if (entity.migratedFromLegacyAt) {
      counters.skipped++;
      continue;
    }

    const capital = extractScrapedCapital(entity);
    if (!capital.summary.hasRne && !capital.summary.hasWeb && !capital.summary.hasLinkedIn) {
      // Pas de capital legacy à migrer
      continue;
    }
    counters.needsMigration++;
    if (capital.summary.hasRne) counters.capitalRne++;
    if (capital.summary.hasWeb) counters.capitalWeb++;
    if (capital.summary.hasLinkedIn) counters.capitalLinkedIn++;

    if (args.dryRun) {
      continue;
    }

    try {
      const result = await migrateLegacyCapitalToV1({
        leadBaseClient,
        violationsClient,
        legacyEntity: entity,
        partitionKey: entity.partitionKey,
        rowKey: entity.rowKey,
        migrationRunId: runId,
      });
      if (result.totalMerged > 0) counters.migrated++;
      else counters.skipped++;
    } catch (err) {
      counters.errored++;
      console.error(`[migrate] error siren=${entity.rowKey} : ${err.message}`);
    }

    if (counters.scanned % 1000 === 0) {
      console.log(`[migrate] progress scanned=${counters.scanned} migrated=${counters.migrated}`);
    }
  }

  const endedAt = new Date();
  const elapsedMs = endedAt - startedAt;

  console.log('\n=== Résumé migration ===');
  console.log(`runId           : ${runId}`);
  console.log(`scanned         : ${counters.scanned}`);
  console.log(`needsMigration  : ${counters.needsMigration}`);
  console.log(`migrated        : ${counters.migrated}`);
  console.log(`skipped         : ${counters.skipped}`);
  console.log(`errored         : ${counters.errored}`);
  console.log(`capitalRne      : ${counters.capitalRne}`);
  console.log(`capitalWeb      : ${counters.capitalWeb}`);
  console.log(`capitalLinkedIn : ${counters.capitalLinkedIn}`);
  console.log(`elapsedMs       : ${elapsedMs}`);

  if (!args.dryRun && runsClient) {
    try { await runsClient.createTable(); } catch { /* déjà créée */ }
    await runsClient.createEntity({
      partitionKey: startedAt.toISOString().slice(0, 10),
      rowKey: runId,
      runId,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      elapsedMs,
      countersJson: JSON.stringify(counters),
      mode: args.dryRun ? 'dry-run' : 'full',
    });
    console.log(`[archive] run archivé dans LeadBaseMigrationRuns/${runId}`);
  } else if (args.dryRun) {
    console.log('[dry-run] archivage SKIP');
  }

  return { runId, counters, elapsedMs };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const cs = args.connectionString || process.env.LEADBASE_STORAGE_CONNECTION_STRING;
  if (!cs) {
    console.error('LEADBASE_STORAGE_CONNECTION_STRING absent. Voir --help.');
    process.exit(1);
  }
  console.log('=== Migration capital scrapé legacy → LeadBase v1 ===');
  console.log(`Source : ${maskCs(cs)}`);

  const leadBaseClient = TableClient.fromConnectionString(cs, 'LeadBase');
  const runsTable = process.env.LEADBASE_MIGRATION_RUNS_TABLE || 'LeadBaseMigrationRuns';
  const runsClient = TableClient.fromConnectionString(cs, runsTable);

  const result = await runMigration({ args, leadBaseClient, runsClient });
  if (result.counters.errored > 0) process.exit(2);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFATAL :', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { runMigration, parseArgs };
