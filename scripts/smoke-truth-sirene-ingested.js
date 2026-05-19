#!/usr/bin/env node
'use strict';

/**
 * Phase 4 — Re-smoke vérité sur les leads SIRENE fraîchement ingérés.
 *
 * Mesure le taux de résolution email post-peuplement LeadBase via SIRENE
 * bulk import. Compare avec le baseline 0/10 du smoke vérité initial
 * (6 mai PM, scripts/smoke-truth-leadbase.js sur leads sans sireneSourcedAt).
 *
 * Cible : confirmer que le pipeline aval (site-finder + lead-exhauster +
 * SMTP probe + Dropcontact) marche sur les vrais leads sweet spot Pérenne.
 *
 * Usage :
 *   LEADBASE_STORAGE_CONNECTION_STRING=$(cat /tmp/leadbase-cs.tmp) \
 *   SMTP_PROBE_ENABLED=1 \
 *   node scripts/smoke-truth-sirene-ingested.js [--departement 75] [--n 10]
 */

const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const [k, v] of Object.entries(s.Values || {})) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}

if (!process.env.LEADBASE_STORAGE_CONNECTION_STRING) {
  console.error('LEADBASE_STORAGE_CONNECTION_STRING manquant');
  process.exit(2);
}

const { TableClient } = require('@azure/data-tables');
const { leadExhauster } = require('../shared/lead-exhauster');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');
const { findWebsite } = require('../shared/site-finder');
const { isAggregator } = require('../shared/site-finder/aggregators');
const NAF_EXCLUSIONS = require('../shared/mappings/naf-exclusions.json');

const NAF_EXCLUSION_CODES = new Set((NAF_EXCLUSIONS.exclusions || []).map((e) => e.code));
const isNafCible = (code) => Boolean(code) && !NAF_EXCLUSION_CODES.has(code);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { departement: '75', n: 10 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--departement' || args[i] === '-d') {
      out.departement = args[i + 1]; i++;
    } else if (args[i] === '--n' || args[i] === '-n') {
      out.n = Math.max(1, Math.min(100, parseInt(args[i + 1], 10) || 10)); i++;
    }
  }
  return out;
}

function rand(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function makeInMemoryCache() {
  const m = new Map();
  const key = (siren, f, l) => `${siren}|${(f || '').toLowerCase()}|${(l || '').toLowerCase()}`;
  return {
    readLeadContact: async ({ siren, firstName, lastName }) =>
      m.get(key(siren, firstName, lastName)) || null,
    upsertLeadContact: async (row) => {
      m.set(key(row.siren, row.firstName, row.lastName), {
        ...row,
        lastVerifiedAt: new Date().toISOString(),
      });
      return true;
    },
  };
}

async function preflightSiteFinder(cand) {
  if (cand.companyDomain || cand.hintedEmail) return null;
  try {
    const result = await findWebsite(
      {
        siren: cand.siren,
        companyName: cand.companyName,
        ville: cand.ville,
        dirigeantName: [cand.firstName, cand.lastName].filter(Boolean).join(' '),
      },
      { mode: 'on_demand' },
    );
    if (!result || !result.siteUrl) return null;
    if (isAggregator(result.siteUrl)) {
      return { skippedAggregator: true, siteUrl: result.siteUrl, source: result.source };
    }
    return { siteUrl: result.siteUrl, confidence: result.confidence, source: result.source };
  } catch (err) {
    return { error: err && err.message };
  }
}

async function pullSireneIngestedLeads(client, departement, sampleSize, opts = {}) {
  console.log(`[scan] Pull entités sireneSourcedAt non-null sur partition ${departement}…`);
  const pool = [];
  // I-2 OK: smoke truth SIRENE ingested — schema_version='1.0' obligatoire
  // pour ne pas remonter du legacy hors-cible Pérenne.
  const iter = client.listEntities({
    queryOptions: {
      filter: `PartitionKey eq '${departement}' and schema_version eq '1.0'`,
      select: [
        'partitionKey', 'rowKey', 'siren', 'nom', 'codeNaf', 'ville',
        'codePostal', 'trancheEffectif', 'trancheEffectifLabel',
        'prenomDirigeant', 'nomDirigeant', 'sireneSourcedAt', 'sireneRunId',
        'siteWeb', 'emailDirigeant', 'dirigeants', 'categorieJuridique',
        'schema_version',
      ],
    },
  });
  let scanned = 0;
  let nafExcluded = 0;
  for await (const e of iter) {
    scanned++;
    if (!e.sireneSourcedAt) continue;
    if (opts.nafFilter && !opts.nafFilter(e.codeNaf)) {
      nafExcluded++;
      continue;
    }
    pool.push(e);
    if (pool.length >= sampleSize * 30) break;
  }
  console.log(`[scan] ${scanned} entités scannées partition ${departement}, ${nafExcluded} NAF exclus, ${pool.length} candidats au pool.`);
  return rand(pool, sampleSize);
}

/**
 * Extrait firstName/lastName du décideur depuis l'entité LeadBase.
 *
 * Priorité :
 *   1. prenomDirigeant + nomDirigeant SIRENE (peuplé pour entreprises individuelles
 *      via shared/sirene/mapper.js si catégorie juridique 1xxx)
 *   2. JSON dirigeants RNE peuplé par scripts/enrich-leadbase-continuous.js
 *      pour les sociétés (catégorie juridique 5xxx, 6xxx, 7xxx, etc.)
 */
function extractDirigeantFromEntity(entity) {
  if (entity.prenomDirigeant && entity.nomDirigeant) {
    return {
      firstName: entity.prenomDirigeant,
      lastName: entity.nomDirigeant,
      role: '',
      source: 'sirene_ei',
    };
  }
  if (!entity.dirigeants) return null;
  try {
    const arr = JSON.parse(entity.dirigeants);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const d = arr[0];
    const firstName = (d.prenoms || d.prenom || '').trim();
    const lastName = (d.nom || '').trim();
    if (!firstName && !lastName) return null;
    return {
      firstName,
      lastName,
      role: d.qualite || d.fonction || d.role || '',
      source: 'rne',
    };
  } catch {
    return null;
  }
}

async function runOne(entity, adapters) {
  // Construit l'input leadExhauster à partir de l'entité LeadBase SIRENE.
  // Lecture décideur priorité SIRENE EI puis fallback RNE pour sociétés.
  const dirigeant = extractDirigeantFromEntity(entity);
  const cand = {
    siren: entity.siren,
    firstName: (dirigeant && dirigeant.firstName) || '',
    lastName: (dirigeant && dirigeant.lastName) || '',
    companyName: entity.nom || '',
    ville: entity.ville || '',
    codeNaf: entity.codeNaf || '',
    trancheEffectif: entity.trancheEffectif || '',
    inseeRole: (dirigeant && dirigeant.role) || '',
    companyDomain: entity.siteWeb || null,
    hintedEmail: entity.emailDirigeant || null,
    dirigeantSource: (dirigeant && dirigeant.source) || 'none',
  };

  const t0 = Date.now();
  let siteFinderResult = null;
  try {
    siteFinderResult = await preflightSiteFinder(cand);
    if (siteFinderResult && siteFinderResult.siteUrl && !siteFinderResult.skippedAggregator) {
      cand.companyDomain = siteFinderResult.siteUrl;
    }
  } catch {
    siteFinderResult = { error: 'preflight_throw' };
  }

  let r;
  try {
    r = await leadExhauster(
      {
        siren: cand.siren,
        beneficiaryId: 'smoke-sirene',
        firstName: cand.firstName,
        lastName: cand.lastName,
        companyName: cand.companyName,
        companyDomain: cand.companyDomain || undefined,
        inseeRole: cand.inseeRole,
        trancheEffectif: cand.trancheEffectif,
        naf: cand.codeNaf,
      },
      { adapters },
    );
  } catch (err) {
    r = { status: 'error', email: null, source: 'none', signals: ['exception'], confidence: 0 };
  }
  const elapsed = Date.now() - t0;
  return { entity, cand, result: r, elapsed, siteFinderResult };
}

async function main() {
  const args = parseArgs(process.argv);
  const client = TableClient.fromConnectionString(
    process.env.LEADBASE_STORAGE_CONNECTION_STRING,
    'LeadBase',
  );

  console.log('═'.repeat(70));
  console.log('SMOKE VÉRITÉ — leads SIRENE post-ingestion');
  console.log(`départment   : ${args.departement}`);
  console.log(`n            : ${args.n}`);
  console.log(`SMTP_PROBE   : ${process.env.SMTP_PROBE_ENABLED || '(off)'}`);
  console.log('═'.repeat(70));

  const sample = await pullSireneIngestedLeads(client, args.departement, args.n, {
    nafFilter: isNafCible,
  });
  if (sample.length === 0) {
    console.error('Aucun lead SIRENE trouvé. As-tu lancé l\'ingestion ?');
    process.exit(1);
  }
  console.log(`\nÉchantillon retenu : ${sample.length} leads`);

  const adapters = {
    ...makeInMemoryCache(),
    dropcontact: new DropcontactAdapter({ enabled: false }), // zéro coût Dropcontact
  };

  const results = [];
  for (const e of sample) {
    process.stdout.write(`  [${e.siren}] ${(e.nom || '').slice(0, 40).padEnd(40)} `);
    const r = await runOne(e, adapters);
    results.push(r);
    const tag = r.siteFinderResult && r.siteFinderResult.siteUrl
      ? `[sf:${r.siteFinderResult.source}${r.siteFinderResult.skippedAggregator ? ':AGG' : ''}]`
      : (r.siteFinderResult && r.siteFinderResult.error ? '[sf:err]' : '[sf:none]');
    console.log(`${r.result.status === 'ok' ? '✓' : '·'} status=${r.result.status} src=${r.result.source} email=${r.result.email || '-'} ${r.elapsed}ms ${tag}`);
  }

  const total = results.length;
  const ok = results.filter((r) => r.result.status === 'ok').length;
  const bySource = {};
  for (const r of results) {
    const s = r.result.source || 'none';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  const avgLatency = Math.round(results.reduce((a, r) => a + r.elapsed, 0) / total);

  console.log('\n═'.repeat(70));
  console.log('RÉSUMÉ');
  console.log('═'.repeat(70));
  console.log(`Total               : ${total}`);
  console.log(`Résolus             : ${ok}/${total} (${total > 0 ? (100 * ok / total).toFixed(1) : 0}%)`);
  console.log(`Sources             : ${JSON.stringify(bySource)}`);
  console.log(`Latence moy.        : ${avgLatency}ms`);
  console.log(`Baseline 6 mai PM   : 0/10 (0%) sur leads non-SIRENE`);
  if (ok > 0) {
    console.log('\n  Exemples résolus :');
    for (const r of results.filter((x) => x.result.status === 'ok').slice(0, 3)) {
      console.log(`    ${r.entity.siren} ${(r.entity.nom || '').slice(0, 30)} → ${r.result.email} (${r.result.source}, conf ${(r.result.confidence || 0).toFixed(2)})`);
    }
  }

  // Rapport JSON pour analyse ultérieure
  const reportPath = `/tmp/smoke-sirene-ingested-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({
    args, total, ok, bySource, avgLatency,
    results: results.map((r) => ({
      siren: r.entity.siren,
      nom: r.entity.nom,
      tranche: r.entity.trancheEffectif,
      naf: r.entity.codeNaf,
      ville: r.entity.ville,
      hadSiteWeb: Boolean(r.entity.siteWeb),
      siteFinderResult: r.siteFinderResult,
      resultStatus: r.result.status,
      resultSource: r.result.source,
      resultEmail: r.result.email,
      resultConfidence: r.result.confidence,
      signals: r.result.signals,
      elapsedMs: r.elapsed,
    })),
  }, null, 2));
  console.log(`\nRapport JSON : ${reportPath}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
