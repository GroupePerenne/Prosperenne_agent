/**
 * lib/deduplication — vérifie idempotence event_id côté Mem0.
 *
 * Pattern Option B : metadata.event_id est l'identifiant unique d'un évènement
 * agent. Stratégie : search_memory query=eventId filters={event_id: eventId}
 * topK=1. Le filter par metadata est appliqué côté Mem0 Cloud par le fork
 * mem0-mcp-pereneo (cf. src/index.ts L690 : `if (filters) options.filters = filters`).
 *
 * Erreur search_memory propagée au caller : c'est au processor de décider
 * (continue avec doublon potentiel + log warn, ou stop). Cohérent avec la
 * discipline d'erreurs B.4 où le processor pilote le contrôle de flux.
 * Mem0 Cloud a `infer:true` qui rattrape les doublons sémantiquement
 * identiques en fallback.
 */

'use strict';

function extractItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.results)) return parsed.results;
  if (parsed && Array.isArray(parsed.memories)) return parsed.memories;
  return [];
}

/**
 * @param {Object} mcpClient — instance mem0McpClient (a searchMemory)
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
async function isDuplicateEvent(mcpClient, eventId) {
  if (!eventId) return false;
  const result = await mcpClient.searchMemory(eventId, {
    filters: { event_id: eventId },
    topK: 1,
  });
  if (!result || !result.content || !result.content[0] || typeof result.content[0].text !== 'string') {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch (_) {
    return false;
  }
  const items = extractItems(parsed);
  return items.some((it) => it && it.metadata && it.metadata.event_id === eventId);
}

module.exports = { isDuplicateEvent };
