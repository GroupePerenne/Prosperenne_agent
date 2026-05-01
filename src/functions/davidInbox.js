/**
 * Timer trigger — toutes les 5 minutes.
 *
 * Lit la boîte david@oseys.fr, route chaque message non lu via Claude
 * (classe entre prospect_reply / consultant_message / internal / spam),
 * et déclenche l'action appropriée (réponse, transfert, archivage).
 */

const { app } = require('@azure/functions');
const { handleInboxPoll } = require('../../agents/david/orchestrator');
const { makeSafeLogger } = require('../../shared/safe-log');

app.timer('davidInbox', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    try {
      const results = await handleInboxPoll({ context });
      if (results.length === 0) {
        log('boîte David : rien de nouveau');
        return;
      }
      log(`boîte David : ${results.length} message(s) traité(s)`);
      for (const r of results) {
        log(`  - [${r.classe || 'err'}] ${r.subject || r.id}: ${r.resume_humain || r.error || ''}`);
      }
    } catch (err) {
      log.error('davidInbox error:', err);
    }
  },
});
