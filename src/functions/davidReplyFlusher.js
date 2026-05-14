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
const { sendMail, replyToMessage } = require('../../shared/graph-mail');
const { makeSafeLogger } = require('../../shared/safe-log');

/**
 * Envoi effectif d'une entry pending.
 *
 * Plan v3.1 Pilier 2 — thread mail : si `originalMessageId` est posé sur
 * l'entry (donc on a un ancrage thread côté Graph dans la boîte d'envoi),
 * on utilise l'endpoint natif Graph `/messages/{id}/reply` qui chaîne
 * automatiquement les headers `In-Reply-To` + `References`. David apparaît
 * dans le thread du prospect (scénario E2E 4), sans table EmailThreads custom.
 *
 * Fallback : pour les entries sans originalMessageId (rares, cas legacy ou
 * messages où msg.id absent), on retombe sur sendMail brut. Le mail part,
 * mais hors thread (acceptable transitoirement).
 *
 * Note : on n'utilise PAS entity.cc en mode reply natif, parce que la doc
 * Graph /reply ne supporte que `comment` + `message.toRecipients` au niveau
 * du payload (le cc se positionne via message.ccRecipients). Pour rester
 * minimal et préserver le thread, on laisse Graph ne mettre que le sender
 * original en to + nos cc en ccRecipients si présents.
 */
async function sendFnFromEntity(entity) {
  const cc = entity.ccJson ? JSON.parse(entity.ccJson) : [];

  if (entity.originalMessageId && entity.mailbox) {
    return replyToMessage({
      from: entity.mailbox,
      messageId: entity.originalMessageId,
      html: entity.html,
    });
  }

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
