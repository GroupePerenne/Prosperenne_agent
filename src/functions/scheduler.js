/**
 * Timer trigger — toutes les 15 minutes.
 *
 * Consomme la queue des touches différées (J0 reporté + J+4 / J+10 / J+18 / J+28).
 * Pour chaque message visible :
 *   - Si `targetDate` est dans le futur → re-queue (via rescheduleIfNotDue)
 *     et passe au suivant. Utilisé pour les échéances > 7 jours, car la
 *     limite Azure Queue Storage est 7 jours de visibilityTimeout.
 *   - Si dû → délègue au worker (Martin ou Mila), supprime le message
 *     si succès, laisse revenir en retry sinon.
 *
 * La queue garantit at-least-once. Les contenus sont pré-générés au J0
 * pour ne jamais refaire un appel LLM à l'échéance.
 */

const { app } = require('@azure/functions');
const { receiveDueRelances, deleteRelance, rescheduleIfNotDue } = require('../../shared/queue');
const martin = require('../../agents/martin/worker');
const mila = require('../../agents/mila/worker');

const AGENTS = { martin, mila };

app.timer('scheduler', {
  schedule: '0 */15 * * * *',
  handler: async (myTimer, context) => {
    const startedAt = new Date().toISOString();
    context.log(`scheduler tick @ ${startedAt}`);

    try {
      const dueJobs = await receiveDueRelances(16);
      if (dueJobs.length === 0) {
        context.log('rien à envoyer');
        return;
      }

      context.log(`${dueJobs.length} message(s) visible(s)`);
      const results = [];

      for (const job of dueJobs) {
        const { body, messageId, popReceipt } = job;

        // Échéance pas encore atteinte → re-queue avec la visibility restante
        if (body.targetDate) {
          const rescheduled = await rescheduleIfNotDue(body, { messageId, popReceipt });
          if (rescheduled) {
            results.push({ agent: body.agent, day: body.day, lead: body.lead?.email, action: 'rescheduled' });
            continue;
          }
        }

        try {
          const agent = AGENTS[body.agent];
          if (!agent) throw new Error(`Agent inconnu : ${body.agent}`);

          const res = await agent.sendStep(body);
          await deleteRelance({ messageId, popReceipt });
          results.push({ agent: body.agent, day: body.day, lead: body.lead?.email, ...res });
        } catch (err) {
          context.error(`échec ${body.agent}/${body.day}/${body.lead?.email}: ${err.message}`);
          results.push({ agent: body.agent, day: body.day, lead: body.lead?.email, error: err.message });
        }
      }

      context.log('résultats:', JSON.stringify(results));
    } catch (err) {
      context.error('scheduler global error:', err);
    }
  },
});
