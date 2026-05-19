'use strict';

/**
 * Détecteur de "burst" anti-boucle David — plan v3.1 Pilier 3 niveau 3.
 *
 * Contexte : niveau 1 (`threadAutoReply`, commit 39d5493) détecte les
 * auto-replies pré-Claude. Niveau 2 (`threadReplyCap`, commit 877d3b8)
 * impose 1 réponse/fil/jour. Ce niveau 3 est un FILET DE SÉCURITÉ pour
 * le cas où niveau 2 serait foiré (cap désactivé via env var override,
 * bug runtime, écriture compteur perdue) : si N messages SORTANTS David
 * dans une même conversation Graph en moins de W minutes, on bloque
 * l'envoi suivant + log structuré (capté par routine CC pipeline-monitor).
 *
 * Pas d'alerte mail dédiée V0 : le log warn explicite est consommé par
 * la routine CC `pipeline-monitor` (Task #8). Évite la dépendance circulaire
 * "anti-boucle qui envoie un mail qui peut lui-même partir en boucle".
 *
 * Schéma table Storage `DavidThreadBurstLog` :
 *   PartitionKey : conversationId (Graph)
 *   RowKey       : `${reverseTimestamp}_${randomShort}` — antichronologique
 *                  naturel pour query "derniers N messages"
 *   Colonnes     : sentAtIso (ISO), subject (audit léger 64 chars max)
 *
 * Coût : 1 read + 1 write Storage par envoi du flusher. Acceptable
 * (le flusher tourne toutes les 15 min, volumétrie 50 max/tick).
 *
 * Graceful degradation : Storage indispo → autorise (préserve continuité).
 * Discipline cohérente avec threadReplyCap : un anti-boucle ne doit
 * JAMAIS bloquer par défaut sur panne Storage.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.DAVID_THREAD_BURST_TABLE || 'DavidThreadBurstLog';
const DEFAULT_WINDOW_MINUTES = Number(process.env.DAVID_THREAD_BURST_WINDOW_MINUTES || 60);
const DEFAULT_THRESHOLD = Number(process.env.DAVID_THREAD_BURST_THRESHOLD || 3);
const REVERSE_BASE = 9999999999999; // 13 chiffres : timestamps ms encore positifs jusqu'en 2286

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

function reverseTimestamp(date) {
  const ms = date.getTime();
  return String(REVERSE_BASE - ms).padStart(13, '0');
}

function randomShort() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Détecte si la conversation est en burst : >= threshold envois sortants
 * David dans la dernière window minutes.
 *
 * @param {string} conversationId — Graph conversationId
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {number} [opts.windowMinutes] Override pour test
 * @param {number} [opts.threshold] Override pour test
 * @returns {Promise<{burst:boolean, count:number, threshold:number, windowMinutes:number, reason?:string}>}
 */
async function detectBurst(conversationId, opts = {}) {
  const windowMinutes = Number.isFinite(opts.windowMinutes) ? opts.windowMinutes : DEFAULT_WINDOW_MINUTES;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const now = opts.now instanceof Date ? opts.now : new Date();

  if (!conversationId) {
    return { burst: false, count: 0, threshold, windowMinutes, reason: 'no_conversation_id' };
  }
  const client = getClient();
  if (!client) {
    return { burst: false, count: 0, threshold, windowMinutes, reason: 'no_storage' };
  }

  const cutoff = new Date(now.getTime() - windowMinutes * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  try {
    // Antichronologique : rowKeys décroissent quand le temps avance.
    // On itère les entries de la PK, on filtre par sentAtIso >= cutoff.
    // Pas de filter OData composite ici pour rester simple ; on stoppe dès
    // qu'on dépasse le seuil (court-circuit). Volumétrie attendue par PK ≤ 5
    // donc itération O(window) acceptable.
    let count = 0;
    const iter = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${conversationId.replace(/'/g, "''")}'` },
    });
    for await (const entity of iter) {
      if (!entity.sentAtIso) continue;
      if (String(entity.sentAtIso) >= cutoffIso) {
        count++;
        if (count >= threshold) {
          return { burst: true, count, threshold, windowMinutes };
        }
      }
    }
    return { burst: false, count, threshold, windowMinutes };
  } catch (err) {
    return {
      burst: false,
      count: 0,
      threshold,
      windowMinutes,
      reason: `storage_error:${err && err.message ? err.message : 'unknown'}`,
    };
  }
}

/**
 * Trace un envoi sortant David dans le fil. Fire-and-forget pour le caller :
 * la trace ne doit jamais bloquer l'envoi.
 *
 * @param {string} conversationId
 * @param {Object} [opts]
 * @param {Date} [opts.sentAt]
 * @param {string} [opts.subject]
 * @returns {Promise<{recorded:boolean, reason?:string}>}
 */
async function recordOutboundSend(conversationId, opts = {}) {
  if (!conversationId) return { recorded: false, reason: 'no_conversation_id' };
  const client = getClient();
  if (!client) return { recorded: false, reason: 'no_storage' };
  const sentAt = opts.sentAt instanceof Date ? opts.sentAt : new Date();
  const subject = opts.subject ? String(opts.subject).slice(0, 64) : '';
  const rk = `${reverseTimestamp(sentAt)}_${randomShort()}`;
  try {
    await client.createEntity({
      partitionKey: conversationId,
      rowKey: rk,
      sentAtIso: sentAt.toISOString(),
      subject,
    });
    return { recorded: true };
  } catch (err) {
    return { recorded: false, reason: `storage_error:${err && err.message ? err.message : 'unknown'}` };
  }
}

module.exports = {
  detectBurst,
  recordOutboundSend,
  // Constantes exposées (lecture seule conseillée) :
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_THRESHOLD,
  TABLE_NAME,
  // Tests :
  _setClientForTests,
  _resetForTests,
};
