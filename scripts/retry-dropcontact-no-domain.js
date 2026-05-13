#!/usr/bin/env node
'use strict';

/**
 * Retry Dropcontact sur les LeadContacts marqués no_domain (= Dropcontact
 * jamais appelé à cause de la condition skip_no_domain levée le 13 mai
 * 2026, commit 5921b3e). Permet de récupérer du flux activable sans
 * dépendre de siteFinder (Playwright Google rate-limited via IP partagée
 * Mac Paul / Mac Air).
 *
 * Cible business : sur 4006 leads "cascade.dropcontact.miss" avec
 * domain absent, 99.3% n'ont JAMAIS été soumis à Dropcontact. Mesure
 * ad-hoc 13 mai 2026 16h sur 5 SIRENs : 40% hit rate Dropcontact sans
 * domain (extrapolation : ~1600 emails récupérables sur les 4006 cache).
 *
 * Usage :
 *   node scripts/retry-dropcontact-no-domain.js [options]
 *
 * Options :
 *   --beneficiary <id>     Filtrer par beneficiaryId (ou 'null' pour FILL,
 *                          ou comma-separated 'a,b,c'). Défaut 'all'.
 *   --max-leads <n>        Cap leads testés (protège budget). Défaut 100.
 *   --confidence-cutoff <c>  Ignorer leads avec confidence >= c. Défaut 0.4.
 *   --dry-run              Affiche sélection sans appeler Dropcontact.
 *   --verbose              Log chaque lead (sinon progression /20).
 *
 * Variables env requises :
 *   AzureWebJobsStorage             (LeadContacts)
 *   LEADBASE_STORAGE_CONNECTION_STRING (LeadBase)
 *   DROPCONTACT_API_KEY             (Dropcontact auth)
 *   DROPCONTACT_ENABLED=true
 *   DROPCONTACT_API_URL=https://api.dropcontact.io/batch
 *   DROPCONTACT_MONTHLY_BUDGET_CENTS=2400 (cap budget protection)
 *
 * R-CRED : aucune clé/CS jamais affichée dans les logs. Le run écrit
 * uniquement compteurs + sample emails récupérés.
 */

const { TableClient } = require('@azure/data-tables');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');

const DEFAULT_MAX = 100;
const DEFAULT_CONFIDENCE_CUTOFF = 0.4;
const DEFAULT_MIN_HIT_CONFIDENCE = 0.5;

function parseArgs(argv) {
  const opts = {
    beneficiary: 'all',
    maxLeads: DEFAULT_MAX,
    confidenceCutoff: DEFAULT_CONFIDENCE_CUTOFF,
    dryRun: false,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--beneficiary') opts.beneficiary = argv[++i];
    else if (a === '--max-leads') opts.maxLeads = parseInt(argv[++i], 10);
    else if (a === '--confidence-cutoff') opts.confidenceCutoff = parseFloat(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return opts;
}

function printHelp() {
  console.log(`
Retry Dropcontact sur LeadContacts no_domain.

Usage : node scripts/retry-dropcontact-no-domain.js [options]

Options :
  --beneficiary <id>      'all', 'null' (= FILL), ou comma-separated 'oseys-m.dejessey,oseys-j.serra'
  --max-leads <n>         Cap leads testés (défaut ${DEFAULT_MAX})
  --confidence-cutoff <c> Ignorer leads conf >= c (défaut ${DEFAULT_CONFIDENCE_CUTOFF})
  --dry-run               Affiche sélection sans Dropcontact
  --verbose               Log chaque lead
  -h, --help              Cette aide

Exemples :
  # Retest briefs ciblés uniquement, cap 150
  node scripts/retry-dropcontact-no-domain.js --beneficiary oseys-m.dejessey,oseys-j.serra,oseys-eliemougel --max-leads 150

  # Retest FILL national, cap 300
  node scripts/retry-dropcontact-no-domain.js --beneficiary null --max-leads 300

  # Tout, dry-run pour voir le scope
  node scripts/retry-dropcontact-no-domain.js --dry-run --max-leads 500
`);
}

function matchesBeneficiary(entityBen, filter) {
  if (filter === 'all') return true;
  if (filter === 'null') return entityBen === null || entityBen === undefined;
  const allowed = filter.split(',').map((s) => s.trim());
  return allowed.includes(String(entityBen || ''));
}

async function main() {
  const opts = parseArgs(process.argv);
  const conn = process.env.AzureWebJobsStorage;
  const lbConn = process.env.LEADBASE_STORAGE_CONNECTION_STRING;
  if (!conn || !lbConn) {
    console.error('AzureWebJobsStorage et LEADBASE_STORAGE_CONNECTION_STRING requis');
    process.exit(1);
  }

  console.log('=== retry-dropcontact-no-domain.js ===');
  console.log('Options:', JSON.stringify(opts));
  console.log();

  const lc = TableClient.fromConnectionString(conn, 'LeadContacts');
  const lb = TableClient.fromConnectionString(lbConn, 'LeadBase');

  // Step 1 : collecte targets
  console.log('Step 1 : Sélection leads no_domain…');
  const targets = [];
  // I-2 OK: script ad hoc lecture seule LeadContacts (pas LeadBase Couche 1).
  // LeadContacts est cache email résolu, scan complet attendu pour selection.
  for await (const e of lc.listEntities({ queryOptions: { select: ['partitionKey', 'rowKey', 'signals', 'beneficiaryId', 'source', 'confidence'] } })) {
    if (!matchesBeneficiary(e.beneficiaryId, opts.beneficiary)) continue;
    if (Number(e.confidence || 0) >= opts.confidenceCutoff) continue;
    const sigs = String(e.signals || '');
    if (/cascade\.dropcontact\.hit|cascade\.dropcontact\.miss_post_scrape/.test(sigs)) continue;
    if (/sf\.playwright_google/.test(sigs)) continue; // domain trouvé, traité ailleurs
    targets.push({ siren: e.partitionKey, rowKey: e.rowKey, beneficiaryId: e.beneficiaryId });
    if (targets.length >= opts.maxLeads * 2) break; // marge avant filtre LeadBase
  }
  console.log(`Leads no_domain ciblés (avant filtre LeadBase) : ${targets.length}`);

  // Step 2 : enrichir via LeadBase
  console.log('Step 2 : Récupération firstName/lastName/companyName via LeadBase…');
  const leads = [];
  for (const t of targets) {
    if (leads.length >= opts.maxLeads) break;
    let entity = null;
    // I-2 OK: script ad hoc lecture seule LeadBase, filtre RowKey exact (= SIREN),
    // 1 entity max retournée. Pas de scan large.
    for await (const e of lb.listEntities({ queryOptions: { filter: `RowKey eq '${t.siren}'` } })) {
      entity = e;
      break;
    }
    if (!entity) continue;
    let dirs = [];
    try { dirs = JSON.parse(entity.dirigeants || '[]'); } catch { continue; }
    if (!dirs.length) continue;
    const d = dirs[0];
    const firstName = String(d.prenoms || d.prenom || '').split(/\s+/)[0];
    const lastName = String(d.nom || '').split(/\s+/)[0];
    if (!firstName || !lastName || !entity.nom) continue;
    leads.push({
      siren: t.siren,
      rowKey: t.rowKey,
      beneficiaryId: t.beneficiaryId,
      firstName,
      lastName,
      companyName: entity.nom,
      ville: entity.ville || '',
      codePostal: entity.codePostal || '',
    });
  }
  console.log(`Leads prêts Dropcontact : ${leads.length} (cap maxLeads=${opts.maxLeads})`);

  // Distribution par beneficiary pour rapport
  const byBen = {};
  for (const l of leads) byBen[l.beneficiaryId || 'null'] = (byBen[l.beneficiaryId || 'null'] || 0) + 1;
  console.log('Par beneficiaryId :', JSON.stringify(byBen));
  console.log();

  if (opts.dryRun) {
    console.log('=== DRY-RUN — pas d\'appel Dropcontact ===');
    leads.slice(0, 10).forEach((l) => console.log(' ', l.siren, l.firstName, l.lastName, '@', l.companyName, l.ville));
    console.log(`(${leads.length} total)`);
    return;
  }

  // Step 3 : Appel Dropcontact + upsert LeadContacts
  console.log('Step 3 : Appels Dropcontact…');
  const adapter = new DropcontactAdapter();
  console.log(`Dropcontact enabled=${adapter.enabled}, budget cap=${adapter.budgetCents}c`);
  console.log();

  let hits = 0, miss = 0, errors = 0, totalCost = 0;
  const hitList = [];
  const t0Run = Date.now();
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const t0 = Date.now();
    try {
      const res = await adapter.resolve({
        siren: lead.siren,
        firstName: lead.firstName,
        lastName: lead.lastName,
        companyName: lead.companyName,
        ville: lead.ville,
        codePostal: lead.codePostal,
      });
      const dt = Date.now() - t0;
      const cost = (res && res.cost_cents) || 0;
      totalCost += cost;
      const ok = res && res.email && res.confidence >= DEFAULT_MIN_HIT_CONFIDENCE;
      if (ok) {
        hits++;
        hitList.push({ siren: lead.siren, name: `${lead.firstName} ${lead.lastName}`, company: lead.companyName, email: res.email, conf: res.confidence });
        await lc.upsertEntity({
          partitionKey: lead.siren,
          rowKey: lead.rowKey,
          email: res.email,
          confidence: res.confidence,
          source: 'dropcontact',
          cost_cents: cost,
          signals: JSON.stringify(['cascade.dropcontact.hit', 'retry_after_skip_no_domain']),
          beneficiaryId: lead.beneficiaryId,
          domain: null,
          resolvedAt: new Date().toISOString(),
        }, 'Merge');
        if (opts.verbose) console.log(`  HIT ${lead.siren} ${lead.firstName} ${lead.lastName} → ${res.email} (conf ${res.confidence}) ${dt}ms`);
      } else {
        miss++;
        await lc.upsertEntity({
          partitionKey: lead.siren,
          rowKey: lead.rowKey,
          signals: JSON.stringify(['cascade.dropcontact.miss_no_domain', 'retry_after_skip_no_domain']),
          beneficiaryId: lead.beneficiaryId,
        }, 'Merge');
        if (opts.verbose) console.log(`  MISS ${lead.siren} ${lead.firstName} ${lead.lastName} ${dt}ms`);
      }
      if (!opts.verbose && (i + 1) % 20 === 0) {
        console.log(`  Progression ${i + 1}/${leads.length} | hits=${hits} (${(hits * 100 / (i + 1)).toFixed(0)}%) | cost=${totalCost}c`);
      }
    } catch (e) {
      errors++;
      console.log(`  ERROR ${lead.siren}: ${e.message}`);
    }
  }

  const elapsedS = Math.round((Date.now() - t0Run) / 1000);
  console.log();
  console.log('=== Résumé ===');
  console.log(`Total testés    : ${leads.length}`);
  console.log(`Hits (≥${DEFAULT_MIN_HIT_CONFIDENCE} conf) : ${hits} (${(hits * 100 / leads.length).toFixed(0)}%)`);
  console.log(`Miss            : ${miss}`);
  console.log(`Errors          : ${errors}`);
  console.log(`Cost total      : ${totalCost} cents`);
  console.log(`Durée          : ${elapsedS}s (~${(elapsedS / leads.length).toFixed(1)}s/lead)`);
  console.log();
  if (hitList.length > 0) {
    console.log('=== Emails récupérés (top 10) ===');
    hitList.slice(0, 10).forEach((h) => console.log(`  ${h.siren} ${h.name} | ${h.company} | ${h.email} (conf ${h.conf})`));
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
