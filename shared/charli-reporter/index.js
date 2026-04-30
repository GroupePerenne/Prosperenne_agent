/**
 * shared/charli-reporter — module agent-agnostique de reporting vers Charli.
 *
 * Permet à n'importe quel agent (David, Alicia, Richard, futurs) de poser un
 * événement sur la queue Azure Storage `charli-events` (SA pereneocharliaggregst)
 * sans connaître Mem0 ni le MCP Container App. La FA pereneo-charli-aggregator
 * consomme la queue et écrit les mémoires dans user_id=charli via le MCP.
 *
 * Pattern fire-and-forget : si la queue est indisponible (config manquante,
 * réseau, throttling), reportToCharli ne lève jamais. Il loggue en warn et
 * retourne { ok: false, error: <msg> }. Cohérent avec l'arbitrage Q4 paquet
 * de passage Niveau 2 (latence asynchrone tolérée, pas de blocage caller).
 *
 * Configuration caller :
 *   - CHARLI_QUEUE_CONNECTION_STRING : connection string SA pereneocharliaggregst
 *     (KV reference côté FA caller)
 *   - CHARLI_QUEUE_NAME : optionnel, défaut "charli-events" (override pour tests)
 *
 * Format de message (Option B) : payload JSON encodé base64.
 *   { agent, eventType, summary, eventId, timestamp, metadata }
 *   - summary : texte sémantique pur (sera le content de la mémoire Mem0)
 *   - eventId : UUID v4 auto-généré si absent (utilisé pour idempotence côté aggregator)
 *   - timestamp : ISO 8601 auto-généré si absent
 *   - metadata : objet plat sérialisable (clé Mem0 metadata structurée)
 */

const crypto = require('node:crypto');
const { QueueServiceClient } = require('@azure/storage-queue');

const DEFAULT_QUEUE_NAME = 'charli-events';

let _client = null;

function getClient() {
  if (_client) return _client;
  const conn = process.env.CHARLI_QUEUE_CONNECTION_STRING;
  if (!conn) throw new Error('CHARLI_QUEUE_CONNECTION_STRING non défini');
  const queueName = process.env.CHARLI_QUEUE_NAME || DEFAULT_QUEUE_NAME;
  _client = QueueServiceClient.fromConnectionString(conn).getQueueClient(queueName);
  return _client;
}

function buildPayload(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('event must be an object');
  }
  if (typeof event.agent !== 'string' || !event.agent) {
    throw new Error('event.agent (string) required');
  }
  if (typeof event.eventType !== 'string' || !event.eventType) {
    throw new Error('event.eventType (string) required');
  }
  if (typeof event.summary !== 'string' || !event.summary) {
    throw new Error('event.summary (string) required');
  }
  return {
    agent: event.agent,
    eventType: event.eventType,
    summary: event.summary,
    eventId: event.eventId || crypto.randomUUID(),
    timestamp: event.timestamp || new Date().toISOString(),
    metadata: event.metadata || {},
  };
}

/**
 * Pose un événement sur la queue charli-events. Fire-and-forget : ne lève jamais.
 *
 * @param {Object} event             — voir doc en tête (agent/eventType/summary requis)
 * @param {Object} [ctx]             — contexte caller optionnel (FA Azure context)
 * @param {Object} [ctx.log]         — logger (ctx.log.warn utilisé en cas d'erreur)
 * @returns {Promise<{ok: boolean, eventId?: string, error?: string}>}
 */
async function reportToCharli(event, ctx) {
  const warn = (ctx && ctx.log && typeof ctx.log.warn === 'function')
    ? ctx.log.warn.bind(ctx.log)
    : console.warn.bind(console);
  try {
    const payload = buildPayload(event);
    const message = Buffer.from(JSON.stringify(payload)).toString('base64');
    await getClient().sendMessage(message);
    return { ok: true, eventId: payload.eventId };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    warn(`[charli-reporter] failed to enqueue event: ${msg}`);
    return { ok: false, error: msg };
  }
}

const _internals = {
  buildPayload,
  setClientForTests: (stub) => { _client = stub; },
  resetClient: () => { _client = null; },
  DEFAULT_QUEUE_NAME,
};

module.exports = {
  reportToCharli,
  _internals,
};
