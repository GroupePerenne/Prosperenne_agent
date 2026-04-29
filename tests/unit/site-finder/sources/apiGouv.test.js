'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findCandidatesViaApiGouv,
  ApiGouvError,
} = require('../../../../shared/site-finder/sources/apiGouv');

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

test('findCandidatesViaApiGouv — 200 avec siege.site_internet → 1 candidat', async () => {
  const body = {
    results: [
      {
        siren: '123456789',
        siege: { site_internet: 'http://www.acme.fr' },
      },
    ],
  };
  const { stub, calls } = makeFetchStub({ body });
  const out = await findCandidatesViaApiGouv(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].source, 'api_gouv');
  assert.equal(out[0].initialConfidence, 0.85);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /search\?q=123456789/);
});

test('findCandidatesViaApiGouv — 200 sans site_internet → 0 candidat', async () => {
  const body = { results: [{ siren: '123456789', siege: {} }] };
  const { stub } = makeFetchStub({ body });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.deepEqual(out, []);
});

test('findCandidatesViaApiGouv — 200 avec results vide → 0 candidat', async () => {
  const { stub } = makeFetchStub({ body: { results: [] } });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.deepEqual(out, []);
});

test('findCandidatesViaApiGouv — 200 avec SIREN ≠ → ignoré, 0 candidat', async () => {
  const body = {
    results: [
      { siren: '999999999', siege: { site_internet: 'http://other.fr' } },
    ],
  };
  const { stub } = makeFetchStub({ body });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.deepEqual(out, []);
});

test('findCandidatesViaApiGouv — 404 → 0 candidat (pas une erreur)', async () => {
  const { stub } = makeFetchStub({ status: 404, body: { detail: 'not found' } });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.deepEqual(out, []);
});

test('findCandidatesViaApiGouv — 429 → throw ApiGouvError(transient)', async () => {
  const { stub } = makeFetchStub({ status: 429, body: { detail: 'rate-limited' } });
  await assert.rejects(
    () => findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub }),
    (err) => err instanceof ApiGouvError && err.code === 'transient',
  );
});

test('findCandidatesViaApiGouv — 503 → throw transient', async () => {
  const { stub } = makeFetchStub({ status: 503 });
  await assert.rejects(
    () => findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub }),
    (err) => err instanceof ApiGouvError && err.code === 'transient',
  );
});

test('findCandidatesViaApiGouv — réseau throw → ApiGouvError(transient)', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ECONNRESET') });
  await assert.rejects(
    () => findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub }),
    (err) => err instanceof ApiGouvError && err.code === 'transient',
  );
});

test('findCandidatesViaApiGouv — siren invalide → 0 candidat sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: { results: [] } });
  const out = await findCandidatesViaApiGouv({ siren: '12345' }, { fetchImpl: stub });
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test('findCandidatesViaApiGouv — déduplique URLs candidates identiques', async () => {
  const body = {
    results: [
      {
        siren: '123456789',
        siege: { site_internet: 'http://acme.fr', site_web: 'https://www.acme.fr/' },
        site_internet: 'acme.fr',
      },
    ],
  };
  const { stub } = makeFetchStub({ body });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('findCandidatesViaApiGouv — extrait depuis matching_etablissements', async () => {
  const body = {
    results: [
      {
        siren: '123456789',
        siege: {},
        matching_etablissements: [{ site_internet: 'matching.fr' }],
      },
    ],
  };
  const { stub } = makeFetchStub({ body });
  const out = await findCandidatesViaApiGouv({ siren: '123456789' }, { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://matching.fr');
});
