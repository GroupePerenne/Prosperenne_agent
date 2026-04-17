/**
 * Azure Queue Storage — file d'attente des touches différées de séquence.
 *
 * Principe : quand Martin/Mila bootstrappent une séquence, ils poussent les
 * touches J+4 / J+10 / J+18 / J+28 dans la file. Chaque message porte un
 * `targetDate` (date d'envoi effective, jour ouvré à 9h Paris) + le contenu
 * pré-généré. Le scheduler (timer trigger toutes les 15 min) consomme la
 * file et traite les messages dus.
 *
 * Limite Azure Queue Storage : visibilityTimeout max 7 jours. Les échéances
 * plus lointaines (J+10, J+18, J+28) sont gérées par re-queue : si un message
 * devient visible alors que son targetDate est encore dans le futur, le
 * scheduler le re-push avec la visibility restante (via rescheduleIfNotDue)
 * au lieu de le traiter.
 *
 * La queue garantit at-least-once. Les contenus sont pré-générés au J0 pour
 * ne jamais refaire un appel LLM à l'échéance (cohérence du discours sur
 * toute la séquence, coût contenu).
 */

const { QueueServiceClient } = require('@azure/storage-queue');

const QUEUE_NAME = () => process.env.QUEUE_NAME_RELANCES || 'mila-relances';
const MAX_VISIBILITY_SECONDS = 7 * 24 * 3600 - 60; // 7 jours - 1 min de buffer

let _client = null;
function client() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) throw new Error('AzureWebJobsStorage non défini');
  _client = QueueServiceClient.fromConnectionString(conn).getQueueClient(QUEUE_NAME());
  return _client;
}

/** S'assure que la queue existe (idempotent) */
async function ensureQueue() {
  await client().createIfNotExists();
}

/**
 * Programme une touche différée de séquence.
 * @param {Object} job
 * @param {string}        job.agent              — "martin" ou "mila"
 * @param {string}        job.day                — "J+4" | "J+10" | "J+18" | "J+28"
 * @param {string}        job.targetDate         — ISO datetime UTC (heure d'envoi cible)
 * @param {Object}        job.lead               — profil lead
 * @param {Object}        job.consultant         — { id, nom, email, offre, ton, tutoiement }
 * @param {number}        [job.dealId]           — id Pipedrive
 * @param {number}        [job.personId]         — id Pipedrive
 * @param {Object}        job.preGeneratedStep   — { jour, objet, corps }
 */
async function scheduleRelance(job) {
  if (!job.targetDate) throw new Error('scheduleRelance: job.targetDate requis');
  await ensureQueue();
  const targetTime = new Date(job.targetDate).getTime();
  const secondsUntil = Math.max(1, Math.floor((targetTime - Date.now()) / 1000));
  const visibilitySeconds = Math.min(secondsUntil, MAX_VISIBILITY_SECONDS);
  const ttlSeconds = Math.max(secondsUntil + 86_400 * 7, 86_400 * 60); // TTL généreux
  const payload = Buffer.from(JSON.stringify(job)).toString('base64');
  return client().sendMessage(payload, {
    visibilityTimeout: visibilitySeconds,
    messageTimeToLive: ttlSeconds,
  });
}

/** Récupère les messages visibles (consommation par le scheduler) */
async function receiveDueRelances(maxMessages = 16) {
  await ensureQueue();
  const { receivedMessageItems } = await client().receiveMessages({
    numberOfMessages: Math.min(maxMessages, 32),
    visibilityTimeout: 120, // 2 min pour traiter avant qu'un autre worker ne reprenne
  });
  return receivedMessageItems.map((m) => ({
    messageId: m.messageId,
    popReceipt: m.popReceipt,
    body: JSON.parse(Buffer.from(m.messageText, 'base64').toString('utf8')),
  }));
}

/**
 * Si le job n'est pas encore dû (targetDate > now), le re-push avec la
 * visibility restante et supprime l'ancien message. Retourne `true` si
 * re-scheduled (donc à ignorer pour ce tick), `false` si dû (à traiter).
 */
async function rescheduleIfNotDue(job, { messageId, popReceipt }) {
  const targetTime = new Date(job.targetDate).getTime();
  if (targetTime <= Date.now()) return false;
  await scheduleRelance(job);
  await deleteRelance({ messageId, popReceipt });
  return true;
}

/**
 * Purge les messages de la queue qui matchent un dealId donné.
 * Utilisé par stopSequence() quand un prospect répond : on ne lui envoie
 * plus les touches restantes. Best-effort (on itère jusqu'à 10 passes).
 */
async function purgeByDealId(dealId) {
  if (!dealId) return { purged: 0 };
  await ensureQueue();
  let purged = 0;
  for (let pass = 0; pass < 10; pass++) {
    const { receivedMessageItems } = await client().receiveMessages({
      numberOfMessages: 32,
      visibilityTimeout: 30,
    });
    if (!receivedMessageItems.length) break;
    for (const m of receivedMessageItems) {
      const body = JSON.parse(Buffer.from(m.messageText, 'base64').toString('utf8'));
      if (body.dealId === dealId) {
        await client().deleteMessage(m.messageId, m.popReceipt);
        purged++;
      }
    }
  }
  return { purged };
}

/** Supprime un message une fois traité avec succès */
async function deleteRelance({ messageId, popReceipt }) {
  return client().deleteMessage(messageId, popReceipt);
}

module.exports = {
  scheduleRelance,
  receiveDueRelances,
  deleteRelance,
  rescheduleIfNotDue,
  purgeByDealId,
  ensureQueue,
  MAX_VISIBILITY_SECONDS,
};
