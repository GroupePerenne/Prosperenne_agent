/**
 * Tests — apps/charli-aggregator/lib/mem0McpClient
 *
 * Vérifie :
 *   - initialize : POST /mcp sans mcp-session-id, lit le sessionId depuis le header
 *   - addMemory : POST /mcp avec mcp-session-id et tools/call name=add_memory
 *   - searchMemory : POST /mcp avec mcp-session-id et tools/call name=search_memory
 *   - parse SSE event:message + data:{json} (single + multi-events)
 *   - parse JSON brut si pas de SSE (Content-Type application/json)
 *   - 401 token expiré bubble up
 *   - body JSON-RPC 2.0 conforme (jsonrpc, id, method, params)
 *   - tool result remonté depuis result.content[0].text (format MCP standard)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMcpClient,
  _internals,
} = require('../../../lib/mem0McpClient');

const MCP_URL = 'https://mem0-mcp-charli.livelysky-db1bb02c.francecentral.azurecontainerapps.io/mcp';

function makeFetchStub({ responses = [], capture = [] } = {}) {
  let i = 0;
  return async (url, init) => {
    capture.push({ url, init });
    const r = typeof responses[i] === 'function' ? responses[i]({ url, init }) : responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
}

function sseResponse({ status = 200, payload, sessionId, contentType = 'text/event-stream' } = {}) {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  const headers = new Map([['content-type', contentType]]);
  if (sessionId) headers.set('mcp-session-id', sessionId);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) },
    text: async () => body,
    json: async () => payload,
  };
}

function jsonResponse({ status = 200, payload, sessionId } = {}) {
  const headers = new Map([['content-type', 'application/json']]);
  if (sessionId) headers.set('mcp-session-id', sessionId);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

const fakeTokenProvider = { getAccessToken: async () => 'fake-bearer-xyz' };

// ─── parseSseBody (helper interne) ──────────────────────────────────────────

test('parseSseBody — single event message', () => {
  const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n`;
  const out = _internals.parseSseBody(body);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { jsonrpc: '2.0', id: 1, result: { x: 1 } });
});

test('parseSseBody — multi events séparés par \\n\\n', () => {
  const body = [
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"first":1}}',
    'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"second":2}}',
  ].join('\n\n') + '\n\n';
  const out = _internals.parseSseBody(body);
  assert.equal(out.length, 2);
  assert.equal(out[0].result.first, 1);
  assert.equal(out[1].result.second, 2);
});

test('parseSseBody — body vide retourne []', () => {
  assert.deepEqual(_internals.parseSseBody(''), []);
  assert.deepEqual(_internals.parseSseBody('\n\n\n'), []);
});

// ─── initialize ─────────────────────────────────────────────────────────────

test('initialize — POST /mcp sans mcp-session-id, lit le sessionId du header de réponse', async () => {
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      sseResponse({
        sessionId: 'sid-abc-123',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mem0-mcp', version: '0.6.4-pereneo.0' } },
        },
      }),
      // initialized notification réponse (peut être 202 vide)
      jsonResponse({ status: 202, payload: {} }),
    ],
  });
  _internals.setFetchForTests(stub);

  try {
    const client = createMcpClient({ url: MCP_URL, tokenProvider: fakeTokenProvider });
    const out = await client.initialize();

    assert.equal(out.sessionId, 'sid-abc-123');
    // 1er call = initialize (sans session id)
    assert.equal(capture[0].url, MCP_URL);
    assert.equal(capture[0].init.method, 'POST');
    assert.equal(capture[0].init.headers.Authorization || capture[0].init.headers.authorization, 'Bearer fake-bearer-xyz');
    assert.equal(capture[0].init.headers['mcp-session-id'], undefined, 'pas de mcp-session-id sur initialize');
    const body1 = JSON.parse(capture[0].init.body);
    assert.equal(body1.method, 'initialize');
    assert.equal(body1.jsonrpc, '2.0');
    assert.ok(body1.params.protocolVersion);
    assert.ok(body1.params.clientInfo);

    // 2e call = notifications/initialized (avec session id)
    if (capture.length >= 2) {
      const body2 = JSON.parse(capture[1].init.body);
      assert.equal(body2.method, 'notifications/initialized');
      assert.equal(capture[1].init.headers['mcp-session-id'], 'sid-abc-123');
    }
  } finally {
    _internals.resetForTests();
  }
});

// ─── addMemory ──────────────────────────────────────────────────────────────

test('addMemory — POST tools/call name=add_memory avec content + metadata + sessionId', async () => {
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      // initialize
      sseResponse({ sessionId: 'sid-A', payload: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {} } } }),
      // initialized
      jsonResponse({ status: 202, payload: {} }),
      // addMemory result
      sseResponse({
        payload: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ status: 'PENDING', event_id: 'evt-12345' }) }],
            isError: false,
          },
        },
      }),
    ],
  });
  _internals.setFetchForTests(stub);

  try {
    const client = createMcpClient({ url: MCP_URL, tokenProvider: fakeTokenProvider });
    await client.initialize();
    const out = await client.addMemory('Le dirigeant SIREN 12345 a été qualifié.', { dealId: 42 });

    // Vérif body 3e call (addMemory)
    const addMemoryCall = capture[2];
    const body = JSON.parse(addMemoryCall.init.body);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'add_memory');
    assert.equal(body.params.arguments.content, 'Le dirigeant SIREN 12345 a été qualifié.');
    assert.deepEqual(body.params.arguments.metadata, { dealId: 42 });
    assert.equal(addMemoryCall.init.headers['mcp-session-id'], 'sid-A');

    // Result remonté
    assert.equal(out.isError, false);
    assert.ok(Array.isArray(out.content));
    assert.equal(out.content[0].type, 'text');
  } finally {
    _internals.resetForTests();
  }
});

// ─── searchMemory ───────────────────────────────────────────────────────────

test('searchMemory — POST tools/call name=search_memory avec query + topK', async () => {
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      sseResponse({ sessionId: 'sid-B', payload: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {} } } }),
      jsonResponse({ status: 202, payload: {} }),
      sseResponse({
        payload: {
          jsonrpc: '2.0',
          id: 2,
          result: {
            content: [{ type: 'text', text: JSON.stringify([]) }],
            isError: false,
          },
        },
      }),
    ],
  });
  _internals.setFetchForTests(stub);

  try {
    const client = createMcpClient({ url: MCP_URL, tokenProvider: fakeTokenProvider });
    await client.initialize();
    await client.searchMemory('event_id:test-123', { topK: 1 });

    const searchCall = capture[2];
    const body = JSON.parse(searchCall.init.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'search_memory');
    assert.equal(body.params.arguments.query, 'event_id:test-123');
    assert.equal(body.params.arguments.topK, 1);
  } finally {
    _internals.resetForTests();
  }
});

// ─── 401 bubble ─────────────────────────────────────────────────────────────

test('addMemory — 401 token expiré : throw avec message explicite', async () => {
  const stub = makeFetchStub({
    responses: [
      sseResponse({ sessionId: 'sid', payload: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {} } } }),
      jsonResponse({ status: 202, payload: {} }),
      // 401 sur addMemory
      { ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => 'Unauthorized', json: async () => ({}) },
    ],
  });
  _internals.setFetchForTests(stub);
  try {
    const client = createMcpClient({ url: MCP_URL, tokenProvider: fakeTokenProvider });
    await client.initialize();
    await assert.rejects(() => client.addMemory('test', {}), /401|Unauthorized/);
  } finally {
    _internals.resetForTests();
  }
});

// ─── auto-initialize ────────────────────────────────────────────────────────

test('addMemory appelé sans initialize : initialize automatique', async () => {
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      sseResponse({ sessionId: 'sid-Z', payload: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: {} } } }),
      jsonResponse({ status: 202, payload: {} }),
      sseResponse({ payload: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }], isError: false } } }),
    ],
  });
  _internals.setFetchForTests(stub);

  try {
    const client = createMcpClient({ url: MCP_URL, tokenProvider: fakeTokenProvider });
    // Pas d'appel à initialize() explicite
    await client.addMemory('content auto-init', {});
    // initialize a tourné automatiquement avant addMemory
    const initBody = JSON.parse(capture[0].init.body);
    assert.equal(initBody.method, 'initialize');
  } finally {
    _internals.resetForTests();
  }
});

// ─── createMcpClient — params requis ────────────────────────────────────────

test('createMcpClient — url + tokenProvider requis', () => {
  assert.throws(() => createMcpClient({}), /url|tokenProvider/);
  assert.throws(() => createMcpClient({ url: MCP_URL }), /tokenProvider/);
  assert.throws(() => createMcpClient({ tokenProvider: fakeTokenProvider }), /url/);
});
