#!/usr/bin/env node
'use strict';

/**
 * Lead Selector — exécution LOCALE sur Mac Air (MVP Air Worker tactique).
 *
 * Né de l'incident 2026-05-05 PM : élargissement zone Morgane 10→30km a fait
 * timeout selectCandidates dans la fenêtre 10 min Linux Consumption de la
 * Function App `pereneo-mail-sender`. Bypass tactique : exécuter le pipeline
 * complet en local Node sur le Mac Air, sans contrainte timeout.
 *
 * Réplique la logique de leadSelectorJobQueue.js (handler queue trigger FA),
 * en passant un mock context minimal.
 *
 * Usage:
 *   node scripts/run-lead-selector-locally.js <consultantId> [--batch-size=N] [--dry-run]
 *
 * Exemples:
 *   node scripts/run-lead-selector-locally.js m.dejessey@oseys.fr --batch-size=3 --dry-run
 *   node scripts/run-lead-selector-locally.js j.serra@oseys.fr --batch-size=3
 *
 * --dry-run : enrichBatch tourne réellement (Dropcontact, scraping) mais
 *             launchSequenceForConsultant n'est PAS appelé (pas de mail
 *             envoyé, pas de deal Pipedrive créé). Pour valider le pool de
 *             leads avant envoi réel.
 */

const fs = require('fs');
const path = require('path');

// Bootstrap env depuis local.settings.json
const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  Object.assign(process.env, settings.Values || {});
}

// CLI args
const args = process.argv.slice(2);
const consultantId = args.find((a) => !a.startsWith('--'));
const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
const dryRun = args.includes('--dry-run');
const batchSize = batchSizeArg ? Number(batchSizeArg.split('=')[1]) : 3;

if (!consultantId) {
  console.error('Usage: node run-lead-selector-locally.js <consultantId> [--batch-size=N] [--dry-run]');
  process.exit(1);
}

// Mock context (Azure Function-like) avec safe logger interface
const ctx = {
  log: (...a) => console.log('[ctx]', ...a),
};
ctx.log.warn = (...a) => console.warn('[warn]', ...a);
ctx.log.error = (...a) => console.error('[err]', ...a);
ctx.log.info = (...a) => console.log('[info]', ...a);
ctx.warn = ctx.log.warn;
ctx.error = ctx.log.error;
ctx.info = ctx.log.info;

const { enrichAndProfileBatchForConsultant } = require('../shared/enrichAndProfileBatch');
const { launchSequenceForConsultant } = require('../agents/david/orchestrator');
const { parseBriefFromMemories } = require('../shared/leadSelector');
const { getMem0 } = require('../shared/adapters/memory/mem0');

const LOCAL_BRIEFS_DIR = path.join(process.env.HOME || '', '.config/pereneo/consultants');

function buildPayload(originalBrief, consultantId) {
  return {
    consultant: {
      nom: originalBrief.nom,
      email: originalBrief.email,
      offre: originalBrief.offre,
      ton: originalBrief.registre,
      tutoiement: originalBrief.vouvoiement === 'tu',
    },
    brief: { prospecteur: originalBrief.prospecteur || 'both' },
    originalBrief,
    beneficiaryId: `oseys-${String(consultantId).split('@')[0] || 'unknown'}`,
  };
}

function loadLocalBrief(consultantId) {
  const file = path.join(LOCAL_BRIEFS_DIR, `${consultantId}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const brief = data.brief || data;
  if (!brief.nom || !brief.email) {
    throw new Error(`Local brief ${file} missing required fields nom/email`);
  }
  return { brief, source: file, meta: data._meta || null };
}

async function rebuildConsultantFromMem0(consultantId) {
  const mem0 = getMem0(ctx);
  if (!mem0) throw new Error('Mem0 client unavailable (check MEM0_API_KEY env)');
  const memories = await mem0.retrieveConsultant(consultantId);
  if (!memories || memories.length === 0) {
    throw new Error(`No memories for consultant ${consultantId}`);
  }
  const originalBrief = parseBriefFromMemories(memories);
  if (!originalBrief) throw new Error('parseBriefFromMemories returned null');
  return buildPayload(originalBrief, consultantId);
}

async function rebuildConsultant(consultantId) {
  const local = loadLocalBrief(consultantId);
  if (local) {
    console.log(`[brief] loaded from local file: ${local.source}`);
    if (local.meta && local.meta.brief_id) {
      console.log(`[brief] brief_id=${local.meta.brief_id} submitted_at=${local.meta.submitted_at || '?'}`);
    }
    return buildPayload(local.brief, consultantId);
  }
  console.log(`[brief] local file absent, fallback Mem0...`);
  return rebuildConsultantFromMem0(consultantId);
}

async function main() {
  const startTime = Date.now();
  console.log(`\n=== Lead Selector LOCAL run ===`);
  console.log(`consultantId : ${consultantId}`);
  console.log(`batchSize    : ${batchSize}`);
  console.log(`dryRun       : ${dryRun}`);
  console.log(`startedAt    : ${new Date().toISOString()}\n`);

  console.log('[step 1/3] rebuildConsultant (local-first, Mem0 fallback)...');
  const consultantPayload = await rebuildConsultant(consultantId);
  console.log(`  consultant   : ${consultantPayload.consultant.nom} <${consultantPayload.consultant.email}>`);
  console.log(`  zone_rayon   : ${consultantPayload.originalBrief.zone_rayon || '(absent → 25 default)'}km`);
  console.log(`  ville        : ${consultantPayload.originalBrief.ville}`);
  console.log(`  effectif     : ${consultantPayload.originalBrief.effectif}`);
  console.log(`  prospecteur  : ${consultantPayload.brief.prospecteur}`);
  console.log(`  beneficiary  : ${consultantPayload.beneficiaryId}`);

  console.log('\n[step 2/3] enrichAndProfileBatchForConsultant (selectCandidates + site-finder + exhauster)...');
  const result = await enrichAndProfileBatchForConsultant({
    brief: consultantPayload.originalBrief,
    beneficiaryId: consultantPayload.beneficiaryId,
    batchSize,
    dryRun: false, // pipeline réel : Dropcontact appelé, scraping fait
    consultantId,
    context: ctx,
  });

  const summary = {
    status: result.status,
    candidatesConsidered: result.meta?.candidatesConsidered || 0,
    leadsCount: (result.leads || []).length,
    resolutionOk: result.meta?.resolutionOk || 0,
    unresolvable: result.meta?.resolutionUnresolvable || 0,
    costCentsTotal: result.meta?.costCentsTotal || 0,
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
  };
  console.log('\n=== ENRICH SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  if (result.leads && result.leads.length > 0) {
    console.log('\n=== LEADS RÉSOLUS ===');
    for (const lead of result.leads) {
      const emailMasked = lead.email ? `${lead.email.split('@')[0].slice(0, 3)}***@${lead.email.split('@')[1]}` : '?';
      console.log(`  ${emailMasked} | ${lead.firstName} ${lead.lastName} | ${lead.companyName} | conf=${lead.emailConfidence ?? lead.confidence}`);
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] séquence Martin/Mila NON lancée. Pour envoi réel, rerun sans --dry-run.');
    return;
  }

  if (result.status === 'error' || result.status === 'empty' || (result.leads || []).length === 0) {
    console.log('\nAucun lead à séquencer. Fin.');
    return;
  }

  console.log('\n[step 3/3] launchSequenceForConsultant (envoi mails Martin/Mila + écriture Pipedrive)...');
  const seqResults = await launchSequenceForConsultant({
    consultant: consultantPayload.consultant,
    brief: consultantPayload.brief,
    leads: result.leads,
    context: ctx,
  });
  const okCount = seqResults.filter((r) => !r.error).length;
  const errorCount = seqResults.length - okCount;

  console.log('\n=== SEQUENCE RESULTS ===');
  console.log(`  ok     : ${okCount}`);
  console.log(`  errors : ${errorCount}`);
  for (const r of seqResults) {
    const tag = r.error ? 'ERR' : 'OK ';
    const email = r.lead?.email ? `${r.lead.email.split('@')[0].slice(0, 3)}***@${r.lead.email.split('@')[1]}` : '?';
    if (r.error) console.log(`  ${tag} ${email} : ${r.error}`);
    else console.log(`  ${tag} ${email} → dealId=${r.dealId || '?'} agent=${r.agent || '?'}`);
  }
  console.log(`\nTotal elapsed: ${Math.round((Date.now() - startTime) / 1000)}s`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
