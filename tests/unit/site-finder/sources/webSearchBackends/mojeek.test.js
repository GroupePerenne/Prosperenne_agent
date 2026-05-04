'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  SearchBlockedError,
  SearchTransientError,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/mojeek');

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

test('mojeek — HTML simple → résultats extraits, URL appelée avec fmt=classic', async () => {
  const html = `
    <a href="https://acme.fr/">ACME</a>
    <a href="https://example.com/">Example</a>
  `;
  const { stub, calls } = makeFetchStub({ body: html });
  const out = await search('test query', { fetchImpl: stub });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.match(calls[0].url, /^https:\/\/www\.mojeek\.com\/search\?q=test%20query&fmt=classic$/);
});

test('mojeek — exclut les liens mojeek.com', async () => {
  const html = `
    <a href="https://www.mojeek.com/about">about</a>
    <a href="https://acme.fr/">ACME</a>
  `;
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('mojeek — query vide → [] sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: '' });
  assert.deepEqual(await search('', { fetchImpl: stub }), []);
  assert.equal(calls.length, 0);
});

test('mojeek — HTTP 403 → SearchBlockedError', async () => {
  const { stub } = makeFetchStub({ status: 403, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'forbidden',
  );
});

test('mojeek — body recaptcha → SearchBlockedError', async () => {
  const html = '<div class="g-recaptcha"></div>';
  const { stub } = makeFetchStub({ status: 200, body: html });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'challenge_detected',
  );
});

test('mojeek — réseau throw → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ETIMEDOUT') });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError,
  );
});

test('mojeek — HTML sans liens → []', async () => {
  const { stub } = makeFetchStub({ body: '<html><body>No results.</body></html>' });
  const out = await search('q', { fetchImpl: stub });
  assert.deepEqual(out, []);
});
