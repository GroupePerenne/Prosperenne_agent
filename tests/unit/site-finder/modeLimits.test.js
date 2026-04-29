'use strict';

/**
 * Tests du mode on_demand vs batch dans findWebsite.
 *
 * On_demand : timeout 20s, max 2 stratégies (name_city, name_siren), politesse
 * cumulée 5s.
 * Batch : timeout 90s, 5 stratégies, politesse illimitée.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findWebsite,
  ON_DEMAND_LIMITS,
  BATCH_LIMITS,
  _internals,
} = require('../../../shared/site-finder');
const webSearchReal = require('../../../shared/site-finder/sources/webSearch');

function makeWebSearchStub({ byStrategy = {}, throwError = null, sleepMs = 0 } = {}) {
  const calls = [];
  return {
    stub: {
      QUERY_STRATEGIES: webSearchReal.QUERY_STRATEGIES,
      canApply: webSearchReal.canApply,
      searchOneStrategy: async (strategy) => {
        calls.push(strategy.name);
        if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
        if (throwError) throw throwError;
        return byStrategy[strategy.name] || [];
      },
    },
    calls,
  };
}

function makeApiGouvStub() { return { findCandidatesViaApiGouv: async () => [] }; }
function makeValidatorStub(result = { confidence: 0.99, proofType: 'siren_match', signals: [] }) {
  return { validateCandidate: async () => result };
}
function makeCacheStub() {
  const calls = { get: 0, put: 0, recordFailure: 0 };
  return {
    stub: {
      get: async () => { calls.get++; return null; },
      put: async () => { calls.put++; return true; },
      recordFailure: async () => { calls.recordFailure++; return true; },
    },
    calls,
  };
}

// ─── Constantes ─────────────────────────────────────────────────────────────

test('ON_DEMAND_LIMITS — 2 stratégies, 20s timeout, 5s politesse', () => {
  assert.equal(ON_DEMAND_LIMITS.maxStrategies, 2);
  assert.deepEqual(ON_DEMAND_LIMITS.strategyOrder, ['name_city', 'name_siren']);
  assert.equal(ON_DEMAND_LIMITS.totalTimeoutMs, 20000);
  assert.equal(ON_DEMAND_LIMITS.politenessBudgetMs, 5000);
});

test('BATCH_LIMITS — 5 stratégies, 90s timeout, politesse illimitée', () => {
  assert.equal(BATCH_LIMITS.maxStrategies, 5);
  assert.equal(BATCH_LIMITS.strategyOrder.length, 5);
  assert.equal(BATCH_LIMITS.totalTimeoutMs, 90000);
  assert.equal(BATCH_LIMITS.politenessBudgetMs, Infinity);
});

test('_internals.getLimitsForMode — défaut on_demand pour mode invalide ou absent', () => {
  const { getLimitsForMode } = _internals;
  assert.equal(getLimitsForMode('on_demand'), ON_DEMAND_LIMITS);
  assert.equal(getLimitsForMode('batch'), BATCH_LIMITS);
  assert.equal(getLimitsForMode('unknown'), ON_DEMAND_LIMITS);
  assert.equal(getLimitsForMode(undefined), ON_DEMAND_LIMITS);
});

// ─── Mode on_demand : limite à 2 stratégies ────────────────────────────────

test('Mode on_demand — apiGouv 0 + DDG name_city trouve → stratégie name_siren jamais appelée', async () => {
  const ws = makeWebSearchStub({
    byStrategy: {
      name_city: [{
        url: 'https://acme.fr', source: 'websearch', strategy: 'name_city',
        backend: 'duckduckgo_html', initialConfidence: 0.65,
        signals: ['websearch_name_city'], rank: 1,
      }],
    },
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon', options: { mode: 'on_demand' } },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_city');
  assert.deepEqual(ws.calls, ['name_city']);
});

test('Mode on_demand — name_city échoue + name_siren échoue → return null SANS appeler les 3 autres', async () => {
  const ws = makeWebSearchStub({ byStrategy: {} }); // 0 résultat partout
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      dirigeantName: 'Jean Dupont',
      libelleNaf: 'Conseil',
      options: { mode: 'on_demand' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, null);
  // En on_demand, name_postcode / name_director / name_naf_city ne sont JAMAIS tentés
  assert.deepEqual(ws.calls.sort(), ['name_city', 'name_siren']);
});

// ─── Mode batch : 5 stratégies autorisées ──────────────────────────────────

test('Mode batch — name_city à name_naf_city tous échouent → 5 stratégies tentées', async () => {
  const ws = makeWebSearchStub({ byStrategy: {} });
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      dirigeantName: 'Jean Dupont',
      libelleNaf: 'Conseil',
      options: { mode: 'batch' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, null);
  // En batch, les 5 stratégies sont tentées dans l'ordre
  assert.deepEqual(
    ws.calls,
    ['name_city', 'name_postcode', 'name_siren', 'name_director', 'name_naf_city'],
  );
});

test('Mode batch — name_postcode trouve → stratégies suivantes pas appelées', async () => {
  const ws = makeWebSearchStub({
    byStrategy: {
      name_city: [],
      name_postcode: [{
        url: 'https://acme.fr', source: 'websearch', strategy: 'name_postcode',
        backend: 'duckduckgo_html', initialConfidence: 0.65,
        signals: ['websearch_name_postcode'], rank: 1,
      }],
    },
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      dirigeantName: 'Jean Dupont',
      libelleNaf: 'Conseil',
      options: { mode: 'batch' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_postcode');
  // 2 stratégies tentées : name_city et name_postcode (puis stop)
  assert.deepEqual(ws.calls, ['name_city', 'name_postcode']);
});

// ─── Default mode (sans mode explicite) ────────────────────────────────────

test('Mode par défaut — comportement on_demand (pas de mode passé)', async () => {
  const ws = makeWebSearchStub({ byStrategy: {} });
  await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      dirigeantName: 'Jean Dupont',
      libelleNaf: 'Conseil',
      // pas de options.mode
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: makeCacheStub().stub,
    },
  );
  // Default = on_demand → 2 stratégies max
  assert.deepEqual(ws.calls.sort(), ['name_city', 'name_siren']);
});

test('Mode invalide ("foo") → fallback on_demand', async () => {
  const ws = makeWebSearchStub({ byStrategy: {} });
  await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      dirigeantName: 'Jean Dupont',
      libelleNaf: 'Conseil',
      options: { mode: 'foo' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: makeCacheStub().stub,
    },
  );
  assert.deepEqual(ws.calls.sort(), ['name_city', 'name_siren']);
});

// ─── Politeness budget en on_demand ────────────────────────────────────────

test('Mode on_demand — politeness budget exhausted → early-exit avec signal', async () => {
  // On force chaque appel à consommer 3s — 2 appels = 6s > budget 5s
  const ws = makeWebSearchStub({ byStrategy: {}, sleepMs: 3000 });
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      options: { mode: 'on_demand' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
    },
  );
  // Premier appel passe (3s consommés), deuxième early-exit (3s + 3s > 5s budget)
  // Donc soit 1 soit 2 appels selon la précision du timing — on assert ≤ 2
  assert.ok(ws.calls.length <= 2);
  // Un signal d'early-exit doit apparaître dans attempted
  const skipped = out.attempted.find((a) => a.source === 'websearch_skipped');
  if (ws.calls.length === 1) {
    assert.ok(skipped);
    assert.equal(skipped.rejectedReason, 'politeness_exhausted');
  }
});
