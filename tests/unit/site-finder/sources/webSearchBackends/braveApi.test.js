'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  SearchBlockedError,
  SearchTransientError,
  _internals,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/braveApi');

function makeFetchStub({ status = 200, body = null, throwError = null } = {}) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url, options });
    if (throwError) throw throwError;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { stub, calls };
}

function makeQuotaStub({ count = 0 } = {}) {
  let cur = count;
  const calls = { get: 0, increment: 0 };
  return {
    stub: {
      getCurrentCount: async () => { calls.get++; return cur; },
      increment: async () => { calls.increment++; cur++; return true; },
    },
    calls,
  };
}

const SAMPLE_BODY = {
  web: {
    results: [
      { url: 'https://acme.fr/', title: 'ACME SAS', description: 'plomberie' },
      { url: 'https://example.com/', title: 'Example' },
    ],
  },
};

// ─── Cas nominaux ──────────────────────────────────────────────────────────

test('brave — réponse JSON 200 → résultats parsés + quota incrémenté', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub({ count: 0 });
  const out = await search('"ACME" Lyon', {
    fetchImpl: stub,
    apiKey: 'test-key',
    quotaImpl: quota.stub,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].title, 'ACME SAS');
  assert.equal(out[0].rank, 1);
  // Vérifie l'URL appelée + headers
  assert.match(calls[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=/);
  assert.match(calls[0].url, /country=FR/);
  assert.match(calls[0].url, /search_lang=fr/);
  assert.equal(calls[0].options.headers['X-Subscription-Token'], 'test-key');
  // Quota lu + incrémenté
  assert.equal(quota.calls.get, 1);
  // increment async fire-and-forget : on laisse le micro-task tick passer
  await new Promise((r) => setImmediate(r));
  assert.equal(quota.calls.increment, 1);
});

test('brave — query vide → [] sans appel ni quota check', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub({ count: 0 });
  const out = await search('', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
  assert.equal(quota.calls.get, 0);
});

test('brave — body sans web.results → []', async () => {
  const { stub } = makeFetchStub({ body: {} });
  const quota = makeQuotaStub();
  const out = await search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub });
  assert.deepEqual(out, []);
});

test('brave — déduplique URLs identiques', async () => {
  const body = {
    web: {
      results: [
        { url: 'https://acme.fr/', title: 'A' },
        { url: 'https://www.acme.fr/', title: 'A bis' },
        { url: 'https://other.fr/', title: 'O' },
      ],
    },
  };
  const { stub } = makeFetchStub({ body });
  const quota = makeQuotaStub();
  const out = await search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[1].url, 'https://other.fr');
});

// ─── Kill-switch quota ────────────────────────────────────────────────────

test('brave — quota >= limit → SearchBlockedError(quota_exhausted_local) sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub({ count: 950 }); // exactement à la limite
  await assert.rejects(
    () => search('q', {
      fetchImpl: stub,
      apiKey: 'k',
      quotaImpl: quota.stub,
      quotaLimit: 950,
    }),
    (err) => err instanceof SearchBlockedError && err.reason === 'quota_exhausted_local',
  );
  // Pas d'appel HTTP fait
  assert.equal(calls.length, 0);
  // Quota lu mais pas incrémenté (kill-switch préventif)
  assert.equal(quota.calls.get, 1);
  assert.equal(quota.calls.increment, 0);
});

test('brave — quota = limit-1 → appel passe', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub({ count: 949 });
  const out = await search('q', {
    fetchImpl: stub,
    apiKey: 'k',
    quotaImpl: quota.stub,
    quotaLimit: 950,
  });
  assert.equal(out.length, 2);
  assert.equal(calls.length, 1);
});

test('brave — quotaLimit override pour tests', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub({ count: 5 });
  await assert.rejects(
    () => search('q', {
      fetchImpl: stub,
      apiKey: 'k',
      quotaImpl: quota.stub,
      quotaLimit: 5,
    }),
    (err) => err instanceof SearchBlockedError,
  );
  assert.equal(calls.length, 0);
});

// ─── Erreurs HTTP ────────────────────────────────────────────────────────

test('brave — 401 → SearchTransientError (config issue, pas blocked)', async () => {
  const { stub } = makeFetchStub({ status: 401, body: {} });
  const quota = makeQuotaStub();
  await assert.rejects(
    () => search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub }),
    (err) => err instanceof SearchTransientError && err.status === 401,
  );
});

test('brave — 429 → SearchBlockedError(rate_limited)', async () => {
  const { stub } = makeFetchStub({ status: 429, body: {} });
  const quota = makeQuotaStub();
  await assert.rejects(
    () => search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'rate_limited',
  );
});

test('brave — 422 invalid query → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ status: 422, body: {} });
  const quota = makeQuotaStub();
  await assert.rejects(
    () => search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub }),
    (err) => err instanceof SearchTransientError && err.status === 422,
  );
});

test('brave — 503 → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ status: 503, body: {} });
  const quota = makeQuotaStub();
  await assert.rejects(
    () => search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub }),
    (err) => err instanceof SearchTransientError,
  );
});

test('brave — réseau throw → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ECONNRESET') });
  const quota = makeQuotaStub();
  await assert.rejects(
    () => search('q', { fetchImpl: stub, apiKey: 'k', quotaImpl: quota.stub }),
    (err) => err instanceof SearchTransientError,
  );
});

test('brave — apiKey absente → SearchTransientError sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: SAMPLE_BODY });
  const quota = makeQuotaStub();
  // On force apiKey vide ET on s'assure que l'env n'en a pas
  const original = process.env.SITE_FINDER_BRAVE_API_KEY;
  delete process.env.SITE_FINDER_BRAVE_API_KEY;
  try {
    await assert.rejects(
      () => search('q', { fetchImpl: stub, quotaImpl: quota.stub }),
      (err) => err instanceof SearchTransientError && /api key missing/i.test(err.message),
    );
    assert.equal(calls.length, 0);
  } finally {
    if (original !== undefined) process.env.SITE_FINDER_BRAVE_API_KEY = original;
  }
});

// ─── parseResults internals ──────────────────────────────────────────────

test('parseResults — body null/non-object → []', () => {
  assert.deepEqual(_internals.parseResults(null), []);
  assert.deepEqual(_internals.parseResults('string'), []);
  assert.deepEqual(_internals.parseResults({}), []);
});

test('parseResults — borne maxResults', () => {
  const body = {
    web: {
      results: Array.from({ length: 20 }, (_, i) => ({
        url: `https://site${i}.fr/`,
        title: `Site ${i}`,
      })),
    },
  };
  const out = _internals.parseResults(body, 5);
  assert.equal(out.length, 5);
});
