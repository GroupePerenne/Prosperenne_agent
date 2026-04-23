/**
 * Tests unitaires — shared/lead-exhauster/resolveDomain.js
 *
 * Mocks fetch via option opts.fetchImpl. Aucun appel réseau.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDomain, fetchFromApiGouv } = require('../../../shared/lead-exhauster/resolveDomain');

function mockFetchOk(payload) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  });
}

function mockFetchHttpError(status) {
  return async () => ({ ok: false, status });
}

function mockFetchThrows(err) {
  return async () => { throw err; };
}

// ─── Validation d'entrée ────────────────────────────────────────────────────

test('resolveDomain — SIREN manquant ou invalide → signal invalid_siren', async () => {
  const r1 = await resolveDomain({});
  assert.equal(r1.domain, null);
  assert.equal(r1.source, 'none');
  assert.ok(r1.signals.includes('invalid_siren'));

  const r2 = await resolveDomain({ siren: 'abc' });
  assert.ok(r2.signals.includes('invalid_siren'));

  const r3 = await resolveDomain({ siren: '12345' });
  assert.ok(r3.signals.includes('invalid_siren'));
});

// ─── Domaine fourni par le caller ──────────────────────────────────────────

test('resolveDomain — companyDomain fourni → short-circuit confidence 1.0', async () => {
  const r = await resolveDomain({ siren: '123456789', companyDomain: 'https://www.Acme.fr/contact' });
  assert.equal(r.domain, 'acme.fr');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.source, 'input');
  assert.ok(r.signals.includes('domain_from_input'));
});

test('resolveDomain — companyDomain malformé → fallback sur étape suivante', async () => {
  const r = await resolveDomain(
    { siren: '123456789', companyDomain: 'not a domain' },
    { fetchImpl: mockFetchOk({ results: [] }) },
  );
  assert.equal(r.source, 'none');
  assert.ok(r.signals.includes('input_domain_malformed'));
});

// ─── API gouv ──────────────────────────────────────────────────────────────

test('resolveDomain — API gouv site_web via siege → confidence 0.90', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    {
      fetchImpl: mockFetchOk({
        results: [{ siren: '123456789', siege: { site_web: 'https://acme.fr/' } }],
      }),
    },
  );
  assert.equal(r.domain, 'acme.fr');
  assert.equal(r.confidence, 0.90);
  assert.equal(r.source, 'api_gouv');
});

test('resolveDomain — API gouv site_web via matching_etablissements', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    {
      fetchImpl: mockFetchOk({
        results: [{
          siren: '123456789',
          siege: {},
          matching_etablissements: [{ site_web: 'www.Acme.fr' }],
        }],
      }),
    },
  );
  assert.equal(r.domain, 'acme.fr');
  assert.equal(r.source, 'api_gouv');
});

test('resolveDomain — API gouv choisit le résultat dont le SIREN matche exact', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    {
      fetchImpl: mockFetchOk({
        results: [
          { siren: '999999999', siege: { site_web: 'https://wrong.fr' } },
          { siren: '123456789', siege: { site_web: 'https://right.fr' } },
        ],
      }),
    },
  );
  assert.equal(r.domain, 'right.fr');
});

test('resolveDomain — API gouv sans site_web → signal no_site_web, unresolvable', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    {
      fetchImpl: mockFetchOk({
        results: [{ siren: '123456789', siege: {} }],
      }),
    },
  );
  assert.equal(r.domain, null);
  assert.equal(r.source, 'none');
  assert.ok(r.signals.some((s) => s.includes('no_site_web') || s.includes('api_gouv_no_site_web')));
});

test('resolveDomain — API gouv zéro résultats', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    { fetchImpl: mockFetchOk({ results: [] }) },
  );
  assert.equal(r.domain, null);
  assert.equal(r.source, 'none');
});

// ─── Graceful degradation ──────────────────────────────────────────────────

test('resolveDomain — HTTP 503 → graceful null', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    { fetchImpl: mockFetchHttpError(503) },
  );
  assert.equal(r.domain, null);
  assert.equal(r.source, 'none');
  assert.ok(r.signals.some((s) => s.includes('api_gouv_error')));
});

test('resolveDomain — network error → graceful null', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    { fetchImpl: mockFetchThrows(new Error('ECONNRESET')) },
  );
  assert.equal(r.domain, null);
  assert.equal(r.source, 'none');
});

test('resolveDomain — JSON invalide → graceful null', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error('JSON parse'); },
      }),
    },
  );
  assert.equal(r.domain, null);
});

test('resolveDomain — fetch impl absent → graceful', async () => {
  const r = await resolveDomain(
    { siren: '123456789' },
    { fetchImpl: null }, // explicitement null pour forcer le chemin fallback
  );
  // Dans ce test, fetchImpl=null fera que fetchFromApiGouv retourne fetch_missing
  // si fetch global n'existe pas. Node 20+ a fetch global donc il va être utilisé.
  // Le test vérifie seulement qu'on ne throw pas.
  assert.ok(r);
  assert.equal(typeof r.domain, 'object'); // null ou string
});

// ─── fetchFromApiGouv ──────────────────────────────────────────────────────

test('fetchFromApiGouv — construit l URL correctement', async () => {
  let capturedUrl = null;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  await fetchFromApiGouv('123456789', { fetchImpl });
  assert.ok(capturedUrl.includes('/search?q=123456789'));
  assert.ok(capturedUrl.includes('per_page=5'));
});

test('fetchFromApiGouv — extrait site_web en priorité siege puis etablissements', async () => {
  const result = await fetchFromApiGouv('123456789', {
    fetchImpl: mockFetchOk({
      results: [{
        siren: '123456789',
        siege: { site_web: 'priority.fr' },
        matching_etablissements: [{ site_web: 'fallback.fr' }],
        site_web: 'root.fr',
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'priority.fr');
});
