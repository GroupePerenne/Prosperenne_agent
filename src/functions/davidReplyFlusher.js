'use strict';

/**
 * Timer trigger — toutes les 15 minutes.
 *
 * Consomme les réponses différées en attente (DavidPendingReplies) dont
 * scheduledAtIso <= now et les envoie via Microsoft Graph. Couche d'exécution
 * de la doctrine "jitter humain" (12 mai 2026, recadrage Paul) qui interdit
 * tout envoi instantané de davidInbox.
 *
 * Cohérence avec davidInbox.js (timer toutes 5 min qui enqueue) :
 *   - Poll plus rapide pour ingérer les nouveaux mails entrants
 *   - Flush plus lent (15 min) pour ne pas créer une cadence robotique
 *     d'envoi (les jitters sont uniformément distribués entre 5 et 45 min,
 *     donc 15 min de granularité est suffisant)
 */

const { app } = require('@azure/functions');
const { flushDueReplies } = require('../../shared/storage-tables/davidPendingReplies');
const { sendMail } = require('../../shared/graph-mail');
const { makeSafeLogger } = require('../../shared/safe-log');

async function sendFnFromEntity(entity) {
  const cc = entity.ccJson ? JSON.parse(entity.ccJson) : [];
  return sendMail({
    from: entity.mailbox,
    to: entity.to,
    cc,
    subject: entity.subject,
    html: entity.html,
  });
}

app.timer('davidReplyFlusher', {
  schedule: '0 */15 * * * *',
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    try {
      const stats = await flushDueReplies({
        sendFn: sendFnFromEntity,
        now: new Date(),
        log: (m) => log(m),
      });
      if (stats.total === 0) {
        log('[davidReplyFlusher] aucune réponse due pour ce tick');
      } else {
        log(`[davidReplyFlusher] flush terminé : total=${stats.total} sent=${stats.sent} failed=${stats.failed}`);
      }
    } catch (err) {
      log.error('[davidReplyFlusher] error:', err);
    }
  },
});
