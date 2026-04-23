/**
 * Tests d'intégration — pipeline complet lead-exhauster.
 *
 * Couvre les 5 scénarios de SPEC §11.2 :
 *   1. domaine connu + INSEE connu → pattern direct → confidence 0.85+
 *   2. domaine connu + INSEE absent → resolveDecisionMaker → resolveEmail
 *   3. domaine absent → resolveDomain résout via API gouv → cascade normale
 *   4. domaine + INSEE connus, pattern échec → Dropcontact → success
 *   5. tous échecs → unresolvable
 *
 * Mocks :
 *   - `fetchImpl` injecté pour simuler API gouv + scraping + LinkedIn
 *   - `adapters.dropcontact` mocké (jamais d'appel réseau réel)
 *   - `adapters.readLeadContact` / `upsertLeadContact` in-memory
 *
 * Aucun appel réseau réel. DROPCONTACT_ENABLED doit être false.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { leadExhauster } = require('../../../shared/lead-exhauster');

/**
 * Constructeur de fetchImpl qui route par URL vers des réponses
 * prédéfinies. Permet de simuler à la fois l'API gouv et les pages
 * scrappées en un seul mock réseau.
 */
function makeFetchMock(routes) {
  return async (url, opts) => {
    const u = typeof url === 'string' ? url : url.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        return handler(u, opts);
      }
    }
    return { ok: false, status: 404 };
  };
}

function htmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => html,
    json: async () => ({}),
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function makeCacheAdapters() {
  const cache = new Map();
  return {
    readLeadContact: async ({ siren, firstName, lastName }) => {
      const key = `${siren}|${String(firstName || '').toLowerCase()}|${String(lastName || '').toLowerCase()}`;
      return cache.get(key) || null;
    },
    upsertLeadContact: async (row) => {
      const key = `${row.siren}|${String(row.firstName || '').toLowerCase()}|${String(row.lastName || '').toLowerCase()}`;
      cache.set(key, { ...row, lastVerifiedAt: new Date().toISOString() });
      return true;
    },
    _cache: cache,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scénario 1 — domaine connu + INSEE connu → pattern direct
// ──────────────────────────────────────────────────────────────────────────

test('scénario 1 : domaine fourni + INSEE + pattern jean.dupont scrapé → ok confidence ≥ 0.85', async () => {
  const fetchImpl = makeFetchMock({
    '/contact': () => htmlResponse(
      '<html><body><h1>Nos équipes</h1><p>Jean Dupont, Directeur Général</p><p>Contact : <a href="mailto:jean.dupont@acme.fr">jean.dupont@acme.fr</a></p></body></html>',
    ),
    'acme.fr': () => htmlResponse(''), // autres pages vides
  });
  const cacheAdapters = makeCacheAdapters();

  const r = await leadExhauster(
    {
      siren: '123456789',
      beneficiaryId: 'oseys-morgane',
      firstName: 'Jean',
      lastName: 'Dupont',
      companyName: 'Acme SAS',
      companyDomain: 'acme.fr',
      trancheEffectif: '12',
    },
    { adapters: cacheAdapters, fetchImpl },
  );

  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.ok(r.confidence >= 0.85, `confidence=${r.confidence}`);
  assert.equal(r.source, 'internal_patterns');
  assert.equal(r.resolvedDomain, 'acme.fr');
  assert.equal(r.resolvedDecisionMaker.firstName, 'Jean');
  assert.equal(cacheAdapters._cache.size, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 2 — domaine connu + INSEE absent → resolveDecisionMaker
// ──────────────────────────────────────────────────────────────────────────

test('scénario 2 : domaine fourni + INSEE absent → décideur résolu depuis scraping équipe', async () => {
  const fetchImpl = makeFetchMock({
    '/equipe': () => htmlResponse(
      `<html><body>
        <h2>Marie Martin</h2><p>CEO & Fondatrice</p>
        <p>marie.martin@acme.fr</p>
        <h2>Paul Dupont</h2><p>Consultant</p>
      </body></html>`,
    ),
    'acme.fr': () => htmlResponse(''),
  });
  const cacheAdapters = makeCacheAdapters();

  const r = await leadExhauster(
    {
      siren: '987654321',
      beneficiaryId: 'oseys-morgane',
      // pas de firstName / lastName
      companyName: 'Acme SAS',
      companyDomain: 'acme.fr',
      trancheEffectif: '22',
    },
    { adapters: cacheAdapters, fetchImpl },
  );

  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'marie.martin@acme.fr');
  assert.equal(r.resolvedDecisionMaker.firstName, 'Marie');
  assert.equal(r.resolvedDecisionMaker.lastName, 'Martin');
  assert.equal(r.resolvedDecisionMaker.source, 'website');
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 3 — domaine absent → resolveDomain via API gouv
// ──────────────────────────────────────────────────────────────────────────

test('scénario 3 : domaine absent → API gouv le résout → scraping → ok', async () => {
  const fetchImpl = makeFetchMock({
    'recherche-entreprises': (url) => {
      if (url.includes('111222333')) {
        return jsonResponse({
          results: [{ siren: '111222333', siege: { site_web: 'https://www.beta-corp.fr/' } }],
        });
      }
      return jsonResponse({ results: [] });
    },
    'beta-corp.fr/contact': () => htmlResponse(
      '<p>Jean Dupont - DG - jean.dupont@beta-corp.fr</p>',
    ),
    'beta-corp.fr': () => htmlResponse(''),
  });
  const cacheAdapters = makeCacheAdapters();

  const r = await leadExhauster(
    {
      siren: '111222333',
      beneficiaryId: 'oseys-johnny',
      firstName: 'Jean',
      lastName: 'Dupont',
      companyName: 'Beta Corp',
      trancheEffectif: '11',
    },
    { adapters: cacheAdapters, fetchImpl },
  );

  assert.equal(r.status, 'ok');
  assert.equal(r.resolvedDomain, 'beta-corp.fr');
  assert.equal(r.email, 'jean.dupont@beta-corp.fr');
  assert.equal(r.source, 'internal_patterns');
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 4 — domaine + INSEE connus, pattern échec → Dropcontact
// ──────────────────────────────────────────────────────────────────────────

test('scénario 4 : interne échoue → Dropcontact activé résout nominative', async () => {
  const fetchImpl = makeFetchMock({
    // Scraping ne retourne rien d'utile
    'acme.fr': () => htmlResponse('<p>Site en construction</p>'),
  });
  const cacheAdapters = makeCacheAdapters();
  const dropcontactCalls = [];
  const dropcontact = {
    name: 'dropcontact',
    enabled: true,
    resolve: async (input) => {
      dropcontactCalls.push(input);
      return {
        email: 'jean.dupont@acme.fr',
        confidence: 0.95, // nominative
        cost_cents: 8,
        providerRaw: { qualification: 'nominative' },
      };
    },
  };

  const r = await leadExhauster(
    {
      siren: '555666777',
      beneficiaryId: 'oseys-morgane',
      firstName: 'Jean',
      lastName: 'Dupont',
      companyName: 'Acme',
      companyDomain: 'acme.fr',
      trancheEffectif: '12',
    },
    { adapters: { ...cacheAdapters, dropcontact }, fetchImpl },
  );

  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.equal(r.source, 'dropcontact');
  assert.equal(r.cost_cents, 8);
  assert.equal(dropcontactCalls.length, 1);
  assert.equal(dropcontactCalls[0].firstName, 'Jean');
  assert.equal(dropcontactCalls[0].companyDomain, 'acme.fr');
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 5 — tous échecs → unresolvable
// ──────────────────────────────────────────────────────────────────────────

test('scénario 5 : domaine KO + Dropcontact miss → unresolvable, email null', async () => {
  const fetchImpl = makeFetchMock({
    'recherche-entreprises': () => jsonResponse({ results: [] }),
  });
  const cacheAdapters = makeCacheAdapters();
  const dropcontact = {
    name: 'dropcontact',
    enabled: true,
    resolve: async () => ({ email: null, confidence: 0, cost_cents: 0, providerRaw: { miss: true } }),
  };

  const r = await leadExhauster(
    {
      siren: '999000111',
      beneficiaryId: 'oseys-morgane',
      firstName: 'Jean',
      lastName: 'Dupont',
      companyName: 'Ghost Corp',
    },
    { adapters: { ...cacheAdapters, dropcontact }, fetchImpl },
  );

  assert.equal(r.status, 'unresolvable');
  assert.equal(r.email, null);
  assert.equal(r.resolvedDomain, null);
  // Trace écrite malgré unresolvable (pour ne pas retenter avant TTL)
  assert.equal(cacheAdapters._cache.size, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 6 (bonus) — cache hit sur 2ème appel
// ──────────────────────────────────────────────────────────────────────────

test('scénario 6 : 2ème appel identique → cache hit sans scraping', async () => {
  let scrapeCount = 0;
  const fetchImpl = makeFetchMock({
    '/contact': () => {
      scrapeCount++;
      return htmlResponse('<p>Jean Dupont - jean.dupont@acme.fr</p>');
    },
    'acme.fr': () => htmlResponse(''),
  });
  const cacheAdapters = makeCacheAdapters();
  const input = {
    siren: '333444555',
    beneficiaryId: 'oseys-morgane',
    firstName: 'Jean',
    lastName: 'Dupont',
    companyDomain: 'acme.fr',
    trancheEffectif: '12',
  };

  const r1 = await leadExhauster(input, { adapters: cacheAdapters, fetchImpl });
  assert.equal(r1.status, 'ok');
  assert.equal(r1.cached, false);

  const r2 = await leadExhauster(input, { adapters: cacheAdapters, fetchImpl });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.cached, true);
  assert.equal(r2.source, 'cache');
  assert.equal(r2.email, 'jean.dupont@acme.fr');
});

// ──────────────────────────────────────────────────────────────────────────
// Scénario 7 (bonus) — simulated=true → Dropcontact skip
// ──────────────────────────────────────────────────────────────────────────

test('scénario 7 : simulated=true → pas d appel Dropcontact même si interne échoue', async () => {
  const fetchImpl = makeFetchMock({
    'acme.fr': () => htmlResponse('<p>Rien</p>'),
  });
  const cacheAdapters = makeCacheAdapters();
  let dropcontactCalled = false;
  const dropcontact = {
    name: 'dropcontact',
    enabled: true,
    resolve: async () => {
      dropcontactCalled = true;
      return { email: 'jean.dupont@acme.fr', confidence: 0.95, cost_cents: 8, providerRaw: {} };
    },
  };

  const r = await leadExhauster(
    {
      siren: '777888999',
      beneficiaryId: 'oseys-morgane',
      firstName: 'Jean',
      lastName: 'Dupont',
      companyDomain: 'acme.fr',
      trancheEffectif: '12',
      simulated: true,
    },
    { adapters: { ...cacheAdapters, dropcontact }, fetchImpl },
  );

  assert.equal(r.status, 'unresolvable');
  assert.equal(dropcontactCalled, false);
  assert.equal(r.simulated, true);
});
