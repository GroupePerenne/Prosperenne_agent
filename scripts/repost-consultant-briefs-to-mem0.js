'use strict';

/**
 * Repost briefs consultants Morgane + Johnny vers Mem0.
 *
 * Contexte 8 mai 2026 : tous les jobs lead-selector des 6, 7 et 8 mai matin
 * tombent en `consultant_not_found_in_mem0` malgré la présence des briefs
 * en Storage Table `consultantOnboarding`. Soit le brief n'a jamais été
 * écrit en Mem0 (timeout silent au moment du onQualification 4 mai), soit
 * il a été purgé.
 *
 * Ce script lit les responses Storage Table (le format `consultantMemory`
 * exact attendu par parseBriefFromMemories → reviveBriefFromConsultantMemory)
 * et le repost en Mem0 via storeConsultant. Idempotent : Mem0 dédoublonne
 * avec infer:false sur le content stable.
 *
 * Usage :
 *   node scripts/repost-consultant-briefs-to-mem0.js
 *
 * Env requises (chargées depuis local.settings.json) :
 *   AzureWebJobsStorage   pour lire consultantOnboarding
 *   MEM0_API_KEY          pour storeConsultant Mem0 SaaS
 */

const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (!fs.existsSync(settingsPath)) {
  console.error('local.settings.json absent — run: func azure functionapp fetch-app-settings pereneo-mail-sender');
  process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
for (const [k, v] of Object.entries(settings.Values || {})) {
  if (!process.env[k]) process.env[k] = v;
}
if (!process.env.AzureWebJobsStorage) {
  console.error('AzureWebJobsStorage manquant');
  process.exit(1);
}
if (!process.env.MEM0_API_KEY) {
  console.error('MEM0_API_KEY manquant');
  process.exit(1);
}

const { getConsultant } = require('../shared/storage-tables/consultantOnboarding');
const { Mem0Adapter } = require('../shared/adapters/memory/mem0');

const CONSULTANTS = [
  'm.dejessey@oseys.fr',
  'j.serra@oseys.fr',
];

(async () => {
  const mem0 = new Mem0Adapter({
    timeoutMs: 30000, // tolérant timeout pour repost
    logger: console.log,
  });

  const results = [];
  for (const consultantId of CONSULTANTS) {
    const t0 = Date.now();
    const out = { consultantId, storage: null, mem0: null, elapsedMs: 0, error: null };
    try {
      const record = await getConsultant(consultantId);
      if (!record) {
        out.error = 'storage_table_not_found';
        results.push(out);
        continue;
      }
      out.storage = {
        status: record.status,
        completedAt: record.completedAt,
        hasResponses: Boolean(record.responses && record.responses.display_name),
      };
      if (!out.storage.hasResponses) {
        out.error = 'storage_responses_missing_display_name';
        results.push(out);
        continue;
      }

      const memory = record.responses;
      console.log(`\n[${consultantId}] Storage OK — display_name="${memory.display_name}" zone_rayon=${memory.zone_rayon} ville="${memory.ville}"`);
      console.log(`[${consultantId}] → posting to Mem0 storeConsultant…`);

      const mem0Res = await mem0.storeConsultant(consultantId, memory);
      out.mem0 = mem0Res ? 'success' : 'degraded_or_null';
      out.elapsedMs = Date.now() - t0;
    } catch (err) {
      out.error = err && err.message;
      out.elapsedMs = Date.now() - t0;
    }
    results.push(out);
  }

  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('RÉSUMÉ');
  console.log('══════════════════════════════════════════════════════════════════════');
  for (const r of results) {
    const status = r.error ? `✗ ${r.error}` : `✓ Mem0 ${r.mem0}`;
    console.log(`${r.consultantId.padEnd(30)} ${status} (${r.elapsedMs}ms)`);
  }

  const allOk = results.every((r) => !r.error && r.mem0 === 'success');
  console.log(`\n→ Verdict : ${allOk ? 'TOUT OK — pipeline Lead Selector débloqué' : 'PARTIEL — voir détails ci-dessus'}`);
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
