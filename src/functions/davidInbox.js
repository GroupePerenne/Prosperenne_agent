/**
 * Timer trigger — toutes les 5 minutes.
 *
 * Lit la boîte david@oseys.fr, route chaque message non lu via Claude
 * (classe entre prospect_reply / consultant_message / internal / spam),
 * et déclenche l'action appropriée (réponse, transfert, archivage).
 */

const { app } = require('@azure/functions');
const { handleInboxPoll } = require('../../agents/david/orchestrator');

app.timer('davidInbox', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    try {
      const results = await handleInboxPoll({ context });
      if (results.length === 0) {
        context.log('boîte David : rien de nouveau');
        return;
      }
      context.log(`boîte David : ${results.length} message(s) traité(s)`);
      for (const r of results) {
        context.log(`  - [${r.classe || 'err'}] ${r.subject || r.id}: ${r.resume_humain || r.error || ''}`);
      }
    } catch (err) {
      context.error('davidInbox error:', err);
    }
  },
});
