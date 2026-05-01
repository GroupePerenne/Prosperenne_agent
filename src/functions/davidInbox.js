/**
 * Timer trigger — toutes les 5 minutes.
 *
 * Lit les boîtes des commerciaux (martin@, mila@) ET la boîte David, route
 * chaque message non lu via Claude (classe entre prospect_reply /
 * consultant_message / internal / spam), et déclenche l'action appropriée
 * (réponse, transfert, archivage).
 *
 * Architecture multi-mailbox depuis chantier VP socle 1er mai 2026 :
 *   - Martin et Mila opèrent depuis leur propre adresse (positionnement
 *     éthique, pas de mode fantôme), replyTo = leur adresse, donc les
 *     réponses prospects arrivent dans MARTIN_EMAIL et MILA_EMAIL.
 *   - David garde sa boîte pour : messages consultants directs,
 *     escalations, interventions hiérarchiques ponctuelles.
 *
 * Cf. agents/david/value-proposition.md §8 + agents/david/orchestrator.js
 * handleInboxPoll.
 */

const { app } = require('@azure/functions');
const { handleInboxPoll } = require('../../agents/david/orchestrator');
const { makeSafeLogger } = require('../../shared/safe-log');

app.timer('davidInbox', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    try {
      const mailboxes = [
        process.env.MARTIN_EMAIL,
        process.env.MILA_EMAIL,
        process.env.DAVID_EMAIL,
      ].filter(Boolean);
      const results = await handleInboxPoll({ context, mailboxes });
      if (results.length === 0) {
        log('inbox commerciaux + David : rien de nouveau');
        return;
      }
      log(`inbox commerciaux + David : ${results.length} message(s) traité(s) sur ${mailboxes.length} boîte(s)`);
      for (const r of results) {
        log(`  - [${r.mailbox || '?'}] [${r.classe || 'err'}] ${r.subject || r.id}: ${r.resume_humain || r.error || ''}`);
      }
    } catch (err) {
      log.error('davidInbox error:', err);
    }
  },
});
