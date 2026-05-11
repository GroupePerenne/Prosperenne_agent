'use strict';

/**
 * Idempotence des messages traités par davidInbox.
 *
 * Contexte (incident 11 mai 2026, 12 doublons à Johnny) :
 *   davidInbox poll les boîtes toutes les 5 min, classifie via Claude, envoie
 *   la réponse, puis appelle markAsRead. Si markAsRead échoue (cas vécu : la
 *   permission Graph était Mail.Read et non Mail.ReadWrite → 403 silencieux),
 *   le mail reste isRead=false et le prochain tick le retraite. Résultat :
 *   4 vagues de triple envoi à Johnny.
 *
 *   Mail.ReadWrite a été ajouté côté Azure AD 12 mai PM. Mais en défense en
 *   profondeur, cette table garantit qu'un même messageId n'est JAMAIS traité
 *   deux fois, même si markAsRead foire à nouveau pour une raison X (perm
 *   révoquée, panne Graph, race condition multi-instance, etc.).
 *
 * Pattern :
 *   handleInboxPoll appelle markProcessed(messageId) AVANT de classifier +
 *   enqueuePendingReply. Si createEntity throw 409 (déjà processed) → skip
 *   silencieux + markAsRead idempotent côté Graph (peut être re-tenté sans
 *   effet de bord).
 *
 * Schéma :
 *   PartitionKey : 'msg'
 *   RowKey       : messageId (sanitized — IDs Graph contiennent '/', '\', '#')
 *   processedAtIso, mailbox, classe, action, dealId, consultantEmail
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.DAVID_PROCESSED_MESSAGES_TABLE || 'DavidProcessedMessages';

/**
 * Sanitize un messageId Graph pour qu'il soit safe comme RowKey Azure Storage.
 * Caractères interdits dans RowKey : '/', '\\', '#', '?', '\t', '\n', '\r' et
 * caractères de contrôle. On replace par '_'.
 */
function sanitizeMessageId(messageId) {
  return String(messageId || '')
    .replace(/[\/\\#?\t\n\r]/g, '_')
    .slice(0, 1024);
}

/**
 * Tente de marquer un messageId comme processed. Atomique via createEntity.
 *
 * @param {object} args
 * @param {string} args.messageId
 * @param {string} [args.mailbox]
 * @param {string} [args.classe]
 * @param {string} [args.action]
 * @param {string|number} [args.dealId]
 * @param {string} [args.consultantEmail]
 * @returns {Promise<{alreadyProcessed: boolean, ok: boolean, reason?: string}>}
 */
async function markProcessed({ messageId, mailbox, classe, action, dealId, consultantEmail } = {}) {
  if (!messageId) return { alreadyProcessed: false, ok: false, reason: 'no_message_id' };
  const client = getTableClient(TABLE_NAME);
  if (!client) {
    // Best effort : pas de table dispo → autoriser (mais alerter)
    return { alreadyProcessed: false, ok: true, reason: 'no_storage_fallback' };
  }
  await ensureTable(client, TABLE_NAME);

  const rowKey = sanitizeMessageId(messageId);
  try {
    await client.createEntity({
      partitionKey: 'msg',
      rowKey,
      processedAtIso: new Date().toISOString(),
      mailbox: String(mailbox || ''),
      classe: String(classe || ''),
      action: String(action || ''),
      dealId: dealId != null ? String(dealId) : null,
      consultantEmail: consultantEmail ? String(consultantEmail) : null,
    });
    return { alreadyProcessed: false, ok: true };
  } catch (err) {
    if (err && err.statusCode === 409) {
      return { alreadyProcessed: true, ok: true };
    }
    // Erreur transitoire → pour ne pas re-traiter en boucle, on considère
    // "traité" en sortie dégradée. Le caller log l'erreur.
    return { alreadyProcessed: false, ok: false, reason: 'storage_error', error: err.message };
  }
}

/**
 * Lookup explicite pour debug : un messageId est-il déjà processed ?
 */
async function isProcessed(messageId) {
  if (!messageId) return false;
  const client = getTableClient(TABLE_NAME);
  if (!client) return false;
  try {
    await client.getEntity('msg', sanitizeMessageId(messageId));
    return true;
  } catch (err) {
    if (err && err.statusCode === 404) return false;
    return false;
  }
}

module.exports = {
  markProcessed,
  isProcessed,
  sanitizeMessageId,
  _TABLE_NAME: TABLE_NAME,
};
