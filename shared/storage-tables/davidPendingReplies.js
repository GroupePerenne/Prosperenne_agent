'use strict';

/**
 * Queue de réponses davidInbox différées via Azure Storage Table.
 *
 * Contexte (12 mai 2026, doctrine jitter humain) :
 *   davidInbox classifie un mail entrant (consultant ou prospect) puis
 *   appelait sendMail en direct → latence ≤ 5 min, robotique. Désormais
 *   on enqueue ici avec un scheduledAt calculé par shared/jitter.js, et
 *   un cron flusher (davidReplyFlusher, toutes les 15 min) envoie les
 *   replies dont scheduledAtIso <= now.
 *
 * Schéma :
 *   PartitionKey : 'pending'
 *   RowKey       : `{scheduledAtIso}_{uuid}` (ISO 8601 sortable lexicalement)
 *   scheduledAtIso, createdAtIso
 *   mailbox, to, subject, html, ccJson
 *   originalMessageId, originalSubject, originalSender
 *   senderType ('prospect'|'consultant'|'internal'), prospectClass, jitterKind
 *   status ('pending'|'sent'|'failed')
 *   sentAtIso, errorMessage
 *   dealId, consultantEmail (observabilité)
 *
 * Idempotence : pas de dédup côté table — repose sur le markAsRead Graph
 * dans handleInboxPoll. Si le handler crash entre enqueue et markAsRead,
 * un double-enqueue est possible (rare). Acceptable pour MVP.
 */

const { randomUUID } = require('node:crypto');
const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.DAVID_PENDING_REPLIES_TABLE || 'DavidPendingReplies';
const MAX_FLUSH_PER_TICK = Number(process.env.DAVID_FLUSH_MAX_PER_TICK || 50);

/**
 * Enqueue une réponse différée.
 *
 * @param {object} entry
 * @param {string} entry.mailbox         - boîte d'envoi (david@, martin@, mila@)
 * @param {string} entry.to              - destinataire
 * @param {string} entry.subject
 * @param {string} entry.html
 * @param {string[]} [entry.cc]
 * @param {Date} entry.scheduledAt       - instant cible d'envoi
 * @param {string} entry.senderType      - prospect|consultant|internal
 * @param {string} [entry.prospectClass] - positive|question|... ou null
 * @param {string} [entry.jitterKind]    - prospect|consultant
 * @param {string} [entry.originalMessageId]
 * @param {string} [entry.originalSubject]
 * @param {string} [entry.originalSender]
 * @param {string|number} [entry.dealId]
 * @param {string} [entry.consultantEmail]
 * @returns {Promise<{enqueued: boolean, rowKey: string, scheduledAtIso: string, reason?: string}>}
 */
async function enqueuePendingReply(entry) {
  const client = getTableClient(TABLE_NAME);
  const scheduledAtIso = entry.scheduledAt instanceof Date
    ? entry.scheduledAt.toISOString()
    : new Date(entry.scheduledAt).toISOString();
  const rowKey = `${scheduledAtIso}_${randomUUID()}`;

  if (!client) {
    return { enqueued: false, rowKey, scheduledAtIso, reason: 'no_storage' };
  }
  await ensureTable(client, TABLE_NAME);

  try {
    await client.createEntity({
      partitionKey: 'pending',
      rowKey,
      scheduledAtIso,
      createdAtIso: new Date().toISOString(),
      mailbox: String(entry.mailbox || ''),
      to: String(entry.to || ''),
      subject: String(entry.subject || ''),
      html: String(entry.html || ''),
      ccJson: entry.cc && entry.cc.length ? JSON.stringify(entry.cc) : null,
      originalMessageId: String(entry.originalMessageId || ''),
      originalConversationId: String(entry.originalConversationId || ''),
      originalSubject: String(entry.originalSubject || ''),
      originalSender: String(entry.originalSender || ''),
      senderType: String(entry.senderType || ''),
      prospectClass: entry.prospectClass ? String(entry.prospectClass) : null,
      jitterKind: String(entry.jitterKind || ''),
      status: 'pending',
      sentAtIso: null,
      errorMessage: null,
      dealId: entry.dealId != null ? String(entry.dealId) : null,
      consultantEmail: entry.consultantEmail ? String(entry.consultantEmail) : null,
    });
    return { enqueued: true, rowKey, scheduledAtIso };
  } catch (err) {
    return { enqueued: false, rowKey, scheduledAtIso, reason: 'create_failed', error: err.message };
  }
}

/**
 * Liste les entries dont scheduledAtIso <= now et status === 'pending'.
 * Limite à MAX_FLUSH_PER_TICK pour ne pas surcharger un tick de cron.
 */
async function listDueReplies(now = new Date()) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return [];
  await ensureTable(client, TABLE_NAME);

  const nowIso = now.toISOString();
  const due = [];
  // Filter sur scheduledAtIso (RowKey préfixé par scheduledAtIso aussi, donc range
  // query sur RowKey serait également efficace, mais on garde le filter sur le champ
  // pour clarté).
  const iter = client.listEntities({
    queryOptions: {
      filter: `PartitionKey eq 'pending' and status eq 'pending' and scheduledAtIso le '${nowIso}'`,
    },
  });
  for await (const entity of iter) {
    due.push(entity);
    if (due.length >= MAX_FLUSH_PER_TICK) break;
  }
  return due;
}

/**
 * Marque une entry comme envoyée.
 */
async function markSent(rowKey, sentAt = new Date()) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return;
  try {
    await client.updateEntity({
      partitionKey: 'pending',
      rowKey,
      status: 'sent',
      sentAtIso: sentAt.toISOString(),
      errorMessage: null,
    }, 'Merge');
  } catch {
    // Best effort
  }
}

/**
 * Marque une entry comme échouée (avec message d'erreur).
 */
async function markFailed(rowKey, errorMessage) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return;
  try {
    await client.updateEntity({
      partitionKey: 'pending',
      rowKey,
      status: 'failed',
      errorMessage: String(errorMessage || '').slice(0, 500),
    }, 'Merge');
  } catch {
    // Best effort
  }
}

/**
 * Helper de haut niveau pour le cron flusher : récupère les dues, envoie via
 * sendFn(entity) (injection pour test), marque sent/failed. Retourne stats.
 *
 * @param {object} opts
 * @param {function} opts.sendFn - async (entity) => void ; throw si KO
 * @param {Date} [opts.now] - pour tests déterministes
 * @param {function} [opts.log] - logger
 */
async function flushDueReplies({ sendFn, now = new Date(), log = () => {} } = {}) {
  if (typeof sendFn !== 'function') throw new Error('flushDueReplies requires sendFn');
  const due = await listDueReplies(now);
  const stats = { total: due.length, sent: 0, failed: 0 };
  for (const entity of due) {
    try {
      await sendFn(entity);
      await markSent(entity.rowKey, new Date());
      stats.sent++;
      log(`[davidReplyFlusher] sent ${entity.rowKey} → ${entity.to}`);
    } catch (err) {
      await markFailed(entity.rowKey, err && err.message);
      stats.failed++;
      log(`[davidReplyFlusher] FAILED ${entity.rowKey} → ${entity.to}: ${err && err.message}`);
    }
  }
  return stats;
}

module.exports = {
  enqueuePendingReply,
  listDueReplies,
  markSent,
  markFailed,
  flushDueReplies,
  _TABLE_NAME: TABLE_NAME,
  _MAX_FLUSH_PER_TICK: MAX_FLUSH_PER_TICK,
};
