'use strict';

/**
 * Cap "1 réponse/fil/jour" — protection anti-boucle David (plan v3.1
 * Pilier 3 + invariant cardinal #9).
 *
 * Contexte : même avec la détection auto-reply pré-Claude (Auto-Submitted,
 * OOO, vacation), il peut rester des cas tordus où David s'embarque dans
 * un échange en boucle avec un correspondant atypique (mailbot mal taggé,
 * répondeur sans headers standards, prospect qui appuie 5 fois sur "reply").
 *
 * Garde-fou DURE : maximum 1 réponse de David par fil de conversation
 * par jour. Si David a déjà répondu aujourd'hui dans cette conversation,
 * on skip toute nouvelle tentative — même si le contenu serait
 * sémantiquement justifié.
 *
 * Schéma table Storage `DavidThreadReplyCounter` :
 *   PartitionKey : conversationId (Graph)
 *   RowKey       : `YYYYMMDD` (date UTC)
 *   Colonnes     : count, lastSentAt (ISO), updatedAt (ISO)
 *
 * Coût : 1 read Storage par tentative d'envoi du flusher. Acceptable
 * (le flusher tourne toutes les 15 min, volumétrie 50 max/tick).
 *
 * Graceful degradation : Storage indispo → autorise (préserve continuité).
 * Discipline : un anti-boucle ne doit JAMAIS bloquer par défaut sur panne
 * Storage, sinon la panne crée elle-même un blocage business sauvage.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.DAVID_THREAD_REPLY_COUNTER_TABLE || 'DavidThreadReplyCounter';
const DEFAULT_MAX_PER_DAY = Number(process.env.DAVID_THREAD_REPLY_MAX_PER_DAY || 1);

let _client = null;
function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_NAME);
    return _client;
  } catch {
    return null;
  }
}

function _setClientForTests(client) { _client = client; }
function _resetForTests() { _client = null; }

function dateKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Vérifie si David peut répondre dans ce fil aujourd'hui.
 *
 * @param {string} conversationId — Graph conversationId
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {number} [opts.maxPerDay] Override pour test
 * @returns {Promise<{ok:boolean, count:number, max:number, reason?:string}>}
 */
async function canReplyToThreadToday(conversationId, opts = {}) {
  const max = Number.isFinite(opts.maxPerDay) ? opts.maxPerDay : DEFAULT_MAX_PER_DAY;
  if (!conversationId) {
    // Pas de conversationId → on ne peut pas tracer, on autorise (cas
    // legacy ou messages hors conversation Graph)
    return { ok: true, count: 0, max, reason: 'no_conversation_id' };
  }

  const client = getClient();
  if (!client) return { ok: true, count: 0, max, reason: 'no_storage' };

  const rk = dateKey(opts.now);
  try {
    const entity = await client.getEntity(conversationId, rk);
    const count = Number(entity.count) || 0;
    if (count >= max) {
      return { ok: false, count, max, reason: 'thread_daily_cap_reached' };
    }
    return { ok: true, count, max };
  } catch {
    // 404 → pas d'entry → 0 réponses aujourd'hui → OK
    return { ok: true, count: 0, max };
  }
}

/**
 * Incrémente le compteur de réponses dans ce fil pour aujourd'hui.
 * Best effort : Storage indispo = swallow (l'envoi est déjà parti).
 *
 * @param {string} conversationId
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @returns {Promise<{count:number} | null>}
 */
async function incrementThreadReply(conversationId, opts = {}) {
  if (!conversationId) return null;
  const client = getClient();
  if (!client) return null;
  const rk = dateKey(opts.now);
  const nowIso = (opts.now instanceof Date ? opts.now : new Date()).toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const entity = await client.getEntity(conversationId, rk);
      const newCount = (Number(entity.count) || 0) + 1;
      await client.updateEntity({
        partitionKey: conversationId,
        rowKey: rk,
        count: newCount,
        lastSentAt: nowIso,
        updatedAt: nowIso,
      }, 'Merge', { etag: entity.etag });
      return { count: newCount };
    } catch (err) {
      const statusCode = err && (err.statusCode || (err.response && err.response.status));
      if (statusCode === 404) {
        try {
          await client.createEntity({
            partitionKey: conversationId,
            rowKey: rk,
            count: 1,
            lastSentAt: nowIso,
            updatedAt: nowIso,
          });
          return { count: 1 };
        } catch (createErr) {
          if (createErr && (createErr.statusCode === 409 || createErr.statusCode === 412)) {
            continue;
          }
          return null;
        }
      }
      if (statusCode === 412) continue;
      return null;
    }
  }
  return null;
}

module.exports = {
  canReplyToThreadToday,
  incrementThreadReply,
  TABLE_NAME,
  DEFAULT_MAX_PER_DAY,
  _setClientForTests,
  _resetForTests,
  _dateKey: dateKey,
};
