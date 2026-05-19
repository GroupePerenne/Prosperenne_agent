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
const { canReplyToThreadToday, incrementThreadReply } = require('../../shared/threadReplyCap');
const { detectBurst, recordOutboundSend } = require('../../shared/threadBurstDetector');

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

  // Plan v3.1 Pilier 3 — cap "1 réponse/fil/jour" (niveau 2) : protection
  // anti-boucle dure. Si David a déjà répondu aujourd'hui dans cette
  // conversation, on SKIP même si la réponse était sémantiquement justifiée.
  // Best effort sur le check : Storage indispo → on autorise (graceful
  // degradation, un anti-boucle ne doit pas bloquer le business sur panne
  // Storage).
  const conversationId = entity.originalConversationId || '';
  if (conversationId) {
    const cap = await canReplyToThreadToday(conversationId);
    if (!cap.ok) {
      const err = new Error(`thread_daily_cap_reached:${cap.count}/${cap.max}`);
      err.skipped = true;
      err.reason = 'thread_daily_cap_reached';
      throw err;
    }
    // Niveau 3 — filet de sécurité burst (N sortants <W min). Activé même
    // si le cap quotidien est lâche (override env var) ou foiré runtime.
    const burst = await detectBurst(conversationId);
    if (burst.burst) {
      const err = new Error(`thread_burst_detected:${burst.count}/${burst.threshold}_in_${burst.windowMinutes}min`);
      err.skipped = true;
      err.reason = 'thread_burst_detected';
      err.burstMeta = burst;
      throw err;
    }
  }

  let result;
  if (entity.originalMessageId && entity.mailbox) {
    result = await replyToMessage({
      from: entity.mailbox,
      messageId: entity.originalMessageId,
      html: entity.html,
    });
  } else {
    result = await sendMail({
      from: entity.mailbox,
      to: entity.to,
      cc,
      subject: entity.subject,
      html: entity.html,
    });
  }

  // Increment compteur fil post-envoi (niveau 2 + niveau 3).
  // Fire-and-forget : la trace ne doit jamais bloquer l'envoi déjà réussi.
  if (conversationId) {
    incrementThreadReply(conversationId).catch(() => {});
    recordOutboundSend(conversationId, { subject: entity.subject }).catch(() => {});
  }

  // Sprint 1 mémoire David (18 mai 2026) — record outbound dans DavidMemory.
  // Best effort, fire-and-forget : ne JAMAIS bloquer un envoi déjà parti.
  const recipientForMemory = Array.isArray(entity.to) ? entity.to[0] : entity.to;
  if (recipientForMemory) {
    require('../../shared/storage-tables/davidMemory')
      .recordMessage({
        interlocutorEmail: recipientForMemory,
        direction: 'outbound',
        mailbox: entity.mailbox,
        subject: entity.subject,
        body: entity.html,
        messageId: result && (result.internetMessageId || result.graphMessageId || entity.originalMessageId),
        conversationId: entity.originalConversationId || (result && result.conversationId),
        sentAt: new Date().toISOString(),
      })
      .catch(() => {});
  }

  return result;
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
