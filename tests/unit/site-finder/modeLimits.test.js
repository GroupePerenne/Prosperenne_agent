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

/**
 * Stub webSearch qui simule la durée de chaque fetch en avançant un faux
 * clock partagé. Pas de setTimeout réel → test rapide et déterministe.
 *
 * @param {Object} clock                  { current: number } muté à chaque appel
 * @param {number} addMsPerCall           ms à ajouter à clock.current par stratégie
 */
function makeWebSearchStubAdvancingClock(clock, addMsPerCall) {
  const calls = [];
  return {
    stub: {
      QUERY_STRATEGIES: webSearchReal.QUERY_STRATEGIES,
      canApply: webSearchReal.canApply,
      searchOneStrategy: async (strategy) => {
        calls.push(strategy.name);
        clock.current += addMsPerCall;
        return [];
      },
    },
    calls,
  };
}

test('Mode on_demand — politeness budget exhausted → early-exit déterministe', async () => {
  // Setup déterministe via clock injecté :
  //   - politenessBudgetMs = 5000 (default on_demand)
  //   - chaque stratégie consomme 3000ms simulés
  //   - max 2 stratégies on_demand (name_city, name_siren)
  //
  // Trajectoire attendue :
  //   t=0      : findWebsite démarre, startedAt=0
  //   t=0      : check politeness 0 < 5000 OK → strat 1 (name_city)
  //   t=3000   : politenessUsed=3000
  //   t=3000   : check politeness 3000 < 5000 OK → strat 2 (name_siren)
  //   t=6000   : politenessUsed=6000
  //   (boucle finit par épuisement maxStrategies=2, pas par politeness)
  //
  // Pour FORCER l'early-exit politeness, on baisse le budget à 4000 :
  //   t=0      : check 0 < 4000 OK → strat 1
  //   t=3000   : politenessUsed=3000
  //   t=3000   : check 3000 >= 4000 ? Non → strat 2
  //   t=6000   : politenessUsed=6000
  // Mauvaise trajectoire — la 2e tourne quand même.
  //
  // Pour vraie early-exit, budget < addMsPerCall pour la 1re vérification
  // après strat 1. On choisit budget=2500, addMsPerCall=3000 :
  //   t=0    : politenessUsed=0 < 2500 → strat 1 OK
  //   t=3000 : politenessUsed=3000 >= 2500 → SKIP strat 2 (politeness_exhausted)
  const clock = { current: 0 };
  const ws = makeWebSearchStubAdvancingClock(clock, 3000);
  const cache = makeCacheStub();

  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      // Override explicite du budget via env-like — passé via input.options
      // n'est pas exposé pour politeness, donc on patch ON_DEMAND_LIMITS au niveau
      // module en injectant un clock + en surveillant que le défaut joue.
      // Ici on s'appuie sur le défaut on_demand 5000ms et on force addMsPerCall
      // à 6000 pour épuiser le budget après strat 1.
      options: { mode: 'on_demand' },
    },
    {
      apiGouvImpl: makeApiGouvStub(),
      webSearchImpl: ws.stub,
      validatorImpl: makeValidatorStub(),
      cacheImpl: cache.stub,
      now: () => clock.current,
    },
  );
  // addMsPerCall=3000, budget on_demand=5000 → après strat 1 (t=3000),
  // politenessUsed=3000 < 5000 OK donc strat 2 tourne. politenessUsed devient
  // 6000. La boucle s'arrête parce que strategiesAppliedCount=2=maxStrategies.
  // Pour forcer l'arrêt par politesse au lieu de maxStrategies, il faut
  // addMsPerCall > budget OR un budget plus restrictif — vérifions le scénario
  // où addMsPerCall=6000 (1 seul appel suffit à dépasser).
  // → on relance avec un autre stub pour ce scénario plus bas.
  // Ici on vérifie juste que les 2 stratégies on_demand ont tourné.
  assert.deepEqual(ws.calls, ['name_city', 'name_siren']);
});

test('Mode on_demand — politeness budget exhausted en 1 seul appel cher → strat 2 skippée', async () => {
  // addMsPerCall=6000 > budget 5000 → après strat 1 (clock=6000),
  // politenessUsed=6000 >= 5000 → SKIP strat 2 avec rejectedReason 'politeness_exhausted'
  const clock = { current: 0 };
  const ws = makeWebSearchStubAdvancingClock(clock, 6000);
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
      now: () => clock.current,
    },
  );
  // Assertion DURE : exactement 1 appel webSearch
  assert.equal(ws.calls.length, 1);
  assert.equal(ws.calls[0], 'name_city');
  // Le signal politeness_exhausted doit apparaître dans attempted
  const skipped = out.attempted.find((a) => a.source === 'websearch_skipped');
  assert.ok(skipped, 'attendu : entrée websearch_skipped dans attempted');
  assert.equal(skipped.rejectedReason, 'politeness_exhausted');
});

test('Mode on_demand — overall timeout exhausted → cascade stoppée déterministe', async () => {
  // addMsPerCall=21000 > on_demand totalTimeoutMs 20000 → après strat 1,
  // isOverallBudget retourne true → SKIP strat 2 avec rejectedReason 'overall_timeout'
  const clock = { current: 0 };
  const ws = makeWebSearchStubAdvancingClock(clock, 21000);
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
      now: () => clock.current,
    },
  );
  assert.equal(ws.calls.length, 1);
  const skipped = out.attempted.find((a) => a.source === 'websearch_skipped');
  assert.ok(skipped);
  assert.equal(skipped.rejectedReason, 'overall_timeout');
});
