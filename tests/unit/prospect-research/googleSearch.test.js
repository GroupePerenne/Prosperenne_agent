/**
 * Tests — shared/prospect-research/sources/googleSearch.js (stub V0)
 *
 * Vérifie la shape stable de la réponse pour que les consommateurs
 * (companyProfile.js) puissent s'y reposer avant même qu'un vrai provider
 * soit branché.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchRecentSignals,
  _buildQuery,
  STUB_NOTE,
} = require('../../../shared/prospect-research/sources/googleSearch');

test('searchRecentSignals — shape stable stub V0', async () => {
  const res = await searchRecentSignals('ACME SAS');
  assert.equal(typeof res.query, 'string');
  assert.ok(res.query.includes('ACME SAS'));
  assert.equal(Array.isArray(res.results), true);
  assert.equal(res.results.length, 0);
  assert.equal(typeof res.elapsedMs, 'number');
  assert.equal(res.provider, 'stub');
  assert.equal(res.note, STUB_NOTE);
});

test('searchRecentSignals — companyName vide → query vide, pas de throw', async () => {
  const res = await searchRecentSignals('');
  assert.equal(res.query, '');
  assert.equal(res.results.length, 0);
});

test('searchRecentSignals — provider override respecté dans la réponse (toujours stub side-effect)', async () => {
  const res = await searchRecentSignals('ACME', { provider: 'bing' });
  // V0 : provider reflète l'intention mais results reste []
  assert.equal(res.provider, 'bing');
  assert.equal(res.results.length, 0);
});

test('searchRecentSignals — env PROFILER_SERP_PROVIDER pris en compte', async () => {
  const prev = process.env.PROFILER_SERP_PROVIDER;
  process.env.PROFILER_SERP_PROVIDER = 'serpapi';
  try {
    const res = await searchRecentSignals('ACME');
    assert.equal(res.provider, 'serpapi');
    assert.equal(res.results.length, 0);
  } finally {
    if (prev !== undefined) process.env.PROFILER_SERP_PROVIDER = prev;
    else delete process.env.PROFILER_SERP_PROVIDER;
  }
});

test('_buildQuery — hints par défaut', () => {
  const q = _buildQuery('ACME SAS');
  assert.ok(q.startsWith('"ACME SAS"'));
  assert.ok(q.includes('levée'));
  assert.ok(q.includes('recrutement'));
});

test('_buildQuery — hints custom', () => {
  const q = _buildQuery('ACME', ['partenariat', 'produit']);
  assert.ok(q.includes('partenariat OR produit'));
});
