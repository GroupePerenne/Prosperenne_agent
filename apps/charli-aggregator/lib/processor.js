/**
 * lib/processor — logique métier du queue consumer charli-events.
 *
 * Extraite du wrapper Functions v4 (src/functions/davidQueueConsumer.js) pour
 * être testable sans dépendre de @azure/functions. Le wrapper appelle
 * processQueueItem en lui injectant le mcpClient.
 *
 * Discipline d'erreurs (brief Phase B §3.5 + rappel disciplinaire B.4 #2) :
 *   - Erreur PERMANENTE (parse, shape, normalisation impossible) :
 *     log error + return. Le runtime FA consomme le message côté queue.
 *     Sinon throw → requeue infini d'un message qu'on ne saura jamais traiter.
 *   - Erreur TRANSITOIRE (Mem0 down, throttling addMemory) :
 *     throw → le runtime Queue trigger requeue automatiquement.
 *   - Erreur dedup search (transitoire) :
 *     log warn + continue. Mieux vaut un doublon ponctuel (rattrapé par le
 *     `infer:true` Mem0) qu'un message légitime perdu.
 */

'use strict';

const { normalizeEvent } = require('./normalizers');
const { isDuplicateEvent } = require('./deduplication');

function parseQueueItem(queueItem) {
  if (queueItem === null || queueItem === undefined) return null;
  if (typeof queueItem === 'object') return queueItem;
  if (typeof queueItem !== 'string') return null;
  try {
    return JSON.parse(queueItem);
  } catch (_) {
    try {
      const decoded = Buffer.from(queueItem, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } catch (_) {
      return null;
    }
  }
}

function isValidEvent(event) {
  return !!(
    event && typeof event === 'object'
    && typeof event.agent === 'string' && event.agent
    && typeof event.eventType === 'string' && event.eventType
    && typeof event.summary === 'string' && event.summary
    && typeof event.eventId === 'string' && event.eventId
  );
}

function logInfo(ctx, msg) {
  if (ctx && typeof ctx.log === 'function') ctx.log(msg);
  else console.log(msg);
}
function logWarn(ctx, msg) {
  if (ctx && ctx.log && typeof ctx.log.warn === 'function') ctx.log.warn(msg);
  else console.warn(msg);
}
function logError(ctx, msg) {
  if (ctx && ctx.log && typeof ctx.log.error === 'function') ctx.log.error(msg);
  else console.error(msg);
}

/**
 * @param {*} queueItem        — raw item du runtime FA (peut être objet, string JSON, base64)
 * @param {Object} context     — Azure Functions context
 * @param {Object} deps
 * @param {Object} deps.mcpClient — instance mem0McpClient (addMemory, searchMemory)
 */
async function processQueueItem(queueItem, context, { mcpClient }) {
  const event = parseQueueItem(queueItem);
  if (!isValidEvent(event)) {
    let preview;
    try { preview = JSON.stringify(queueItem); } catch (_) { preview = String(queueItem); }
    logError(context, `[davidQueueConsumer] event invalide (parse ou shape), skip : ${(preview || '').slice(0, 200)}`);
    return { skipped: 'invalid' };
  }

  let dup;
  try {
    dup = await isDuplicateEvent(mcpClient, event.eventId);
  } catch (err) {
    logWarn(context, `[davidQueueConsumer] dedup check failed eventId=${event.eventId}: ${err.message}, proceed`);
    dup = false;
  }
  if (dup) {
    logInfo(context, `[davidQueueConsumer] duplicate skipped eventId=${event.eventId}`);
    return { skipped: 'duplicate', eventId: event.eventId };
  }

  let normalized;
  try {
    normalized = normalizeEvent(event);
  } catch (err) {
    logError(context, `[davidQueueConsumer] normalisation échec eventId=${event.eventId} agent=${event.agent}: ${err.message}, skip`);
    return { skipped: 'no-normalizer', eventId: event.eventId };
  }

  try {
    await mcpClient.addMemory(normalized.content, normalized.metadata);
    logInfo(context, `[davidQueueConsumer] memory created eventId=${event.eventId} agent=${event.agent} type=${event.eventType}`);
    return { ok: true, eventId: event.eventId };
  } catch (err) {
    logError(context, `[davidQueueConsumer] add_memory échec eventId=${event.eventId}: ${err.message}`);
    throw err;
  }
}

const _internals = {
  parseQueueItem,
  isValidEvent,
};

module.exports = {
  processQueueItem,
  _internals,
};
