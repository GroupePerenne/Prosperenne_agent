'use strict';

/**
 * Cap d'envoi par boîte mail par jour (plan v3.1 Pilier 5 — délivrabilité).
 *
 * Contexte : pendant le démarrage pilote (Morgane + Johnny via Martin + Mila),
 * les boîtes M365 sont récentes (warmup en cours). Envoyer 100+ J0/jour
 * depuis une boîte fraîche déclenche les filtres anti-spam des FAI
 * destinataires (Gmail, Outlook, Yahoo) — taux de delivrabilité chute,
 * réputation domaine plombée durablement.
 *
 * Doctrine warmup commerciale : montée progressive
 *   - Semaine 1-2 : ≤ 30 J0/jour/boîte
 *   - Semaine 3-4 : ≤ 50
 *   - Semaine 5+ : ≤ 100
 *
 * Cap configurable via env var `DAILY_EMAIL_CAP_PER_MAILBOX` (défaut 30).
 *
 * Schéma table Storage `DailyEmailCounter` :
 *   PartitionKey : `YYYYMMDD` (date Paris)
 *   RowKey       : mailbox (UPN normalisé lowercase)
 *   Colonnes     : count (number), cap (number), lastSentAt (ISO), updatedAt (ISO)
 *
 * Graceful degradation : si Storage indisponible, retourne `{ ok: true }`
 * (on n'empêche pas l'envoi sur panne Storage — préserve business continuity).
 * À l'inverse, un cap dépassé retourne `{ ok: false, reason: 'daily_cap_reached' }`
 * et l'opérateur (Charli/Paul) doit décider manuellement de bumper le cap.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.DAILY_EMAIL_COUNTER_TABLE || 'DailyEmailCounter';
const DEFAULT_CAP = Number(process.env.DAILY_EMAIL_CAP_PER_MAILBOX || 30);

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

function _setClientForTests(client) {
  _client = client;
}

function _resetForTests() {
  _client = null;
}

function dateKey(date = new Date()) {
  // Date Paris (UTC+1/+2). On utilise UTC ici pour stabilité — la fenêtre
  // d'envoi prod 9h-18h Paris est entièrement contenue dans une seule date
  // UTC, donc UTC est cohérent.
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function normalizeMailbox(mailbox) {
  return String(mailbox || '').toLowerCase().trim();
}

/**
 * Vérifie si la boîte peut encore envoyer aujourd'hui.
 *
 * @param {string} mailbox UPN (ex. 'martin@oseys.fr')
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {number} [opts.cap] Override cap pour test
 * @returns {Promise<{ok:true, count:number, cap:number} | {ok:false, reason:string, count:number, cap:number}>}
 */
async function canSendToday(mailbox, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : DEFAULT_CAP;
  const mbox = normalizeMailbox(mailbox);
  if (!mbox) return { ok: true, count: 0, cap, reason: 'no_mailbox' };

  const client = getClient();
  if (!client) {
    // Graceful degradation : Storage indispo = envoi autorisé (sinon panne
    // Storage bloque tout business sans signal opérationnel propre).
    return { ok: true, count: 0, cap, reason: 'no_storage' };
  }

  const pk = dateKey(opts.now);
  try {
    const entity = await client.getEntity(pk, mbox);
    const count = Number(entity.count) || 0;
    if (count >= cap) {
      return { ok: false, reason: 'daily_cap_reached', count, cap };
    }
    return { ok: true, count, cap };
  } catch (err) {
    // 404 = pas d'entry aujourd'hui pour cette boîte = count = 0 = OK
    return { ok: true, count: 0, cap };
  }
}

/**
 * Incrémente le compteur après envoi succès. Best effort : si Storage
 * indispo, on swallow (l'envoi est déjà parti, pas de rollback possible).
 * Création de l'entity si absent, upsert sinon.
 *
 * @param {string} mailbox
 * @param {Object} [opts]
 * @param {Date} [opts.now]
 * @param {number} [opts.cap]
 * @returns {Promise<{count:number, cap:number} | null>}
 */
async function incrementSentToday(mailbox, opts = {}) {
  const cap = Number.isFinite(opts.cap) ? opts.cap : DEFAULT_CAP;
  const mbox = normalizeMailbox(mailbox);
  if (!mbox) return null;

  const client = getClient();
  if (!client) return null;

  const pk = dateKey(opts.now);
  const nowIso = (opts.now instanceof Date ? opts.now : new Date()).toISOString();

  // Pattern read-modify-write avec retry sur conflict ETag (optimistic
  // concurrency). 3 essais max — au-delà on swallow.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const entity = await client.getEntity(pk, mbox);
      const newCount = (Number(entity.count) || 0) + 1;
      await client.updateEntity({
        partitionKey: pk,
        rowKey: mbox,
        count: newCount,
        cap,
        lastSentAt: nowIso,
        updatedAt: nowIso,
      }, 'Merge', { etag: entity.etag });
      return { count: newCount, cap };
    } catch (err) {
      const statusCode = err && (err.statusCode || (err.response && err.response.status));
      if (statusCode === 404) {
        // Pas d'entity → création
        try {
          await client.createEntity({
            partitionKey: pk,
            rowKey: mbox,
            count: 1,
            cap,
            lastSentAt: nowIso,
            updatedAt: nowIso,
          });
          return { count: 1, cap };
        } catch (createErr) {
          // Race : un autre process a créé entre-temps → boucle pour update
          if (createErr && (createErr.statusCode === 409 || createErr.statusCode === 412)) {
            continue;
          }
          return null;
        }
      }
      if (statusCode === 412) {
        // Conflict ETag → retry
        continue;
      }
      // Autres erreurs : swallow
      return null;
    }
  }
  return null;
}

module.exports = {
  canSendToday,
  incrementSentToday,
  TABLE_NAME,
  DEFAULT_CAP,
  _setClientForTests,
  _resetForTests,
  _dateKey: dateKey,
};
