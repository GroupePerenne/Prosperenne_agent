'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const webSearch = require('../../../../shared/site-finder/sources/webSearch');
const {
  findCandidatesViaWebSearch,
  searchOneStrategy,
  isAggregator,
  canApply,
  QUERY_STRATEGIES,
  _resetPolitenessForTests,
} = webSearch;

function makeBackendStub({ resultsByQuery = {}, throwError = null, fixedResults = null } = {}) {
  const calls = [];
  const stub = {
    BACKEND_ID: 'test_backend',
    search: async (query, opts) => {
      calls.push({ query, opts });
      if (throwError) throw throwError;
      if (fixedResults) return fixedResults;
      return resultsByQuery[query] || [];
    },
  };
  return { stub, calls };
}

// ─── isAggregator ──────────────────────────────────────────────────────────

test('isAggregator — true pour societe.com et sous-domaines', () => {
  assert.equal(isAggregator('https://www.societe.com/foo'), true);
  assert.equal(isAggregator('https://societe.com/'), true);
  assert.equal(isAggregator('https://blog.linkedin.com/post'), true);
});

test('isAggregator — false pour sites entreprise réels', () => {
  assert.equal(isAggregator('https://acme.fr'), false);
  assert.equal(isAggregator('https://inforsud-technologies.com'), false);
});

test('isAggregator — true pour annuaire-entreprises et data.gouv', () => {
  assert.equal(
    isAggregator('https://annuaire-entreprises.data.gouv.fr/entreprise/foo'),
    true,
  );
  assert.equal(isAggregator('https://www.pappers.fr/entreprise/x'), true);
});

test('isAggregator — false pour entrée invalide', () => {
  assert.equal(isAggregator(null), false);
  assert.equal(isAggregator(''), false);
  assert.equal(isAggregator('not-a-url'), false);
});

// ─── canApply ──────────────────────────────────────────────────────────────

test('canApply — name_city requiert companyName + ville', () => {
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  assert.equal(canApply(strategy, { companyName: 'ACME', ville: 'Lyon' }), true);
  assert.equal(canApply(strategy, { companyName: 'ACME' }), false);
  assert.equal(canApply(strategy, { ville: 'Lyon' }), false);
  assert.equal(canApply(strategy, { companyName: 'ACME', ville: '' }), false);
});

test('canApply — name_director requiert dirigeantName', () => {
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_director');
  assert.equal(
    canApply(strategy, { companyName: 'ACME', dirigeantName: 'Jean Dupont' }),
    true,
  );
  assert.equal(canApply(strategy, { companyName: 'ACME' }), false);
});

// ─── searchOneStrategy ─────────────────────────────────────────────────────

test('searchOneStrategy — applique la query et tague le candidat avec la stratégie', async () => {
  _resetPolitenessForTests();
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const { stub, calls } = makeBackendStub({
    resultsByQuery: {
      '"ACME" Lyon': [
        { url: 'https://acme.fr', title: 'ACME', rank: 1 },
        { url: 'https://other.fr', title: 'Other', rank: 2 },
      ],
    },
  });
  const candidates = await searchOneStrategy(
    strategy,
    { companyName: 'ACME', ville: 'Lyon' },
    { backend: stub, politenessDelayMs: 0 },
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].url, 'https://acme.fr');
  assert.equal(candidates[0].source, 'websearch');
  assert.equal(candidates[0].strategy, 'name_city');
  assert.equal(candidates[0].backend, 'test_backend');
  assert.equal(candidates[0].initialConfidence, 0.65);
  assert.ok(candidates[0].signals.includes('websearch_name_city'));
  assert.ok(candidates[0].signals.includes('backend_test_backend'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, '"ACME" Lyon');
});

test('searchOneStrategy — filtre les agrégateurs (aucun candidat agrégateur retourné)', async () => {
  _resetPolitenessForTests();
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const { stub } = makeBackendStub({
    fixedResults: [
      { url: 'https://www.societe.com/societe/acme-123456789.html', title: 'Société.com', rank: 1 },
      { url: 'https://www.linkedin.com/company/acme', title: 'LinkedIn', rank: 2 },
      { url: 'https://acme.fr', title: 'ACME', rank: 3 },
    ],
  });
  const candidates = await searchOneStrategy(
    strategy,
    { companyName: 'ACME', ville: 'Lyon' },
    { backend: stub, politenessDelayMs: 0 },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, 'https://acme.fr');
});

test('searchOneStrategy — stratégie inapplicable retourne array vide sans appel', async () => {
  _resetPolitenessForTests();
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_postcode');
  const { stub, calls } = makeBackendStub({});
  const candidates = await searchOneStrategy(
    strategy,
    { companyName: 'ACME' }, // pas de codePostal
    { backend: stub, politenessDelayMs: 0 },
  );
  assert.deepEqual(candidates, []);
  assert.equal(calls.length, 0);
});

test('searchOneStrategy — propage les erreurs backend (blocked, transient)', async () => {
  _resetPolitenessForTests();
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const blockedErr = new Error('rate-limited');
  blockedErr.code = 'blocked';
  const { stub } = makeBackendStub({ throwError: blockedErr });
  await assert.rejects(
    () => searchOneStrategy(
      strategy,
      { companyName: 'ACME', ville: 'Lyon' },
      { backend: stub, politenessDelayMs: 0 },
    ),
    (err) => err.code === 'blocked',
  );
});

// ─── findCandidatesViaWebSearch (mode agrégation) ──────────────────────────

test('findCandidatesViaWebSearch — agrège les candidats de toutes les stratégies applicables', async () => {
  _resetPolitenessForTests();
  const { stub, calls } = makeBackendStub({
    resultsByQuery: {
      '"ACME" Lyon': [{ url: 'https://acme.fr', rank: 1 }],
      '"ACME" 69001': [{ url: 'https://acme.fr', rank: 1 }, { url: 'https://acme-secondary.fr', rank: 2 }],
      '"ACME" 123456789': [{ url: 'https://acme-byseren.fr', rank: 1 }],
    },
  });
  const candidates = await findCandidatesViaWebSearch(
    { companyName: 'ACME', ville: 'Lyon', codePostal: '69001', siren: '123456789' },
    { backend: stub, politenessDelayMs: 0 },
  );
  // Dédup transversal : acme.fr apparaît 1× même si retourné par 2 stratégies
  const urls = candidates.map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://acme-byseren.fr', 'https://acme-secondary.fr', 'https://acme.fr']);
  // 3 stratégies applicables (name_city, name_postcode, name_siren), pas les 2 autres
  assert.equal(calls.length, 3);
});

test('findCandidatesViaWebSearch — propage erreur blocked du backend', async () => {
  _resetPolitenessForTests();
  const blockedErr = new Error('blocked');
  blockedErr.code = 'blocked';
  const { stub } = makeBackendStub({ throwError: blockedErr });
  await assert.rejects(
    () => findCandidatesViaWebSearch(
      { companyName: 'ACME', ville: 'Lyon' },
      { backend: stub, politenessDelayMs: 0 },
    ),
    (err) => err.code === 'blocked',
  );
});

// ─── Politesse ─────────────────────────────────────────────────────────────

test('searchOneStrategy — respecte le delay de politesse entre 2 appels au même backend', async () => {
  _resetPolitenessForTests();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const { stub } = makeBackendStub({ fixedResults: [] });

  await searchOneStrategy(
    strategy,
    { companyName: 'A', ville: 'L' },
    { backend: stub, politenessDelayMs: 1000, sleepImpl },
  );
  // Premier appel : pas de sleep (lastFetch undefined)
  assert.equal(sleepCalls.length, 0);

  await searchOneStrategy(
    strategy,
    { companyName: 'B', ville: 'M' },
    { backend: stub, politenessDelayMs: 1000, sleepImpl },
  );
  // Deuxième appel rapproché : sleep > 0
  assert.equal(sleepCalls.length, 1);
  assert.ok(sleepCalls[0] > 0 && sleepCalls[0] <= 1000);
});

test('searchOneStrategy — politenessDelayMs=0 désactive le sleep', async () => {
  _resetPolitenessForTests();
  const sleepCalls = [];
  const sleepImpl = async (ms) => { sleepCalls.push(ms); };
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const { stub } = makeBackendStub({ fixedResults: [] });

  await searchOneStrategy(strategy, { companyName: 'A', ville: 'L' }, { backend: stub, politenessDelayMs: 0, sleepImpl });
  await searchOneStrategy(strategy, { companyName: 'B', ville: 'M' }, { backend: stub, politenessDelayMs: 0, sleepImpl });
  assert.equal(sleepCalls.length, 0);
});

// ─── QUERY_STRATEGIES ──────────────────────────────────────────────────────

test('QUERY_STRATEGIES — 5 stratégies ordonnées', () => {
  const names = QUERY_STRATEGIES.map((s) => s.name);
  assert.deepEqual(names, ['name_city', 'name_postcode', 'name_siren', 'name_director', 'name_naf_city']);
});

test('QUERY_STRATEGIES — chaque stratégie a build/requires/name', () => {
  for (const s of QUERY_STRATEGIES) {
    assert.equal(typeof s.name, 'string');
    assert.ok(Array.isArray(s.requires));
    assert.equal(typeof s.build, 'function');
    assert.ok(s.requires.length >= 2);
  }
});

test('QUERY_STRATEGIES — name_city build forme la query attendue', () => {
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  assert.equal(strategy.build({ companyName: 'ACME SAS', ville: 'Lyon' }), '"ACME SAS" Lyon');
});

// ─── Cascade multi-backend ────────────────────────────────────────────────

function makeBackend(BACKEND_ID, behavior) {
  return {
    BACKEND_ID,
    search: async () => {
      if (typeof behavior === 'function') return behavior();
      if (behavior instanceof Error) throw behavior;
      return behavior || [];
    },
  };
}

test('cascade — backend 1 blocked → bascule sur backend 2 qui répond', async () => {
  _resetPolitenessForTests();
  const blockedErr = Object.assign(new Error('rate-limited'), { code: 'blocked' });
  const b1 = makeBackend('b1', blockedErr);
  const b2 = makeBackend('b2', [{ url: 'https://acme.fr', title: 'ACME', rank: 1 }]);
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const out = await searchOneStrategy(
    strategy,
    { companyName: 'ACME', ville: 'Lyon' },
    { backend: [b1, b2], politenessDelayMs: 0 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].backend, 'b2');
});

test('cascade — backend 1 transient → bascule, backend 2 répond', async () => {
  _resetPolitenessForTests();
  const transientErr = Object.assign(new Error('http 503'), { code: 'transient' });
  const b1 = makeBackend('b1', transientErr);
  const b2 = makeBackend('b2', [{ url: 'https://acme.fr', title: 'ACME', rank: 1 }]);
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const out = await searchOneStrategy(
    strategy,
    { companyName: 'ACME', ville: 'Lyon' },
    { backend: [b1, b2], politenessDelayMs: 0 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].backend, 'b2');
});

test('cascade — tous blocked → throw blocked (orchestrateur stoppera)', async () => {
  _resetPolitenessForTests();
  const blockedErr = Object.assign(new Error('rate-limited'), { code: 'blocked' });
  const b1 = makeBackend('b1', blockedErr);
  const b2 = makeBackend('b2', blockedErr);
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  await assert.rejects(
    () => searchOneStrategy(
      strategy,
      { companyName: 'ACME', ville: 'Lyon' },
      { backend: [b1, b2], politenessDelayMs: 0 },
    ),
    (err) => err && err.code === 'blocked',
  );
});

test('cascade — premier backend [] → on retient sa reponse, pas de fallback', async () => {
  _resetPolitenessForTests();
  const b1 = makeBackend('b1', []);
  const b2 = makeBackend('b2', [{ url: 'https://should-not-be-called.fr' }]);
  const strategy = QUERY_STRATEGIES.find((s) => s.name === 'name_city');
  const out = await searchOneStrategy(
    strategy,
    { companyName: 'ACME', ville: 'Lyon' },
    { backend: [b1, b2], politenessDelayMs: 0 },
  );
  // 0 résultats du premier backend = réponse légitime (rien trouvé), on
  // ne tente PAS le suivant — économie de requêtes.
  assert.deepEqual(out, []);
});

test('getDefaultBackends — env override liste de backends', () => {
  const original = process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  process.env.SITE_FINDER_WEBSEARCH_BACKENDS = 'mojeek,ecosia';
  const out = webSearch.getDefaultBackends();
  assert.equal(out.length, 2);
  assert.equal(out[0].BACKEND_ID, 'mojeek');
  assert.equal(out[1].BACKEND_ID, 'ecosia');
  if (original === undefined) delete process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  else process.env.SITE_FINDER_WEBSEARCH_BACKENDS = original;
});

test('getDefaultBackends — env avec ID inconnu filtré, garde le valide', () => {
  const original = process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  process.env.SITE_FINDER_WEBSEARCH_BACKENDS = 'unknown_engine,mojeek';
  const out = webSearch.getDefaultBackends();
  assert.equal(out.length, 1);
  assert.equal(out[0].BACKEND_ID, 'mojeek');
  if (original === undefined) delete process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  else process.env.SITE_FINDER_WEBSEARCH_BACKENDS = original;
});

test('getDefaultBackends — pas d\'env → ordre par défaut (4 backends)', () => {
  const original = process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  delete process.env.SITE_FINDER_WEBSEARCH_BACKENDS;
  const out = webSearch.getDefaultBackends();
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((b) => b.BACKEND_ID),
    ['duckduckgo_lite', 'mojeek', 'ecosia', 'duckduckgo_html'],
  );
  if (original !== undefined) process.env.SITE_FINDER_WEBSEARCH_BACKENDS = original;
});
