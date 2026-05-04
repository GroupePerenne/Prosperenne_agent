'use strict';

/**
 * Tests d'intégration site-finder T1 — orchestrateur findWebsite.
 *
 * Tous les adapters externes (apiGouv, validator, cache, fetcher) sont stubés
 * via opts.<thing>Impl. Zéro appel réseau réel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { findWebsite } = require('../../../shared/site-finder');

/**
 * webSearchImpl neutre : QUERY_STRATEGIES vide → la cascade ne s'exécute pas.
 * À utiliser dans tous les tests T1 qui ne testent pas la cascade webSearch,
 * pour éviter que l'orchestrateur tombe sur le vrai backend DDG.
 */
const emptyWebSearch = {
  QUERY_STRATEGIES: [],
  canApply: () => false,
  searchOneStrategy: async () => [],
};

/**
 * heuristicImpl neutre : 0 candidat → l'étape T1bis se termine immédiatement
 * sans probe HTTP. À utiliser dans tous les tests T1 qui ne testent pas la
 * source heuristique (sinon l'orchestrateur tomberait sur fetch réel).
 */
const emptyHeuristic = {
  findCandidatesViaHeuristic: async () => [],
};

function makeApiGouvStub(candidates = []) {
  const calls = [];
  return {
    stub: {
      findCandidatesViaApiGouv: async (input, opts) => {
        calls.push({ input, opts });
        if (typeof candidates === 'function') return candidates(input);
        if (candidates instanceof Error) throw candidates;
        return candidates;
      },
    },
    calls,
  };
}

function makeValidatorStub(resultBuilder) {
  const calls = [];
  return {
    stub: {
      validateCandidate: async (input, opts) => {
        calls.push({ input, opts });
        return typeof resultBuilder === 'function'
          ? resultBuilder(input)
          : resultBuilder;
      },
    },
    calls,
  };
}

function makeCacheStub(initial = {}) {
  const store = new Map();
  if (initial.cached) store.set(initial.cached.siren, initial.cached.entry);
  const calls = { get: [], put: [], recordFailure: [] };
  return {
    stub: {
      get: async (siren) => {
        calls.get.push(siren);
        return store.get(siren) || null;
      },
      put: async (siren, entry) => {
        calls.put.push({ siren, entry });
        store.set(siren, entry);
        return true;
      },
      recordFailure: async (siren, attempt) => {
        calls.recordFailure.push({ siren, attempt });
        return true;
      },
    },
    calls,
    store,
  };
}

// ─── Cas 1 : cache hit récent ──────────────────────────────────────────────

test('findWebsite — cache hit récent court-circuite, pas d\'appel apiGouv', async () => {
  const apiGouv = makeApiGouvStub([]);
  const validator = makeValidatorStub({});
  const cache = makeCacheStub({
    cached: {
      siren: '123456789',
      entry: {
        siteUrl: 'https://acme.fr',
        confidence: 0.99,
        source: 'api_gouv',
        proofType: 'siren_match',
        signals: ['siren_match'],
        costCents: 0,
        validatedAt: '2026-04-01T00:00:00Z',
        attempted: [{ source: 'api_gouv', candidates: 1 }],
        cachedAt: '2026-04-01T00:00:00Z',
      },
    },
  });
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'cache');
  assert.ok(out.signals.includes('cache_hit'));
  assert.equal(apiGouv.calls.length, 0, 'apiGouv ne doit pas être appelé');
  assert.equal(validator.calls.length, 0);
});

// ─── Cas 2 : cache miss + apiGouv 1 candidat valide ────────────────────────

test('findWebsite — cache miss + candidat validé → cache.put + return validated', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://acme.fr', source: 'api_gouv', initialConfidence: 0.85, signals: ['extracted_from_api_gouv'] },
  ]);
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    proofDetails: { matchedSirenOn: 'https://acme.fr/mentions-legales' },
    signals: ['siren_match', 'siren_source_labeled'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.confidence, 0.99);
  assert.equal(out.source, 'api_gouv');
  assert.equal(out.proofType, 'siren_match');
  assert.equal(cache.calls.put.length, 1);
  assert.equal(cache.calls.recordFailure.length, 0);
  assert.equal(out.attempted.length, 1);
  assert.equal(out.attempted[0].source, 'api_gouv');
  assert.equal(out.attempted[0].candidates, 1);
});

// ─── Cas 3 : cache miss + apiGouv 0 candidat ───────────────────────────────

test('findWebsite — cache miss + 0 candidat → recordFailure + null', async () => {
  const apiGouv = makeApiGouvStub([]);
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, null);
  assert.equal(out.confidence, 0);
  assert.equal(cache.calls.put.length, 0);
  assert.equal(cache.calls.recordFailure.length, 1);
  assert.equal(validator.calls.length, 0);
});

// ─── Cas 4 : cache miss + candidat rejeté (siren_mismatch) ─────────────────

test('findWebsite — candidat rejeté par validator → recordFailure + null', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://other.fr', source: 'api_gouv', initialConfidence: 0.85, signals: [] },
  ]);
  const validator = makeValidatorStub({
    confidence: 0.0,
    proofType: 'siren_mismatch',
    proofDetails: { rejectedReason: 'siren_mismatch' },
    signals: ['siren_mismatch'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, null);
  assert.equal(out.proofType, 'siren_mismatch');
  assert.equal(cache.calls.recordFailure.length, 1);
});

// ─── Cas 5 : forceRefresh ignore cache ─────────────────────────────────────

test('findWebsite — forceRefresh=true ignore cache, refait appels', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://acme.fr', source: 'api_gouv', initialConfidence: 0.85, signals: [] },
  ]);
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    signals: ['siren_match'],
  });
  const cache = makeCacheStub({
    cached: {
      siren: '123456789',
      entry: {
        siteUrl: 'https://STALE.fr',
        confidence: 0.99,
        source: 'cache',
        proofType: 'siren_match',
        signals: [],
        costCents: 0,
        validatedAt: '2026-01-01T00:00:00Z',
        attempted: [],
      },
    },
  });
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', options: { forceRefresh: true } },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(apiGouv.calls.length, 1);
  // Cache.get ne doit PAS avoir été appelé
  assert.equal(cache.calls.get.length, 0);
  assert.equal(cache.calls.put.length, 1);
});

// ─── Cas 6 : skipCache désactive read et write ─────────────────────────────

test('findWebsite — skipCache=true ne lit ni n\'écrit le cache', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://acme.fr', source: 'api_gouv', initialConfidence: 0.85, signals: [] },
  ]);
  const validator = makeValidatorStub({ confidence: 0.99, proofType: 'siren_match', signals: [] });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', options: { skipCache: true } },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(cache.calls.get.length, 0);
  assert.equal(cache.calls.put.length, 0);
  assert.equal(cache.calls.recordFailure.length, 0);
});

// ─── Cas 7 : apiGouv throw transient → on remonte signal sans crasher ──────

test('findWebsite — apiGouv throw → attempted.rejectedReason défini, output null', async () => {
  const err = new Error('rate-limited');
  err.code = 'transient';
  const apiGouv = makeApiGouvStub(err);
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, null);
  const apiGouvAttempt = out.attempted.find((a) => a.source === 'api_gouv');
  assert.ok(apiGouvAttempt);
  assert.equal(apiGouvAttempt.rejectedReason, 'transient');
});

// ─── Cas 8 : siren invalide ────────────────────────────────────────────────

test('findWebsite — siren invalide → output null, signal invalid_siren, pas d\'appel', async () => {
  const apiGouv = makeApiGouvStub([]);
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '12345', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, null);
  assert.ok(out.signals.includes('invalid_siren'));
  assert.equal(apiGouv.calls.length, 0);
  assert.equal(cache.calls.get.length, 0);
});

// ─── Cas 9 : threshold abaissé permet validation faible ────────────────────

test('findWebsite — threshold abaissé permet validation par signaux faibles', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://acme.fr', source: 'api_gouv', initialConfidence: 0.85, signals: [] },
  ]);
  const validator = makeValidatorStub({
    confidence: 0.70,
    proofType: 'weak_signals',
    proofDetails: { weakSignals: ['company_name_in_title', 'ville_in_text'] },
    signals: ['company_name_in_title', 'ville_in_text'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', options: { confidenceThreshold: 0.65 } },
    { apiGouvImpl: apiGouv.stub, heuristicImpl: emptyHeuristic, webSearchImpl: emptyWebSearch, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.confidence, 0.70);
  assert.equal(out.proofType, 'weak_signals');
});

// ─── T2 : cascade webSearch ────────────────────────────────────────────────

const webSearchReal = require('../../../shared/site-finder/sources/webSearch');

/**
 * Stub webSearch qui retourne des candidats par stratégie. `byStrategy` mappe
 * `strategy.name` → candidats à retourner. Si throwError est défini, lève.
 * Réutilise les vraies QUERY_STRATEGIES + canApply pour rester fidèle.
 */
function makeWebSearchStub({ byStrategy = {}, throwError = null } = {}) {
  const calls = [];
  return {
    stub: {
      QUERY_STRATEGIES: webSearchReal.QUERY_STRATEGIES,
      canApply: webSearchReal.canApply,
      searchOneStrategy: async (strategy, input, opts) => {
        calls.push({ strategy: strategy.name, input, opts });
        if (throwError) throw throwError;
        return byStrategy[strategy.name] || [];
      },
    },
    calls,
  };
}

// Cas T2.1 : apiGouv 0 + websearch name_city valide → cache.put + return
test('findWebsite — apiGouv 0 + DDG name_city valide → source=websearch_name_city', async () => {
  const apiGouv = makeApiGouvStub([]);
  const webSearchStub = makeWebSearchStub({
    byStrategy: {
      name_city: [
        {
          url: 'https://acme.fr',
          source: 'websearch',
          strategy: 'name_city',
          backend: 'duckduckgo_html',
          initialConfidence: 0.65,
          signals: ['websearch_name_city'],
          rank: 1,
        },
      ],
    },
  });
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    proofDetails: { matchedSirenOn: 'https://acme.fr/mentions-legales' },
    signals: ['siren_match'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_city');
  assert.equal(out.confidence, 0.99);
  assert.equal(cache.calls.put.length, 1);
  // attempted contient api_gouv puis websearch_name_city
  assert.equal(out.attempted[0].source, 'api_gouv');
  const wsAttempt = out.attempted.find((a) => a.source === 'websearch_name_city');
  assert.ok(wsAttempt);
});

// Cas T2.2 : name_city 0 utile + name_siren valide → cascade jusqu'à la 3e stratégie
test('findWebsite — cascade name_city → name_postcode → name_siren validé', async () => {
  const apiGouv = makeApiGouvStub([]);
  const webSearchStub = makeWebSearchStub({
    byStrategy: {
      name_city: [
        {
          url: 'https://noise.fr', source: 'websearch', strategy: 'name_city',
          backend: 'duckduckgo_html', initialConfidence: 0.65,
          signals: ['websearch_name_city'], rank: 1,
        },
      ],
      name_postcode: [], // 0 résultat
      name_siren: [
        {
          url: 'https://acme.fr', source: 'websearch', strategy: 'name_siren',
          backend: 'duckduckgo_html', initialConfidence: 0.65,
          signals: ['websearch_name_siren'], rank: 1,
        },
      ],
    },
  });
  // validator : rejette noise.fr, valide acme.fr
  const validator = makeValidatorStub((vinput) => {
    if (vinput.url === 'https://acme.fr') {
      return { confidence: 0.99, proofType: 'siren_match', signals: ['siren_match'] };
    }
    return { confidence: 0.0, proofType: 'siren_mismatch', signals: ['siren_mismatch'] };
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789',
      companyName: 'ACME',
      ville: 'Lyon',
      codePostal: '69001',
      // T3 : mode batch nécessaire pour autoriser name_postcode (default
      // on_demand limite à name_city + name_siren).
      options: { mode: 'batch' },
    },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_siren');
  // 3 stratégies tentées : name_city, name_postcode, name_siren
  assert.equal(webSearchStub.calls.length, 3);
  assert.deepEqual(
    webSearchStub.calls.map((c) => c.strategy),
    ['name_city', 'name_postcode', 'name_siren'],
  );
  // attempted contient api_gouv + heuristic_url_guess + 3 websearch
  const wsAttempts = out.attempted.filter((a) => a.source.startsWith('websearch_'));
  assert.equal(wsAttempts.length, 3);
  assert.deepEqual(
    wsAttempts.map((a) => a.source),
    ['websearch_name_city', 'websearch_name_postcode', 'websearch_name_siren'],
  );
});

// Cas T2.3 : apiGouv valide → court-circuit, DDG jamais appelé
test('findWebsite — apiGouv valide → DDG jamais appelé (économie ressources)', async () => {
  const apiGouv = makeApiGouvStub([
    { url: 'https://acme.fr', source: 'api_gouv', initialConfidence: 0.85, signals: [] },
  ]);
  const webSearchStub = makeWebSearchStub({
    byStrategy: { name_city: [{ url: 'https://should-not-be-called.fr' }] },
  });
  const validator = makeValidatorStub({ confidence: 0.99, proofType: 'siren_match', signals: [] });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'api_gouv');
  assert.equal(webSearchStub.calls.length, 0, 'DDG ne doit pas être appelé');
});

// Cas T2.4 : DDG blocked → arrêt cascade, recordFailure
test('findWebsite — DDG SearchBlockedError → cascade stoppée, recordFailure', async () => {
  const apiGouv = makeApiGouvStub([]);
  const blockedErr = new Error('rate-limited');
  blockedErr.code = 'blocked';
  const webSearchStub = makeWebSearchStub({ throwError: blockedErr });
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon', codePostal: '69001', siren: '123456789' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, null);
  assert.equal(cache.calls.recordFailure.length, 1);
  // Premier appel a throw blocked → on stoppe, pas de tentative sur les autres stratégies
  assert.equal(webSearchStub.calls.length, 1);
  // attempted contient le rejectedReason 'blocked' sur la stratégie tentée
  const wsAttempted = out.attempted.filter((a) => a.source.startsWith('websearch_'));
  assert.equal(wsAttempted.length, 1);
  assert.equal(wsAttempted[0].rejectedReason, 'blocked');
});

// Cas T2.5 : agrégateur dans les résultats → filtré côté webSearch (validator pas appelé)
test('findWebsite — résultats agrégateurs filtrés en amont, validator pas appelé', async () => {
  const apiGouv = makeApiGouvStub([]);
  // On simule webSearch qui filtre déjà les agrégateurs (comportement réel) :
  // si tous les résultats étaient des agrégateurs, searchOneStrategy retourne [].
  const webSearchStub = makeWebSearchStub({
    byStrategy: {
      name_city: [], // tout filtré comme agrégateur
      name_postcode: [], // pas de codePostal de toute façon
    },
  });
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, null);
  // validator JAMAIS appelé : aucun candidat n'a survécu au filtrage
  assert.equal(validator.calls.length, 0);
});

// Cas T2.6 : transient → continue les autres stratégies
test('findWebsite — DDG transient sur 1 stratégie → continue les autres', async () => {
  const apiGouv = makeApiGouvStub([]);
  let callCount = 0;
  const transientErr = new Error('http 503');
  transientErr.code = 'transient';
  const webSearchStub = {
    stub: {
      QUERY_STRATEGIES: webSearchReal.QUERY_STRATEGIES,
      canApply: webSearchReal.canApply,
      searchOneStrategy: async (strategy) => {
        callCount++;
        if (strategy.name === 'name_city') throw transientErr;
        if (strategy.name === 'name_postcode') {
          return [{
            url: 'https://acme.fr', source: 'websearch', strategy: 'name_postcode',
            backend: 'duckduckgo_html', initialConfidence: 0.65,
            signals: ['websearch_name_postcode'], rank: 1,
          }];
        }
        return [];
      },
    },
    calls: { count: () => callCount },
  };
  const validator = makeValidatorStub({ confidence: 0.99, proofType: 'siren_match', signals: [] });
  const cache = makeCacheStub();
  const out = await findWebsite(
    {
      siren: '123456789', companyName: 'ACME', ville: 'Lyon', codePostal: '69001',
      // T3 : mode batch nécessaire pour autoriser name_postcode après échec name_city
      options: { mode: 'batch' },
    },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: emptyHeuristic,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_postcode');
});

// ─── T1bis : source heuristicUrlGuess ──────────────────────────────────────

function makeHeuristicStub(candidates = [], throwError = null) {
  const calls = [];
  return {
    stub: {
      findCandidatesViaHeuristic: async (input, opts) => {
        calls.push({ input, opts });
        if (throwError) throw throwError;
        if (typeof candidates === 'function') return candidates(input);
        return candidates;
      },
    },
    calls,
  };
}

test('findWebsite — apiGouv 0 + heuristic 1 valide → source heuristic_url_guess + DDG jamais appelé', async () => {
  const apiGouv = makeApiGouvStub([]);
  const heuristic = makeHeuristicStub([
    {
      url: 'https://acme.fr',
      source: 'heuristic_url_guess',
      initialConfidence: 0.70,
      signals: ['heuristic_slug:ACME'],
    },
  ]);
  const webSearchStub = makeWebSearchStub({
    byStrategy: { name_city: [{ url: 'https://should-not-be-called.fr' }] },
  });
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    proofDetails: { matchedSirenOn: 'https://acme.fr/mentions-legales' },
    signals: ['siren_match'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME SAS', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: heuristic.stub,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'heuristic_url_guess');
  assert.equal(out.confidence, 0.99);
  assert.equal(cache.calls.put.length, 1);
  assert.equal(webSearchStub.calls.length, 0, 'websearch ne doit pas être appelé');
  // attempted : api_gouv puis heuristic_url_guess
  assert.equal(out.attempted[0].source, 'api_gouv');
  assert.equal(out.attempted[1].source, 'heuristic_url_guess');
  assert.equal(out.attempted[1].candidates, 1);
});

test('findWebsite — apiGouv 0 + heuristic 0 → fallback websearch cascade', async () => {
  const apiGouv = makeApiGouvStub([]);
  const heuristic = makeHeuristicStub([]);
  const webSearchStub = makeWebSearchStub({
    byStrategy: {
      name_city: [
        {
          url: 'https://acme.fr', source: 'websearch', strategy: 'name_city',
          backend: 'duckduckgo_html', initialConfidence: 0.65,
          signals: ['websearch_name_city'], rank: 1,
        },
      ],
    },
  });
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    signals: ['siren_match'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: heuristic.stub,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_city');
  assert.equal(heuristic.calls.length, 1);
  assert.equal(webSearchStub.calls.length, 1);
  // attempted : api_gouv (0), heuristic_url_guess (0), websearch_name_city (1)
  assert.equal(out.attempted[0].source, 'api_gouv');
  assert.equal(out.attempted[1].source, 'heuristic_url_guess');
  assert.equal(out.attempted[1].candidates, 0);
  assert.equal(out.attempted[2].source, 'websearch_name_city');
});

test('findWebsite — heuristic throw → rejectedReason posé, websearch tenté quand même', async () => {
  const apiGouv = makeApiGouvStub([]);
  const heuristicErr = new Error('heuristic crashed');
  heuristicErr.code = 'transient';
  const heuristic = makeHeuristicStub([], heuristicErr);
  const webSearchStub = makeWebSearchStub({
    byStrategy: {
      name_city: [
        {
          url: 'https://acme.fr', source: 'websearch', strategy: 'name_city',
          backend: 'duckduckgo_html', initialConfidence: 0.65,
          signals: ['websearch_name_city'], rank: 1,
        },
      ],
    },
  });
  const validator = makeValidatorStub({
    confidence: 0.99,
    proofType: 'siren_match',
    signals: ['siren_match'],
  });
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '123456789', companyName: 'ACME', ville: 'Lyon' },
    {
      apiGouvImpl: apiGouv.stub,
      heuristicImpl: heuristic.stub,
      webSearchImpl: webSearchStub.stub,
      validatorImpl: validator.stub,
      cacheImpl: cache.stub,
    },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.source, 'websearch_name_city');
  // attempted contient le rejectedReason transient sur heuristic
  const heur = out.attempted.find((a) => a.source === 'heuristic_url_guess');
  assert.ok(heur);
  assert.equal(heur.rejectedReason, 'transient');
  // Cascade webSearch a continué malgré l'échec heuristic
  assert.equal(webSearchStub.calls.length, 1);
});
