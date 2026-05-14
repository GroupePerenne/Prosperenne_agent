#!/usr/bin/env node
'use strict';

/**
 * Orchestrateur SIRENE bulk import → LeadBase Pereneo.
 *
 * Pipeline :
 *   1. Pour chaque département cible : download CSV via OpenDataSoft
 *   2. Parse CSV (RFC 4180)
 *   3. Map chaque ligne en entité LeadBase + filtre tranches doctrine
 *   4. Write LeadBase Merge idempotent + audit dans SireneIngestionRuns
 *
 * Usage :
 *   # 1 département test
 *   LEADBASE_STORAGE_CONNECTION_STRING=$(cat /tmp/leadbase-cs.tmp) \
 *     node scripts/sirene-bulk-import.js --departement 75
 *
 *   # France entière (90+ départements)
 *   LEADBASE_STORAGE_CONNECTION_STRING=$(cat /tmp/leadbase-cs.tmp) \
 *     node scripts/sirene-bulk-import.js --all
 *
 *   # Dry-run (download + parse + map, pas d'écriture LeadBase)
 *   node scripts/sirene-bulk-import.js --departement 75 --dry-run
 *
 *   # Mode LARGE (inclut tranche 50-99)
 *   SIRENE_TRANCHES_INCLUDE='03,11,12,21' \
 *     node scripts/sirene-bulk-import.js --departement 75
 *
 * Variables d'env :
 *   LEADBASE_STORAGE_CONNECTION_STRING (requis sauf --dry-run)
 *   SIRENE_TRANCHES_INCLUDE='03,11,12'  (défaut sweet spot 6-49)
 *   SIRENE_SNAPSHOT_DIR                 (défaut ~/Pereneo/sirene-snapshots/)
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');

const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const [k, v] of Object.entries(s.Values || {})) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* best effort */ }
}

const { parse: parseCsv } = require('../shared/sirene/parser');
const {
  mapSireneRowToLeadBase,
  getConfiguredTranches,
  TRANCHE_LABEL_TO_CODE,
} = require('../shared/sirene/mapper');
const { downloadDepartement } = require('../shared/sirene/downloader');
const { writeEntity, writeRun } = require('../shared/sirene/writer');
const NAF_EXCLUSIONS = require('../shared/mappings/naf-exclusions.json');

// Set des codes NAF exclus par construction (cabinets juridiques/comptables,
// administration publique, enseignement public primaire/secondaire,
// organisations associatives). Cf. shared/mappings/naf-exclusions.json.
// Match exact (le mapper conserve le code NAF tel que renvoyé par INSEE).
const NAF_EXCLUSION_CODES = new Set(
  (NAF_EXCLUSIONS.exclusions || []).map((e) => e.code),
);

// ─── Tranches code INSEE → labels OpenDataSoft (inverse du mapper) ─────────
const TRANCHE_CODE_TO_LABEL = Object.freeze(
  Object.entries(TRANCHE_LABEL_TO_CODE).reduce((acc, [label, code]) => {
    acc[code] = label;
    return acc;
  }, {}),
);

const FRANCE_METRO_DEPARTEMENTS = [
  // IDF prioritaire
  '75', '77', '78', '91', '92', '93', '94', '95',
  // AURA
  '01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74',
  // PACA
  '04', '05', '06', '13', '83', '84',
  // Reste métropole
  '02', '08', '09', '10', '11', '12', '14', '16', '17', '18', '19',
  '21', '22', '23', '24', '25', '27', '28', '29', '2A', '2B',
  '30', '31', '32', '33', '34', '35', '36', '37', '39', '40', '41',
  '44', '45', '46', '47', '48', '49',
  '50', '51', '52', '53', '54', '55', '56', '57', '58',
  '59', '60', '61', '62', '64', '65', '66', '67', '68',
  '70', '71', '72', '76', '79', '80', '81', '82', '85', '86', '87', '88', '89', '90',
];
const FRANCE_DOM = ['971', '972', '973', '974', '976'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { departements: [], all: false, dryRun: false, noNafFilter: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--departement' || args[i] === '-d') {
      out.departements.push(args[i + 1]);
      i++;
    } else if (args[i] === '--all') {
      out.all = true;
    } else if (args[i] === '--dry-run') {
      out.dryRun = true;
    } else if (args[i] === '--no-naf-filter') {
      // Ne pas appliquer naf-exclusions.json (audit / debug uniquement)
      out.noNafFilter = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      out.help = true;
    }
  }
  return out;
}

function help() {
  console.log(`
SIRENE bulk import → LeadBase Pereneo

Options :
  --departement <code>  Code département (75, 13, 2A, 971…). Répétable.
  --all                 Toute la France (métropole + DOM).
  --dry-run             Download + parse + map sans écriture LeadBase.
  --help                Cette aide.

Env :
  LEADBASE_STORAGE_CONNECTION_STRING (requis hors dry-run)
  SIRENE_TRANCHES_INCLUDE='03,11,12'  (défaut sweet spot 6-49)
  SIRENE_SNAPSHOT_DIR                 (défaut ~/Pereneo/sirene-snapshots/)

Exemples :
  node scripts/sirene-bulk-import.js --departement 75
  node scripts/sirene-bulk-import.js --all
  SIRENE_TRANCHES_INCLUDE='03,11,12,21' node scripts/sirene-bulk-import.js -d 75 -d 13
`);
}

async function processDepartement({ departement, trancheLabels, runId, snapshot, dryRun, applyNafFilter }) {
  const stats = { created: 0, updated: 0, skipped: 0, error: 0, mapInvalid: 0, nafExcluded: 0, parsed: 0 };
  process.stdout.write(`[${departement}] download… `);
  const dl = await downloadDepartement({ departement, trancheLabels });
  process.stdout.write(`${dl.downloaded ? `${(dl.bytes / 1024 / 1024).toFixed(2)} MB en ${(dl.durationMs / 1000).toFixed(1)}s` : 'cache hit'} → parse… `);

  const text = await fs.promises.readFile(dl.path, 'utf8');
  const { rows } = parseCsv(text);
  stats.parsed = rows.length;
  process.stdout.write(`${rows.length} lignes → filter+write… `);

  for (const row of rows) {
    const mapped = mapSireneRowToLeadBase(row, { runId, snapshot });
    if (!mapped.valid) {
      stats.mapInvalid++;
      continue;
    }
    // Filtre NAF exclusions Pérenne (admin publique, enseignement public,
    // associations, juridique, comptable). Cf. shared/mappings/naf-exclusions.json.
    if (applyNafFilter && mapped.entity.codeNaf && NAF_EXCLUSION_CODES.has(mapped.entity.codeNaf)) {
      stats.nafExcluded++;
      continue;
    }
    if (dryRun) {
      stats.skipped++;
      continue;
    }
    const w = await writeEntity(mapped.entity);
    if (w.status === 'created') stats.created++;
    else if (w.status === 'updated') stats.updated++;
    else if (w.status === 'skipped') stats.skipped++;
    else stats.error++;
  }

  console.log(
    `created=${stats.created} updated=${stats.updated} skipped=${stats.skipped} mapInvalid=${stats.mapInvalid} nafExcluded=${stats.nafExcluded} error=${stats.error}`,
  );
  return { dl, stats };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }
  if (!args.all && args.departements.length === 0) {
    console.error('Erreur : --departement <code> ou --all requis');
    help();
    process.exit(2);
  }
  if (!args.dryRun && !process.env.LEADBASE_STORAGE_CONNECTION_STRING && !process.env.AzureWebJobsStorage) {
    console.error('Erreur : LEADBASE_STORAGE_CONNECTION_STRING requis hors --dry-run');
    process.exit(2);
  }

  const trancheCodes = getConfiguredTranches();
  const trancheLabels = trancheCodes.map((c) => TRANCHE_CODE_TO_LABEL[c]).filter(Boolean);
  if (trancheLabels.length === 0) {
    console.error(`Erreur : aucun label tranche valide pour codes [${trancheCodes.join(',')}]`);
    process.exit(2);
  }

  const departements = args.all
    ? [...FRANCE_METRO_DEPARTEMENTS, ...FRANCE_DOM]
    : args.departements;
  const runId = `sirene-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const snapshot = new Date().toISOString().slice(0, 10);
  const startedAt = new Date().toISOString();

  console.log('═'.repeat(70));
  console.log(`SIRENE bulk import → LeadBase`);
  console.log(`runId       : ${runId}`);
  console.log(`mode        : ${args.dryRun ? 'DRY-RUN' : 'WRITE'}`);
  console.log(`tranches    : ${trancheCodes.join(',')} (${trancheLabels.join(' | ')})`);
  console.log(`départements: ${departements.length} (${departements.slice(0, 5).join(', ')}${departements.length > 5 ? '…' : ''})`);
  console.log('═'.repeat(70));

  const totals = { created: 0, updated: 0, skipped: 0, error: 0, mapInvalid: 0, nafExcluded: 0, parsed: 0, bytes: 0 };
  const errors = [];
  const applyNafFilter = !args.noNafFilter;

  console.log(`naf filter  : ${applyNafFilter ? `ON (${NAF_EXCLUSION_CODES.size} codes exclus)` : 'OFF (--no-naf-filter)'}`);
  console.log('═'.repeat(70));

  for (const dep of departements) {
    try {
      const { dl, stats } = await processDepartement({
        departement: dep,
        trancheLabels,
        runId,
        snapshot,
        dryRun: args.dryRun,
        applyNafFilter,
      });
      for (const k of Object.keys(stats)) totals[k] += stats[k];
      totals.bytes += dl.bytes || 0;
    } catch (err) {
      console.error(`[${dep}] ERREUR : ${err.message}`);
      errors.push({ dep, error: err.message });
    }
  }

  const endedAt = new Date().toISOString();
  console.log('═'.repeat(70));
  console.log(`TOTAUX : created=${totals.created} updated=${totals.updated} skipped=${totals.skipped} mapInvalid=${totals.mapInvalid} nafExcluded=${totals.nafExcluded} error=${totals.error} parsed=${totals.parsed} bytes=${(totals.bytes / 1024 / 1024).toFixed(1)} MB`);
  if (errors.length > 0) {
    console.log(`Errors par département : ${errors.length}`);
    for (const e of errors) console.log(`  - ${e.dep}: ${e.error}`);
  }

  // Audit run (skip si dry-run pur)
  if (!args.dryRun) {
    await writeRun({
      runId,
      startedAt,
      endedAt,
      departements,
      snapshotVersion: snapshot,
      counters: {
        created: totals.created,
        updated: totals.updated,
        skipped: totals.skipped,
        error: totals.error,
        nafExcluded: totals.nafExcluded,
        mapInvalid: totals.mapInvalid,
      },
      tranches: trancheCodes,
      mode: trancheCodes.includes('21') ? 'large' : 'strict',
      bytesDownloaded: totals.bytes,
      dryRun: false,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  FRANCE_METRO_DEPARTEMENTS,
  FRANCE_DOM,
  TRANCHE_CODE_TO_LABEL,
};
