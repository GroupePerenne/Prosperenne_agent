/**
 * Tests unitaires — shared/lead-exhauster/adapters/dropcontact.js
 *
 * Couvre :
 *   - Contrat EmailExternalAdapter
 *   - Validation input + fail-fast apiKey
 *   - Mapping qualification → confidence
 *   - HTTP batch submit + polling (mocké)
 *   - Budget check avant + update après succès
 *   - Circuit breaker 3 échecs → ouvert 10 min
 *   - Pay-on-success : cost_cents=0 si pas d email
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DropcontactAdapter,
  QUALIFICATION_MAP,
  _resetBreakerForTests,
} = require('../../../shared/lead-exhauster/adapters/dropcontact');
const { validateAdapter } = require('../../../shared/lead-exhauster/adapters/interface');

const VALID_INPUT = {
  firstName: 'Jean',
  lastName: 'Dupont',
  companyName: 'Acme SAS',
  companyDomain: 'acme.fr',
  siren: '123456789',
};

function mockBudgetOk() {
  return {
    canSpend: async () => ({ ok: true, spent: 0, budget: 2400 }),
    addSpend: async () => true,
  };
}

function mockBudgetExceeded() {
  return {
    canSpend: async () => ({ ok: false, spent: 2400, budget: 2400, reason: 'budget_exceeded' }),
    addSpend: async () => true,
  };
}

function trackBudget() {
  const spendCalls = [];
  return {
    spendCalls,
    budget: {
      canSpend: async () => ({ ok: true, spent: 0, budget: 2400 }),
      addSpend: async (provider, cost, opts) => {
        spendCalls.push({ provider, cost, opts });
        return true;
      },
    },
  };
}

function fetchError(status) {
  return async () => ({ ok: false, status });
}

const noSleep = async () => {};

test.beforeEach(() => {
  _resetBreakerForTests();
});

// ─── Contrat EmailExternalAdapter ──────────────────────────────────────────

test('DropcontactAdapter — respecte le contrat EmailExternalAdapter', () => {
  const adapter = new DropcontactAdapter({ enabled: false });
  const { ok, errors } = validateAdapter(adapter);
  assert.equal(ok, true, `validateAdapter errors: ${errors.join('; ')}`);
  assert.equal(adapter.name, 'dropcontact');
  assert.equal(adapter.enabled, false);
  assert.equal(typeof adapter.resolve, 'function');
});

test('DropcontactAdapter — enabled=true sans apiKey lance à construction', () => {
  assert.throws(
    () => new DropcontactAdapter({ enabled: true, apiKey: '' }),
    /apiKey manquante/i,
  );
});

// ─── qualificationToConfidence ─────────────────────────────────────────────

test('qualificationToConfidence — mapping SPEC 5.3', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative_verified'), 0.98);
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence('catch_all'), 0.50);
  assert.equal(DropcontactAdapter.qualificationToConfidence('role'), 0.30);
});

test('qualificationToConfidence — tolère casse et espaces', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('NOMINATIVE'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence(' nominative '), 0.95);
});

test('qualificationToConfidence — qualifs inconnues → 0', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('bogus'), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(''), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(null), 0);
});

test('qualificationToConfidence — format Dropcontact V2 avec suffix @pro', () => {
  // Format observé 2026-05-05 sur fichier exemple app.dropcontact.com
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative@pro'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence('catch-all@pro'), 0.50);
  assert.equal(DropcontactAdapter.qualificationToConfidence('role@pro'), 0.30);
  assert.equal(DropcontactAdapter.qualificationToConfidence('NOMINATIVE@PRO'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative_verified@pro'), 0.98);
});

test('qualificationToConfidence — V2 ne casse pas si seulement préfixe inconnu', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('foobar@pro'), 0);
});

test('QUALIFICATION_MAP — figé, pas mutable', () => {
  assert.throws(() => { QUALIFICATION_MAP.nominative = 0.01; });
});

// ─── validateInput ─────────────────────────────────────────────────────────

test('validateInput — champs minimaux requis', () => {
  assert.deepEqual(DropcontactAdapter.validateInput(VALID_INPUT), []);
});

test('validateInput — champs manquants remontent erreurs explicites', () => {
  const errors = DropcontactAdapter.validateInput({});
  assert.ok(errors.some((e) => e.includes('firstName')));
  assert.ok(errors.some((e) => e.includes('lastName')));
  assert.ok(errors.some((e) => e.includes('companyName')));
  assert.ok(errors.some((e) => e.includes('siren')));
});

test('validateInput — SIREN doit faire 9 chiffres', () => {
  const e = DropcontactAdapter.validateInput({ ...VALID_INPUT, siren: '12345' });
  assert.ok(e.some((x) => x.includes('siren')));
});

// ─── resolve : disabled / circuit breaker / budget ────────────────────────

test('resolve — input invalide → validation error, pas d appel réseau', async () => {
  let called = false;
  const adapter = new DropcontactAdapter({
    enabled: false,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  const r = await adapter.resolve({ siren: 'bogus' });
  assert.equal(r.email, null);
  assert.ok(r.error);
  assert.equal(called, false);
});

test('resolve — disabled → skip sans coût', async () => {
  const adapter = new DropcontactAdapter({ enabled: false });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.equal(r.cost_cents, 0);
  assert.equal(r.providerRaw.skipped, 'disabled');
});

test('resolve — budget exceeded → skip sans call réseau', async () => {
  let fetchCalled = false;
  const adapter = new DropcontactAdapter({
    enabled: true,
    apiKey: 'test-key',
    fetchImpl: async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; },
    budgetAdapter: mockBudgetExceeded(),
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.equal(r.cost_cents, 0);
  assert.equal(r.providerRaw.skipped, 'budget_budget_exceeded');
  assert.equal(fetchCalled, false);
});

// ─── resolve : HTTP batch + polling ───────────────────────────────────────

test('resolve — POST /batch OK → polling retourne data → email nominative', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({
      url: String(url),
      method: opts.method,
      headers: { ...(opts.headers || {}) },
      body: opts.body || null,
    });
    if (opts.method === 'POST') {
      return {
        ok: true, status: 200,
        json: async () => ({ success: true, request_id: 'req-123' }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{
          email: [{ email: 'jean.dupont@acme.fr', qualification: 'nominative' }],
          first_name: 'Jean',
          last_name: 'Dupont',
        }],
      }),
    };
  };

  const tracked = trackBudget();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'test-key',
    fetchImpl, budgetAdapter: tracked.budget,
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.equal(r.confidence, 0.95);
  assert.equal(r.cost_cents, 3);
  assert.equal(r.qualification, 'nominative');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'GET');
  assert.ok(calls[1].url.includes('req-123'));
  assert.equal(tracked.spendCalls.length, 1);
  assert.equal(tracked.spendCalls[0].cost, 3);

  // Auth : clé dans header X-Access-Token, PAS dans le body ni dans
  // l'URL du polling (Dropcontact V1 API contract, validé terrain
  // 2026-04-24 : sans X-Access-Token → 403 "No api key received").
  assert.equal(calls[0].headers['X-Access-Token'], 'test-key');
  const postBody = JSON.parse(calls[0].body);
  assert.equal(postBody.apiKey, undefined, 'body POST ne doit PAS contenir apiKey');
  assert.ok(Array.isArray(postBody.data));
  assert.equal(calls[1].headers['X-Access-Token'], 'test-key');
  assert.ok(!calls[1].url.includes('apiKey'), 'URL polling ne doit PAS contenir apiKey= en query');
});

test('resolve — polling wait puis succès', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    calls++;
    if (calls < 3) {
      return { ok: true, status: 200, json: async () => ({ success: false, reason: 'wait' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{ email: 'j@acme.fr', qualification: 'nominative' }],
      }),
    };
  };
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, 'j@acme.fr');
  assert.equal(r.confidence, 0.95);
  assert.equal(calls, 3);
});

test('resolve — POST échoue → error, pas de budget update', async () => {
  const tracked = trackBudget();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k',
    fetchImpl: fetchError(503),
    budgetAdapter: tracked.budget,
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.ok(r.error);
  assert.equal(tracked.spendCalls.length, 0);
});

test('resolve — polling exhausted sans data → error', async () => {
  let calls = 0;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    calls++;
    return { ok: true, status: 200, json: async () => ({ success: false, reason: 'wait' }) };
  };
  const tracked = trackBudget();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: tracked.budget,
    pollDelays: [1, 1, 1], // 3 essais rapides, tous wait
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.ok(r.error);
  assert.equal(calls, 3);
  assert.equal(tracked.spendCalls.length, 0);
});

// ─── Pay-on-success ────────────────────────────────────────────────────────

test('resolve — catch_all → confidence 0.50 mais cost_cents=0', async () => {
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{ email: [{ email: 'contact@acme.fr', qualification: 'catch_all' }] }],
      }),
    };
  };
  const tracked = trackBudget();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: tracked.budget,
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, 'contact@acme.fr');
  assert.equal(r.confidence, 0.50);
  assert.equal(r.cost_cents, 0);
  assert.equal(tracked.spendCalls.length, 0);
});

test('resolve — aucun email trouvé → email:null, cost_cents=0', async () => {
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{ email: [], first_name: 'Jean' }],
      }),
    };
  };
  const tracked = trackBudget();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: tracked.budget,
    sleepFn: noSleep,
  });
  const r = await adapter.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.equal(r.confidence, 0);
  assert.equal(r.cost_cents, 0);
  assert.equal(tracked.spendCalls.length, 0);
});

// ─── Circuit breaker ───────────────────────────────────────────────────────

test('resolve — 3 échecs consécutifs → circuit breaker ouvre, 4ème appel skip', async () => {
  _resetBreakerForTests();
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k',
    fetchImpl: fetchError(503),
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  await adapter.resolve(VALID_INPUT); // échec 1
  await adapter.resolve(VALID_INPUT); // échec 2
  await adapter.resolve(VALID_INPUT); // échec 3 → ouvre

  let called = false;
  const adapter2 = new DropcontactAdapter({
    enabled: true, apiKey: 'k',
    fetchImpl: async () => { called = true; return fetchError(503)(); },
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  const r = await adapter2.resolve(VALID_INPUT);
  assert.equal(r.email, null);
  assert.equal(r.providerRaw.skipped, 'circuit_open');
  assert.equal(called, false);
});

test('resolve — succès après échecs reset le breaker', async () => {
  _resetBreakerForTests();
  let failCount = 0;
  const fetchImpl = async (url, opts) => {
    if (failCount < 2) {
      failCount++;
      throw new Error('boom');
    }
    if (opts.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{ email: [{ email: 'j@acme.fr', qualification: 'nominative' }] }],
      }),
    };
  };
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  await adapter.resolve(VALID_INPUT); // échec 1
  await adapter.resolve(VALID_INPUT); // échec 2
  const r = await adapter.resolve(VALID_INPUT); // succès → reset
  assert.equal(r.email, 'j@acme.fr');

  // 1 seul échec après reset → pas de skip
  const adapter2 = new DropcontactAdapter({
    enabled: true, apiKey: 'k',
    fetchImpl: fetchError(503),
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  const r2 = await adapter2.resolve(VALID_INPUT);
  assert.equal(r2.email, null);
  assert.ok(r2.error);
  assert.notEqual(r2.providerRaw.skipped, 'circuit_open');
});

// ─── Contrat payload Dropcontact V1 — doc officielle ───────────────────────
// Doc Dropcontact V1 (developer.dropcontact.com) : le champ SIREN s'écrit
// `num_siren` dans le body data[0], pas `siren`. Sans `num_siren`, Dropcontact
// résout seulement via first_name+last_name+company, qui matche faiblement
// sans ancrage entreprise → hit rate effondré. Verdict mesuré pré-fix :
// ~1% sur 109 briefs Pereneo (14 mai 2026 mémoire). Bug structurel.
//
// Ce test fige le contrat : le body POST data[0] doit contenir `num_siren`,
// PAS `siren`. Régression interdite.

test('_callBatch — payload data[0] utilise num_siren (doc officielle Dropcontact V1)', async () => {
  let postBody = null;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      postBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ email: [] }] }),
    };
  };
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  await adapter.resolve(VALID_INPUT);
  assert.ok(postBody && postBody.data && postBody.data[0], 'data[0] présent dans body POST');
  assert.equal(postBody.data[0].num_siren, '123456789', 'num_siren doit valoir la valeur input.siren');
  assert.equal(postBody.data[0].siren, undefined, 'le champ legacy `siren` (sans num_) ne doit PAS être présent');
});

// Régression : plan v3.1 P1 — city + zipcode obligatoires dans le payload
// Dropcontact pour maximiser le match rate. Sans ancrage géographique,
// Dropcontact ne peut désambiguïser homonymes nationaux. Le pipeline doit
// propager city+zipcode depuis l'entité LeadBase v1 (cand.ville +
// cand.codePostal) jusqu'au payload final, sans perte intermédiaire.
test('_callBatch — payload data[0] contient city + zipcode quand input les fournit', async () => {
  let postBody = null;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      postBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ email: [] }] }),
    };
  };
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  await adapter.resolve({ ...VALID_INPUT, city: 'Lyon', zipcode: '69002' });
  assert.equal(postBody.data[0].city, 'Lyon', 'city doit être propagé dans data[0]');
  assert.equal(postBody.data[0].zipcode, '69002', 'zipcode doit être propagé dans data[0]');
});

test('_callBatch — payload data[0] city + zipcode fallback chaîne vide si input absents', async () => {
  let postBody = null;
  const fetchImpl = async (url, opts) => {
    if (opts.method === 'POST') {
      postBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true, request_id: 'r' }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ email: [] }] }),
    };
  };
  const adapter = new DropcontactAdapter({
    enabled: true, apiKey: 'k', fetchImpl,
    budgetAdapter: mockBudgetOk(),
    sleepFn: noSleep,
  });
  await adapter.resolve(VALID_INPUT);
  assert.equal(postBody.data[0].city, '', 'city absent → chaîne vide (Dropcontact ignore)');
  assert.equal(postBody.data[0].zipcode, '', 'zipcode absent → chaîne vide (Dropcontact ignore)');
});
