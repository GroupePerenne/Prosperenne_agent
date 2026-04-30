/**
 * Tests — apps/charli-aggregator/lib/tokenProvider
 *
 * Vérifie :
 *   - premier appel : POST OAuth client_credentials, retourne access_token, cache
 *   - deuxième appel non expiré : retourne cache (pas de POST réseau)
 *   - expiry - 300s buffer : refresh
 *   - 401 Entra : throw explicite
 *   - réseau down : throw avec message explicite
 *   - body POST conforme (grant_type, client_id, client_secret, scope)
 *   - URL endpoint Entra v2 : tenantId injecté
 *   - lecture client_secret depuis process.env.ENTRA_CLIENT_SECRET au moment de l'appel
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTokenProvider,
  _internals,
} = require('../../../lib/tokenProvider');

const TENANT = '70f9e20f-964f-4925-8dc2-b72d62384629';
const CLIENT_ID = '3c6aa87f-eed9-4b86-b22c-dff73344806e';
const SCOPE = 'api://pereneo-charli-mcp/.default';

function makeFetchStub({ responses = [], capture = [] } = {}) {
  let i = 0;
  return async (url, init) => {
    capture.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
}

function jsonResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function setupEnv(secret = 'test-client-secret-xyz') {
  const prev = {
    secret: process.env.ENTRA_CLIENT_SECRET,
  };
  process.env.ENTRA_CLIENT_SECRET = secret;
  return () => {
    if (prev.secret !== undefined) process.env.ENTRA_CLIENT_SECRET = prev.secret;
    else delete process.env.ENTRA_CLIENT_SECRET;
  };
}

// ─── Premier appel : POST OAuth ─────────────────────────────────────────────

test('premier appel — POST sur l\'endpoint Entra v2 avec body client_credentials', async () => {
  const restore = setupEnv();
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [jsonResponse({ body: { access_token: 'token-A', expires_in: 3600 } })],
  });
  _internals.setFetchForTests(stub);
  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    const tok = await provider.getAccessToken();
    assert.equal(tok, 'token-A');

    assert.equal(capture.length, 1);
    assert.equal(capture[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    assert.equal(capture[0].init.method, 'POST');
    assert.match(capture[0].init.headers['Content-Type'] || capture[0].init.headers['content-type'], /application\/x-www-form-urlencoded/);
    const body = capture[0].init.body;
    assert.match(body, /grant_type=client_credentials/);
    assert.match(body, new RegExp(`client_id=${CLIENT_ID}`));
    assert.match(body, /client_secret=test-client-secret-xyz/);
    assert.match(body, /scope=api%3A%2F%2Fpereneo-charli-mcp%2F\.default/);
  } finally {
    _internals.resetForTests();
    restore();
  }
});

// ─── Cache hit ──────────────────────────────────────────────────────────────

test('deuxième appel non expiré — retourne le cache, pas de POST', async () => {
  const restore = setupEnv();
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [jsonResponse({ body: { access_token: 'token-cached', expires_in: 3600 } })],
  });
  _internals.setFetchForTests(stub);
  _internals.setClockForTests(() => 1_000_000_000_000); // ms fixe
  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    const t1 = await provider.getAccessToken();
    const t2 = await provider.getAccessToken();
    assert.equal(t1, 'token-cached');
    assert.equal(t2, 'token-cached');
    assert.equal(capture.length, 1, 'un seul POST OAuth pour deux calls');
  } finally {
    _internals.resetForTests();
    restore();
  }
});

// ─── Refresh sur expiry buffer 300s ─────────────────────────────────────────

test('expiry - 300s : refresh déclenché', async () => {
  const restore = setupEnv();
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      jsonResponse({ body: { access_token: 'token-1', expires_in: 600 } }), // expire dans 600s
      jsonResponse({ body: { access_token: 'token-2', expires_in: 600 } }),
    ],
  });
  _internals.setFetchForTests(stub);

  let now = 1_000_000_000_000;
  _internals.setClockForTests(() => now);

  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    const t1 = await provider.getAccessToken();
    assert.equal(t1, 'token-1');

    // Avance jusqu'à expiry - 200s : on est dans la zone de buffer 300s, refresh attendu
    now += (600 - 200) * 1000;
    const t2 = await provider.getAccessToken();
    assert.equal(t2, 'token-2');
    assert.equal(capture.length, 2, 'refresh effectué');
  } finally {
    _internals.resetForTests();
    restore();
  }
});

test('avant expiry - 300s : pas de refresh', async () => {
  const restore = setupEnv();
  const capture = [];
  const stub = makeFetchStub({
    capture,
    responses: [
      jsonResponse({ body: { access_token: 'token-1', expires_in: 3600 } }),
    ],
  });
  _internals.setFetchForTests(stub);

  let now = 1_000_000_000_000;
  _internals.setClockForTests(() => now);

  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    await provider.getAccessToken();

    // Avance de 1000s : on est encore loin de expiry-300s (3600-300=3300s)
    now += 1000 * 1000;
    const t2 = await provider.getAccessToken();
    assert.equal(t2, 'token-1');
    assert.equal(capture.length, 1, 'pas de refresh');
  } finally {
    _internals.resetForTests();
    restore();
  }
});

// ─── Erreurs ────────────────────────────────────────────────────────────────

test('401 Entra — throw avec message explicite contenant le code', async () => {
  const restore = setupEnv();
  const stub = makeFetchStub({
    responses: [jsonResponse({ status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215' } })],
  });
  _internals.setFetchForTests(stub);
  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    await assert.rejects(
      () => provider.getAccessToken(),
      /401|invalid_client|AADSTS7000215/i,
    );
  } finally {
    _internals.resetForTests();
    restore();
  }
});

test('réseau down — throw avec message explicite', async () => {
  const restore = setupEnv();
  const stub = makeFetchStub({ responses: [new Error('ENOTFOUND login.microsoftonline.com')] });
  _internals.setFetchForTests(stub);
  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    await assert.rejects(
      () => provider.getAccessToken(),
      /ENOTFOUND|login\.microsoftonline/,
    );
  } finally {
    _internals.resetForTests();
    restore();
  }
});

test('client_secret absent — throw au moment de getAccessToken (lecture lazy de l\'env var)', async () => {
  const prev = process.env.ENTRA_CLIENT_SECRET;
  delete process.env.ENTRA_CLIENT_SECRET;
  try {
    const provider = createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID, scope: SCOPE });
    await assert.rejects(
      () => provider.getAccessToken(),
      /ENTRA_CLIENT_SECRET/,
    );
  } finally {
    if (prev !== undefined) process.env.ENTRA_CLIENT_SECRET = prev;
  }
});

test('createTokenProvider — paramètres requis : throw si tenantId/clientId/scope manquants', () => {
  assert.throws(() => createTokenProvider({}), /tenantId|clientId|scope/);
  assert.throws(() => createTokenProvider({ tenantId: TENANT }), /clientId|scope/);
  assert.throws(() => createTokenProvider({ tenantId: TENANT, clientId: CLIENT_ID }), /scope/);
});
