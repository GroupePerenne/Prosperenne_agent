/**
 * lib/mem0McpClient — client HTTP JSON-RPC vers le Container App MCP
 * mem0-mcp-charli (fork pinkpixel-dev/mem0-mcp v0.6.4-pereneo.0).
 *
 * Spec MCP 2025-03-26 (Streamable HTTP transport). Flow :
 *   1. POST /mcp method=initialize SANS header mcp-session-id
 *      → réponse expose le sessionId via le header `mcp-session-id`
 *   2. POST /mcp method=notifications/initialized AVEC header mcp-session-id
 *   3. POST /mcp method=tools/call AVEC header mcp-session-id
 *
 * Le serveur peut répondre en SSE (`event: message\ndata: {json}\n\n`) ou en
 * JSON brut selon le Content-Type. On parse les deux. Multi-events SSE
 * supportés (split sur double newline).
 *
 * Tools disponibles (lus depuis le fork src/index.ts L267+) :
 *   - add_memory    required: content        optional: metadata, userId, ...
 *   - search_memory required: query          optional: topK, filters, ...
 *   - delete_memory required: memoryId       optional: userId, ...
 *
 * Cloisonnement user_id=charli : appliqué côté serveur (DEFAULT_USER_ID
 * env var Container App). Le client ne passe pas userId par défaut, sauf
 * override explicite — cohérent avec invariant 1 strict.
 *
 * R-CRED : aucun log du Bearer token (pattern length only).
 */

'use strict';

const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'pereneo-charli-aggregator', version: '0.1.0' };

let _fetchImpl = null;
let _idCounter = 0;

function fetchImpl() {
  return _fetchImpl || globalThis.fetch;
}

function nextId() {
  _idCounter = (_idCounter + 1) % 0x7fffffff;
  return _idCounter;
}

/**
 * Parse un body SSE potentiellement multi-events. Retourne un tableau d'objets
 * JSON correspondant aux lignes `data: ...`. Ignore les events sans data ou
 * dont le data n'est pas du JSON valide.
 */
function parseSseBody(body) {
  if (!body || typeof body !== 'string') return [];
  const out = [];
  for (const block of body.split('\n\n')) {
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    try {
      out.push(JSON.parse(raw));
    } catch (_) { /* ignore */ }
  }
  return out;
}

async function readResponse(res) {
  const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    return parseSseBody(text);
  }
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch (_) {
    return [];
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.url           — URL Container App MCP, ex https://.../mcp
 * @param {Object} opts.tokenProvider — { getAccessToken: () => Promise<string> }
 */
function createMcpClient({ url, tokenProvider } = {}) {
  if (!url) throw new Error('createMcpClient: url requis');
  if (!tokenProvider || typeof tokenProvider.getAccessToken !== 'function') {
    throw new Error('createMcpClient: tokenProvider.getAccessToken requis');
  }

  let sessionId = null;
  let initialized = false;

  async function postRpc({ method, params, expectResponse = true }) {
    const token = await tokenProvider.getAccessToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const body = expectResponse
      ? { jsonrpc: '2.0', id: nextId(), method, params }
      : { jsonrpc: '2.0', method, params };

    let res;
    try {
      res = await fetchImpl()(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`MCP request failed (${method}): ${err.message || err}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status} on ${method}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }

    // Capture sessionId si retourné (initialize)
    const returnedSid = res.headers && res.headers.get && res.headers.get('mcp-session-id');
    if (returnedSid && !sessionId) sessionId = returnedSid;

    if (!expectResponse) return null;

    const messages = await readResponse(res);
    if (messages.length === 0) {
      throw new Error(`MCP empty response on ${method}`);
    }
    const msg = messages[messages.length - 1];
    if (msg.error) {
      throw new Error(`MCP error on ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    }
    return msg.result;
  }

  async function initialize() {
    const result = await postRpc({
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    });
    if (sessionId) {
      // Notification initialized (pas de réponse attendue)
      await postRpc({ method: 'notifications/initialized', params: {}, expectResponse: false });
    }
    initialized = true;
    return { sessionId, server: result };
  }

  async function ensureInitialized() {
    if (!initialized) await initialize();
  }

  /**
   * @param {string} content   — texte sémantique à mémoriser (Option B)
   * @param {Object} [metadata] — metadata structurée Mem0
   * @param {Object} [opts]    — { userId, sessionId, agentId } pour overrides exceptionnels
   */
  async function addMemory(content, metadata, opts = {}) {
    await ensureInitialized();
    const args = { content };
    if (metadata && Object.keys(metadata).length > 0) args.metadata = metadata;
    if (opts.userId) args.userId = opts.userId;
    if (opts.sessionId) args.sessionId = opts.sessionId;
    if (opts.agentId) args.agentId = opts.agentId;
    return postRpc({ method: 'tools/call', params: { name: 'add_memory', arguments: args } });
  }

  /**
   * @param {string} query
   * @param {Object} [opts] — { topK, filters, threshold, userId, ... }
   */
  async function searchMemory(query, opts = {}) {
    await ensureInitialized();
    const args = { query, ...opts };
    return postRpc({ method: 'tools/call', params: { name: 'search_memory', arguments: args } });
  }

  return {
    initialize,
    addMemory,
    searchMemory,
    get sessionId() { return sessionId; },
  };
}

const _internals = {
  parseSseBody,
  PROTOCOL_VERSION,
  setFetchForTests: (f) => { _fetchImpl = f; },
  resetForTests: () => { _fetchImpl = null; _idCounter = 0; },
};

module.exports = {
  createMcpClient,
  _internals,
};
