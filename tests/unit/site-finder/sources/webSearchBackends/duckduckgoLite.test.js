'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  SearchBlockedError,
  SearchTransientError,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/duckduckgoLite');

function makeFetchStub({ status = 200, body = '', throwError = null } = {}) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url, options });
    if (throwError) throw throwError;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  };
  return { stub, calls };
}

test('ddg_lite — HTML avec liens simples → résultats extraits', async () => {
  const html = `
    <a href="https://acme.fr/">ACME</a>
    <a href="https://example.com/">Example</a>
  `;
  const { stub, calls } = makeFetchStub({ body: html });
  const out = await search('test query', { fetchImpl: stub });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.match(calls[0].url, /^https:\/\/lite\.duckduckgo\.com\/lite\/\?q=test%20query$/);
});

test('ddg_lite — exclut les liens duckduckgo.com', async () => {
  const html = `
    <a href="https://duckduckgo.com/about">about</a>
    <a href="https://duck.com/help">help</a>
    <a href="https://acme.fr/">ACME</a>
  `;
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('ddg_lite — query vide → [] sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: '' });
  assert.deepEqual(await search('', { fetchImpl: stub }), []);
  assert.deepEqual(await search('   ', { fetchImpl: stub }), []);
  assert.equal(calls.length, 0);
});

test('ddg_lite — HTTP 429 → SearchBlockedError', async () => {
  const { stub } = makeFetchStub({ status: 429, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'rate_limited',
  );
});

test('ddg_lite — body Cloudflare challenge → SearchBlockedError', async () => {
  const html = '<title>Just a moment...</title>';
  const { stub } = makeFetchStub({ status: 200, body: html });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'challenge_detected',
  );
});

test('ddg_lite — réseau throw → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ECONNRESET') });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError && err.code === 'transient',
  );
});

test('ddg_lite — HTTP 503 → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ status: 503, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError,
  );
});
