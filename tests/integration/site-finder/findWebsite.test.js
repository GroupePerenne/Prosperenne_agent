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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, null);
  assert.equal(out.attempted.length, 1);
  assert.equal(out.attempted[0].rejectedReason, 'transient');
});

// ─── Cas 8 : siren invalide ────────────────────────────────────────────────

test('findWebsite — siren invalide → output null, signal invalid_siren, pas d\'appel', async () => {
  const apiGouv = makeApiGouvStub([]);
  const validator = makeValidatorStub({});
  const cache = makeCacheStub();
  const out = await findWebsite(
    { siren: '12345', companyName: 'ACME' },
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
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
    { apiGouvImpl: apiGouv.stub, validatorImpl: validator.stub, cacheImpl: cache.stub },
  );
  assert.equal(out.siteUrl, 'https://acme.fr');
  assert.equal(out.confidence, 0.70);
  assert.equal(out.proofType, 'weak_signals');
});
