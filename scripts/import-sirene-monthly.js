#!/usr/bin/env node
'use strict';

/**
 * Import mensuel SIRENE → LeadBase
 *
 * Lit un fichier CSV UniteLegale SIRENE (stock complet ou mensuel),
 * filtre les entreprises actives dans les tranches d'effectif cibles,
 * enrichit chaque SIREN via recherche-entreprises.api.gouv.fr (adresse +
 * coordonnées), et upsert dans la table Azure LeadBase.
 *
 * Source SIRENE : https://files.data.gouv.fr/insee-sirene/
 *   Stock complet  : StockUniteLegale_utf8.zip  (~250 MB compressé)
 *   Mensuel        : UniteLegale_utf8_YYYYMM.zip (~10-50 MB)
 *
 * Modes d'entrée :
 *   1. --input PATH     CSV déjà téléchargé et décompressé
 *   2. --download       Télécharge le fichier mensuel depuis data.gouv.fr
 *                       (utilise --month YYYY-MM, défaut = mois courant)
 *                       Sauvegarde dans /tmp, décompresse via `unzip`
 *
 * Usage :
 *   # Depuis un fichier local
 *   node scripts/import-sirene-monthly.js --input /tmp/UniteLegale_utf8.csv
 *
 *   # Téléchargement auto du mois courant + import
 *   node scripts/import-sirene-monthly.js --download
 *   node scripts/import-sirene-monthly.js --download --month 2026-04
 *
 *   # Dry-run (lit + filtre, n'écrit pas)
 *   node scripts/import-sirene-monthly.js --download --dry-run
 *
 *   # Limiter à N insertions (test)
 *   node scripts/import-sirene-monthly.js --download --limit 500
 *
 *   # Inclure les petites structures (3-9 salariés en plus des 10+)
 *   node scripts/import-sirene-monthly.js --download --tranches 02,03,11,12,21
 *
 * Variables d'environnement :
 *   LEADBASE_STORAGE_CONNECTION_STRING (requis, ou AzureWebJobsStorage)
 *   SIRENE_IMPORT_CONCURRENCY=4        (parallélisme API, défaut 4)
 *   SIRENE_IMPORT_SLEEP_MS=250         (ms entre fin de batch et suivant)
 *   SIRENE_IMPORT_TIMEOUT_MS=8000      (timeout par requête API)
 *   SIRENE_DOWNLOAD_DIR=/tmp           (répertoire de téléchargement)
 *
 * Nota race condition : si enrich-leadbase-continuous tourne en parallèle,
 * les deux peuvent écrire la même entité simultanément. Merge strategy →
 * pas de perte de données, juste une possible surcharge sans conséquence.
 */

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execSync } = require('node:child_process');

// ─── Chargement local.settings.json ──────────────────────────────────────────
const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Ne pas écraser les vars déjà définies (CLI override > local.settings.json)
    for (const [k, v] of Object.entries(s.Values || {})) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* ignore */ }
}

const { TableClient } = require('@azure/data-tables');

const NAF_EXCLUSIONS = require('../shared/mappings/naf-exclusions.json');
const EXCLUDED_NAF = new Set((NAF_EXCLUSIONS.exclusions || []).map((e) => e.code));

const RNE_API_BASE = 'https://recherche-entreprises.api.gouv.fr';
const CONCURRENCY = Number(process.env.SIRENE_IMPORT_CONCURRENCY || 4);
const SLEEP_MS = Number(process.env.SIRENE_IMPORT_SLEEP_MS || 250);
const TIMEOUT_MS = Number(process.env.SIRENE_IMPORT_TIMEOUT_MS || 8000);
const DOWNLOAD_DIR = process.env.SIRENE_DOWNLOAD_DIR || '/tmp';
const BATCH_WRITE_SIZE = 100;
const PROGRESS_INTERVAL = 500;

// URL du stock SIRENE complet (mis à jour ~1er de chaque mois par data.gouv.fr)
const SIRENE_STOCK_URL = 'https://object.files.data.gouv.fr/data-pipeline-open/siren/stock/StockUniteLegale_utf8.zip';
// Dataset API data.gouv.fr pour récupérer l'URL courante si le pattern change :
// https://www.data.gouv.fr/api/1/datasets/5b7ffc618b4c4169d30727e0/

// ─── CLI ─────────────────────────────────────────────────────────────────────
// ─── Régions → départements ───────────────────────────────────────────────────
const REGIONS = {
  idf:  ['75','77','78','91','92','93','94','95'],
  aura: ['01','03','07','15','26','38','42','43','63','69','73','74'],
  paca: ['04','05','06','13','83','84'],
  occitanie: ['09','11','12','30','31','32','34','46','48','65','66','81','82'],
  grandest: ['08','10','51','52','54','55','57','67','68','88'],
  hautsdefrance: ['02','59','60','62','80'],
  nouvelleaquitaine: ['16','17','19','23','24','33','40','47','64','79','86','87'],
  bretagne: ['22','29','35','56'],
  pdl: ['44','49','53','72','85'],
  normandie: ['14','27','50','61','76'],
  bourgognefranchecomte: ['21','25','39','58','70','71','89','90'],
  centrevalledeloire: ['18','28','36','37','41','45'],
  corsica: ['2A','2B'],
};

function parseArgs(argv) {
  const args = {
    input: null,
    download: false,
    dryRun: false,
    limit: null,
    tranches: ['11', '12', '21'],
    newOnly: false,
    month: null,
    allTranches: false,
    regions: null, // null = toutes les régions
    tableName: process.env.LEADBASE_TABLE || 'LeadBase',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--download') args.download = true;
    else if (a === '--regions') {
      const rnames = argv[++i].split(',').map((s) => s.trim().toLowerCase());
      const depts = new Set();
      for (const r of rnames) {
        if (!REGIONS[r]) { console.error(`Région inconnue : ${r}. Disponibles : ${Object.keys(REGIONS).join(', ')}`); process.exit(1); }
        REGIONS[r].forEach((d) => depts.add(d));
      }
      args.regions = depts;
    }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--tranches') args.tranches = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--new-only') args.newOnly = true;
    else if (a === '--month') args.month = argv[++i]; // format YYYY-MM
    else if (a === '--all-tranches') args.allTranches = true;
    else if (a === '--table') args.tableName = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Argument inconnu : ${a}`); printHelp(); process.exit(1); }
  }

  if (!args.input && !args.download) {
    console.error('--input <csv> ou --download est requis');
    printHelp();
    process.exit(1);
  }
  if (args.input && !fs.existsSync(args.input)) {
    console.error(`Fichier introuvable : ${args.input}`);
    process.exit(1);
  }
  if (args.allTranches) {
    args.tranches = ['01', '02', '03', '11', '12', '21', '22', '31', '32', '41', '42', '51', '52', '53'];
  }
  return args;
}

function buildRegionLabel(regions) {
  if (!regions) return 'France entière';
  const names = Object.entries(REGIONS)
    .filter(([, depts]) => depts.some((d) => regions.has(d)))
    .map(([name]) => name.toUpperCase());
  return names.join(', ') || `${regions.size} département(s)`;
}

function printHelp() {
  console.log(`
Usage : node scripts/import-sirene-monthly.js [--input <csv> | --download] [options]

Modes d'entrée :
  --input PATH          CSV SIRENE UniteLegale local (UTF-8, décompressé)
  --download            Télécharge + décompresse le fichier mensuel SIRENE
                        depuis files.data.gouv.fr/insee-sirene/ (utilise --month)

Options :
  --month YYYY-MM       Mois à traiter (défaut : mois courant)
  --regions A,B,...     Régions : idf, aura, paca, occitanie, grandest,
                        hautsdefrance, nouvelleaquitaine, bretagne, pdl,
                        normandie, bourgognefranchecomte, centrevalledeloire
                        (défaut : France entière)
  --dry-run             Lit + filtre, n'écrit pas dans LeadBase
  --limit N             Stoppe après N upserts (pour tester)
  --tranches A,B,...    Codes tranche effectif INSEE (défaut : 11,12,21)
  --all-tranches        Toutes les tranches (override --tranches)
  --new-only            Filtre sur dateCreation dans --month (auto avec --download)
  --table NAME          Table Azure cible (défaut : LeadBase)

Exemples :
  # IDF + AURA + PACA, mois courant, dry-run
  node scripts/import-sirene-monthly.js --download --regions idf,aura,paca --dry-run

  # Même chose, vraie écriture
  node scripts/import-sirene-monthly.js --download --regions idf,aura,paca

  # Mois spécifique
  node scripts/import-sirene-monthly.js --download --month 2026-04 --regions idf,aura,paca

  # Inclure petites structures (3-9 salariés)
  node scripts/import-sirene-monthly.js --download --regions idf,aura,paca --tranches 02,03,11,12,21

  # Test rapide 100 entrées depuis fichier local
  node scripts/import-sirene-monthly.js --input /tmp/UniteLegale.csv --limit 100
`);
}

// ─── Téléchargement SIRENE ────────────────────────────────────────────────────

function currentMonth() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Téléchargement : ${url}`);
    const file = fs.createWriteStream(destPath);
    let downloaded = 0;

    const doRequest = (requestUrl) => {
      https.get(requestUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} pour ${requestUrl}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(1);
            process.stdout.write(`\r  Progression : ${pct}% (${(downloaded / 1_048_576).toFixed(1)} MB / ${(total / 1_048_576).toFixed(0)} MB)  `);
          } else {
            process.stdout.write(`\r  Reçu : ${(downloaded / 1_048_576).toFixed(1)} MB`);
          }
        });
        res.pipe(file);
        file.on('finish', () => { process.stdout.write('\n'); file.close(resolve); });
      }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    };

    doRequest(url);
  });
}

function unzipFile(zipPath, destDir) {
  // Décompresse le premier fichier CSV dans le zip
  console.log(`  Décompression : ${zipPath}`);
  try {
    execSync(`unzip -o -d "${destDir}" "${zipPath}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`unzip échoué : ${err.message}`);
  }
  // Trouver le CSV extrait (même nom que le zip, .csv au lieu de .zip)
  const basename = path.basename(zipPath, '.zip');
  const csvPath = path.join(destDir, `${basename}.csv`);
  if (fs.existsSync(csvPath)) return csvPath;
  // Fallback : chercher tout CSV dans destDir
  const files = fs.readdirSync(destDir).filter((f) => f.endsWith('.csv'));
  if (files.length > 0) return path.join(destDir, files[0]);
  throw new Error(`Aucun CSV trouvé après décompression dans ${destDir}`);
}

async function downloadAndExtract() {
  const zipPath = path.join(DOWNLOAD_DIR, 'StockUniteLegale_utf8.zip');
  const csvPath = path.join(DOWNLOAD_DIR, 'StockUniteLegale_utf8.csv');

  // Si le CSV existe déjà (run précédent), on le réutilise
  if (fs.existsSync(csvPath)) {
    const stat = fs.statSync(csvPath);
    console.log(`  CSV déjà présent (${(stat.size / 1_073_741_824).toFixed(2)} GB, réutilisé) : ${csvPath}`);
    return csvPath;
  }

  await downloadFile(SIRENE_STOCK_URL, zipPath);
  const extracted = unzipFile(zipPath, DOWNLOAD_DIR);
  // Nettoyer le zip après extraction pour économiser l'espace
  try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
  console.log(`  CSV extrait : ${extracted}`);
  return extracted;
}

// ─── Azure Table ──────────────────────────────────────────────────────────────
function getTableClient(tableName) {
  const cs = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!cs) throw new Error('Connection string absente (LEADBASE_STORAGE_CONNECTION_STRING ou AzureWebJobsStorage)');
  return TableClient.fromConnectionString(cs, tableName);
}

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (err) {
    if (err && (err.statusCode === 409 || /TableAlreadyExists/i.test(err.message || ''))) return;
    throw err;
  }
}

// ─── Département depuis code commune INSEE ─────────────────────────────────
function departementFromCommune(codeCommune) {
  if (!codeCommune || codeCommune.length < 2) return null;
  const s = String(codeCommune);
  // Corse : "2A..." ou "2B..."
  if (/^2[AB]/i.test(s)) return s.slice(0, 2).toUpperCase();
  // DOM-TOM : "97x..."
  if (s.startsWith('97')) return s.slice(0, 3);
  // Métropole : 2 premiers chiffres
  return s.slice(0, 2).replace(/^0/, '0'); // preserve leading 0
}

// ─── API recherche-entreprises ────────────────────────────────────────────────
async function fetchEntrepriseFromApi(siren) {
  const url = `${RNE_API_BASE}/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }

  const r = (data.results || [])[0];
  if (!r || String(r.siren) !== String(siren)) return null;

  const siege = r.siege || {};
  const dept = departementFromCommune(siege.commune);

  return {
    siren: String(r.siren),
    nom: String(r.nom_complet || r.denomination || '').trim() || null,
    codeNaf: String(r.activite_principale || '').trim() || null,
    trancheEffectif: String(r.tranche_effectif_salarie || '').trim() || null,
    ville: String(siege.libelle_commune || '').trim() || null,
    latitude: siege.latitude != null ? Number(siege.latitude) : null,
    longitude: siege.longitude != null ? Number(siege.longitude) : null,
    departement: dept,
    etatAdministratif: r.etat_administratif || null,
  };
}

// ─── Parse CSV SIRENE en streaming ──────────────────────────────────────────
function buildSireneFilter(args) {
  const trancheSet = new Set(args.tranches);
  const monthPrefix = args.newOnly
    ? (args.month || new Date().toISOString().slice(0, 7))
    : null;

  return (row) => {
    if (!row.siren || !/^\d{9}$/.test(row.siren)) return false;
    if ((row.etatAdministratifUniteLegale || 'A') !== 'A') return false;
    if (row.statutDiffusionUniteLegale === 'P') return false; // non diffusé

    const tranche = row.trancheEffectifsUniteLegale || '';
    if (!trancheSet.has(tranche)) return false;

    const naf = (row.activitePrincipaleUniteLegale || '').trim();
    if (EXCLUDED_NAF.has(naf)) return false;

    if (monthPrefix) {
      const created = (row.dateCreationUniteLegale || '').trim();
      if (!created.startsWith(monthPrefix)) return false;
    }

    return true;
  };
}

async function collectFilteredSirens(csvPath, args) {
  const passesFilter = buildSireneFilter(args);
  const sirens = [];
  let totalLines = 0;
  let headers = null;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(csvPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!headers) {
        headers = parseCsvLine(line);
        return;
      }
      totalLines++;
      if (totalLines % 1_000_000 === 0) {
        process.stdout.write(`\r  Lecture CSV : ${(totalLines / 1_000_000).toFixed(1)}M lignes, ${sirens.length} retenus...`);
      }
      const values = parseCsvLine(line);
      if (values.length !== headers.length) return;
      const row = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
      if (passesFilter(row)) {
        sirens.push(row.siren);
        if (args.limit && sirens.length >= args.limit) {
          rl.close();
          rl.removeAllListeners();
        }
      }
    });

    rl.on('close', resolve);
    rl.on('error', reject);
  });

  if (totalLines >= 1000) process.stdout.write('\n');
  return { sirens, totalLines };
}

// Parseur CSV minimal RFC 4180 (gère les guillemets).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

// ─── Pipeline principal ──────────────────────────────────────────────────────
async function processInBatches(sirens, client, args) {
  const counters = {
    processed: 0,
    upserted: 0,
    noAddress: 0,
    apiError: 0,
    writeError: 0,
    skipped: 0,
    outOfRegion: 0,
  };

  // Traite par batches de CONCURRENCY en parallèle
  for (let i = 0; i < sirens.length; i += CONCURRENCY) {
    const batch = sirens.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (siren) => {
      const info = await fetchEntrepriseFromApi(siren);
      return { siren, info };
    }));

    // Collecter les entités valides pour write batch
    const toWrite = [];
    for (const { siren, info } of results) {
      counters.processed++;
      if (!info) { counters.apiError++; continue; }
      if (!info.departement) { counters.noAddress++; continue; }
      if (info.etatAdministratif && info.etatAdministratif !== 'A') { counters.skipped++; continue; }
      if (args.regions && !args.regions.has(info.departement)) { counters.outOfRegion++; continue; }

      toWrite.push({
        partitionKey: info.departement,
        rowKey: siren,
        siren,
        nom: info.nom || '',
        codeNaf: info.codeNaf || '',
        ville: info.ville || '',
        trancheEffectif: info.trancheEffectif || '',
        latitude: info.latitude,
        longitude: info.longitude,
        importedAt: new Date().toISOString(),
        source: 'sirene-import',
      });
    }

    if (!args.dryRun && toWrite.length > 0) {
      // Regrouper par PartitionKey pour submitTransaction (même PK obligatoire)
      const byPk = new Map();
      for (const entity of toWrite) {
        if (!byPk.has(entity.partitionKey)) byPk.set(entity.partitionKey, []);
        byPk.get(entity.partitionKey).push(entity);
      }
      for (const [, entities] of byPk) {
        for (let j = 0; j < entities.length; j += BATCH_WRITE_SIZE) {
          const chunk = entities.slice(j, j + BATCH_WRITE_SIZE);
          try {
            const transaction = chunk.map((e) => ['upsert', e]);
            await client.submitTransaction(transaction);
            counters.upserted += chunk.length;
          } catch (err) {
            // Fallback : upsert individuel si transaction échoue (PK mixte)
            for (const e of chunk) {
              try {
                await client.upsertEntity(e, 'Merge');
                counters.upserted++;
              } catch {
                counters.writeError++;
              }
            }
          }
        }
      }
    } else {
      counters.upserted += toWrite.length;
    }

    if (counters.processed % PROGRESS_INTERVAL === 0) {
      const pct = ((counters.processed / sirens.length) * 100).toFixed(1);
      process.stdout.write(
        `\r  [${pct}%] processed=${counters.processed} upserted=${counters.upserted} apiErr=${counters.apiError} noAddr=${counters.noAddress}`,
      );
    }

    if (i + CONCURRENCY < sirens.length && SLEEP_MS > 0) {
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }
  if (sirens.length > 0) process.stdout.write('\n');
  return counters;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  if (!args.month) args.month = currentMonth();

  console.log('');
  console.log('═'.repeat(72));
  console.log('  IMPORT SIRENE → LeadBase');
  console.log('═'.repeat(72));
  console.log(`  Mode entrée   : ${args.download ? `--download (${args.month})` : `--input ${args.input}`}`);
  console.log(`  Tranches      : ${args.tranches.join(', ')}`);
  console.log(`  Régions       : ${buildRegionLabel(args.regions)}`);
  console.log(`  Filtre créa   : ${args.newOnly ? args.month : 'tous (pas de filtre date)'}`);
  console.log(`  Mode écriture : ${args.dryRun ? 'DRY-RUN (pas d\'écriture)' : 'ÉCRITURE'}`);
  if (args.limit) console.log(`  Limite        : ${args.limit}`);
  console.log('');

  let client = null;
  if (!args.dryRun) {
    const cs = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    if (!cs) {
      console.error('Connection string absente. Définir LEADBASE_STORAGE_CONNECTION_STRING ou AzureWebJobsStorage.');
      process.exit(1);
    }
    client = getTableClient(args.tableName);
    await ensureTable(client);
    console.log(`  Table cible   : ${args.tableName} (AccountName=${cs.match(/AccountName=([^;]+)/)?.[1]})`);
    console.log('');
  }

  // 0. Téléchargement si --download
  if (args.download) {
    console.log('Étape 0 — Téléchargement du stock SIRENE complet (~955 MB)...');
    console.log(`  Source : ${SIRENE_STOCK_URL}`);
    try {
      args.input = await downloadAndExtract();
    } catch (err) {
      console.error(`  Téléchargement échoué : ${err.message}`);
      console.error('  Télécharger manuellement depuis :');
      console.error(`  ${SIRENE_STOCK_URL}`);
      console.error('  Puis utiliser : --input /tmp/StockUniteLegale_utf8.csv');
      process.exit(1);
    }
    console.log('');
  }

  // 1. Lecture + filtrage CSV
  console.log('Étape 1 — Lecture CSV SIRENE...');
  const t1 = Date.now();
  const { sirens, totalLines } = await collectFilteredSirens(args.input, args);
  const t1ms = Date.now() - t1;
  console.log(`  ${totalLines.toLocaleString('fr-FR')} lignes lues en ${(t1ms / 1000).toFixed(1)}s`);
  console.log(`  ${sirens.length.toLocaleString('fr-FR')} SIRENs retenus (filtrage SIRENE : tranche + NAF + état)`);
  if (args.regions) console.log(`  (filtre région appliqué à l'étape 2 après résolution adresse)`);

  if (sirens.length === 0) {
    console.log('\nAucune entreprise à importer. Fin.');
    process.exit(0);
  }

  // 2. Enrichissement + upsert
  if (args.dryRun) {
    console.log(`\nDRY-RUN terminé. ${sirens.length.toLocaleString('fr-FR')} SIRENs passeraient l'étape 2 (API + upsert).`);
    console.log('Relancer sans --dry-run pour effectuer l\'import réel.');
    process.exit(0);
  }

  console.log(`\nÉtape 2 — Enrichissement API + upsert (concurrence ${CONCURRENCY}, sleep ${SLEEP_MS}ms)...`);
  const t2 = Date.now();
  const counters = await processInBatches(sirens, client, args);
  const t2ms = Date.now() - t2;

  const rate = counters.processed > 0 ? (counters.processed / (t2ms / 1000)).toFixed(1) : '0';

  // 3. Rapport
  console.log('');
  console.log('═'.repeat(72));
  console.log('  RAPPORT');
  console.log('═'.repeat(72));
  console.log(`  SIRENs filtrés      : ${sirens.length.toLocaleString('fr-FR')}`);
  console.log(`  Traités             : ${counters.processed.toLocaleString('fr-FR')}`);
  console.log(`  Upsertés en base    : ${counters.upserted.toLocaleString('fr-FR')} ${args.dryRun ? '(dry-run)' : ''}`);
  console.log(`  Sans adresse API    : ${counters.noAddress}`);
  console.log(`  Erreurs API         : ${counters.apiError}`);
  console.log(`  Erreurs écriture    : ${counters.writeError}`);
  console.log(`  Skippés (inactifs)  : ${counters.skipped}`);
  if (counters.outOfRegion > 0) console.log(`  Hors région         : ${counters.outOfRegion}`);
  console.log(`  Durée étape 2       : ${(t2ms / 1000).toFixed(1)}s (${rate} siren/s)`);
  console.log('');

  const ETA_FULL_LEADBASE = 12_800_000;
  if (sirens.length > 100 && counters.processed > 0) {
    const estRate = counters.processed / (t2ms / 1000);
    if (estRate > 0) {
      const etaMs = (ETA_FULL_LEADBASE / estRate) * 1000;
      const h = Math.floor(etaMs / 3600000);
      const m = Math.floor((etaMs % 3600000) / 60000);
      console.log(`  Extrapolation full stock (12.8M) au débit observé : ~${h}h${String(m).padStart(2, '0')}m`);
      console.log('');
    }
  }

  const hasErrors = counters.writeError > 0;
  if (hasErrors) {
    console.warn(`  ⚠  ${counters.writeError} erreur(s) d'écriture — relancer avec les mêmes paramètres (upsert idempotent)`);
    process.exit(1);
  } else {
    console.log(args.dryRun
      ? '  Dry-run terminé. Relancer sans --dry-run pour écrire en base.'
      : '  Import terminé avec succès.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\nFATAL :', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(2);
});
