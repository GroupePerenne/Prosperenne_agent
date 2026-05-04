'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  SearchBlockedError,
  SearchTransientError,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/ecosia');

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

test('ecosia — HTML simple → résultats extraits', async () => {
  const html = `
    <a href="https://acme.fr/">ACME</a>
    <a href="https://example.com/">Example</a>
  `;
  const { stub, calls } = makeFetchStub({ body: html });
  const out = await search('test query', { fetchImpl: stub });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.match(calls[0].url, /^https:\/\/www\.ecosia\.org\/search\?q=test%20query$/);
});

test('ecosia — exclut les liens ecosia.org et sous-domaines', async () => {
  const html = `
    <a href="https://www.ecosia.org/about">about</a>
    <a href="https://blog.ecosia.org/article">blog</a>
    <a href="https://ecosia.com/help">help-com</a>
    <a href="https://acme.fr/">ACME</a>
  `;
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('ecosia — query vide → [] sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: '' });
  assert.deepEqual(await search('', { fetchImpl: stub }), []);
  assert.equal(calls.length, 0);
});

test('ecosia — HTTP 429 → SearchBlockedError', async () => {
  const { stub } = makeFetchStub({ status: 429, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'rate_limited',
  );
});

test('ecosia — body Cloudflare → SearchBlockedError', async () => {
  const html = '<title>Just a moment...</title>';
  const { stub } = makeFetchStub({ status: 200, body: html });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError,
  );
});

test('ecosia — HTTP 504 → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ status: 504, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError,
  );
});

test('ecosia — réseau throw → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ENETUNREACH') });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError,
  );
});
