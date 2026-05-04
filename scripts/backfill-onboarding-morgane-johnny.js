'use strict';

/**
 * Backfill rétroactif PWA-M Cycle 1.
 *
 * Insère 2 rows consultantOnboarding pour Morgane DE JESSEY et Johnny SERRA
 * avec sentAt=2026-05-01T18:11:00+02:00 (timestamp réel envoi mail
 * d'onboarding David, cf. mémoire Charli + dailyDigest 1er mai). Pas de
 * completedAt — au 4 mai 2026, ni l'un ni l'autre n'a rempli son formulaire
 * (3 daily digests successifs : pilote dormant).
 *
 * Pose aussi 2 rows davidActions type=onboarding_sent en cohérence.
 *
 * Charge AzureWebJobsStorage depuis local.settings.json (gitignored).
 *
 * Idempotent : upsert sur PartitionKey=consultant, RowKey=email lowercase.
 * Action insert avec un rowKey unique (timestamp inversé + rand) — relancer
 * créera des doublons côté davidActions (acceptable, audit log).
 */

const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'local.settings.json');
if (!fs.existsSync(settingsPath)) {
  console.error('local.settings.json absent — fetch via func azure functionapp fetch-app-settings');
  process.exit(1);
}
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const conn = settings.Values && settings.Values.AzureWebJobsStorage;
if (!conn) {
  console.error('AzureWebJobsStorage absent de local.settings.json');
  process.exit(1);
}
process.env.AzureWebJobsStorage = conn;

const { recordOnboardingSent } = require('../shared/storage-tables/consultantOnboarding');
const { recordAction } = require('../shared/storage-tables/davidActions');

const SENT_AT = '2026-05-01T18:11:00+02:00';
const CONSULTANTS = [
  { email: 'm.dejessey@oseys.fr', name: 'Morgane DE JESSEY' },
  { email: 'j.serra@oseys.fr', name: 'Johnny SERRA' },
];

(async () => {
  for (const c of CONSULTANTS) {
    const onboardingResult = await recordOnboardingSent({
      consultantEmail: c.email,
      consultantName: c.name,
      sentAt: SENT_AT,
    });
    const actionResult = await recordAction({
      consultantEmail: c.email,
      type: 'onboarding_sent',
      summary: `Mail d'onboarding David envoyé à ${c.name} (backfill rétroactif PWA-M)`,
      metadata: { from: 'david@oseys.fr', backfill: true, source: 'PWA-M Cycle 1' },
      at: SENT_AT,
    });
    console.log(`✓ ${c.email}`, {
      onboarding: onboardingResult ? onboardingResult.status : 'NO_OP',
      action: actionResult ? actionResult.type : 'NO_OP',
    });
  }
  console.log('done');
})().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
