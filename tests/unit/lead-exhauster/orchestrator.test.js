/**
 * Tests unitaires — shared/lead-exhauster/index.js (orchestrateur).
 *
 * Couvre le pipeline complet via adapters injectés :
 *   - validation entrée
 *   - cache hit
 *   - enchaînement résolveur domaine → scraping → décideur → email
 *   - garde-fou seuil confidence
 *   - trace LeadContacts
 *   - experimentsContext tagging
 *   - reportFeedback
 *
 * Pas d'appel réseau réel (scrapeDomain, resolveDomain, dropcontact mockés).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { leadExhauster, reportFeedback } = require('../../../shared/lead-exhauster');

function makeAdapters(overrides = {}) {
  const traceCalls = [];
  return {
    calls: { trace: traceCalls },
    adapters: {
      readLeadContact: async () => null,
      upsertLeadContact: async (row) => {
        traceCalls.push(row);
        return true;
      },
      resolveDomain: async () => ({
        domain: 'acme.fr',
        confidence: 0.90,
        source: 'api_gouv',
        signals: ['api_gouv_site_web'],
        elapsedMs: 10,
      }),
      scrapeDomain: async () => ({
        emails: [{ email: 'jean.dupont@acme.fr', confidence: 0.80, sources: ['scraping:/contact'] }],
        teamProfiles: [
          { firstName: 'Jean', lastName: 'Dupont', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9, foundOn: '/contact' },
        ],
        pagesVisited: [{ path: '/contact', status: 200 }],
        pagesFailed: [],
        signals: [],
      }),
      ...overrides,
    },
  };
}

const BASE_INPUT = {
  siren: '123456789',
  beneficiaryId: 'oseys-test',
  firstName: 'Jean',
  lastName: 'Dupont',
  companyName: 'Acme SAS',
  trancheEffectif: '12',
};

// ─── Validation ────────────────────────────────────────────────────────────

test('orchestrateur — SIREN invalide → error', async () => {
  const r = await leadExhauster({ siren: 'abc', beneficiaryId: 'x' });
  assert.equal(r.status, 'error');
  assert.ok(r.signals.includes('invalid_siren'));
});

test('orchestrateur — beneficiaryId manquant → error', async () => {
  const r = await leadExhauster({ siren: '123456789' });
  assert.equal(r.status, 'error');
  assert.ok(r.signals.includes('missing_beneficiary_id'));
});

// ─── Cache hit ─────────────────────────────────────────────────────────────

test('orchestrateur — cache hit récent → retour immédiat source=cache', async () => {
  const { adapters } = makeAdapters({
    readLeadContact: async () => ({
      email: 'jean.dupont@acme.fr',
      confidence: 0.88,
      source: 'internal_patterns',
      firstName: 'jean',
      lastName: 'dupont',
      role: 'CEO',
      roleSource: 'insee',
      roleConfidence: 0.85,
      domain: 'acme.fr',
      lastVerifiedAt: new Date().toISOString(),
    }),
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'cache');
  assert.equal(r.cached, true);
  assert.equal(r.email, 'jean.dupont@acme.fr');
});

test('orchestrateur — cache expiré (>90j) → re-résolution', async () => {
  const oldDate = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  const { adapters, calls } = makeAdapters({
    readLeadContact: async () => ({
      email: 'jean.dupont@acme.fr',
      confidence: 0.88,
      source: 'internal_patterns',
      firstName: 'jean',
      lastName: 'dupont',
      domain: 'acme.fr',
      lastVerifiedAt: oldDate,
    }),
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.cached, false);
  assert.equal(r.status, 'ok');
  // trace doit être appelée
  assert.equal(calls.trace.length, 1);
});

// ─── Pipeline complet ──────────────────────────────────────────────────────

test('orchestrateur — domaine + INSEE + scraping confirm → ok internal_patterns', async () => {
  const { adapters, calls } = makeAdapters();
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.equal(r.source, 'internal_patterns');
  assert.ok(r.confidence >= 0.88);
  assert.equal(r.resolvedDomain, 'acme.fr');
  assert.equal(r.resolvedDecisionMaker.firstName, 'Jean');
  // trace écrit avec le vrai email
  assert.equal(calls.trace.length, 1);
  assert.equal(calls.trace[0].email, 'jean.dupont@acme.fr');
});

test('orchestrateur — domaine non résolu → unresolvable', async () => {
  const { adapters } = makeAdapters({
    resolveDomain: async () => ({ domain: null, confidence: 0, source: 'none', signals: ['no_results'], elapsedMs: 5 }),
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'unresolvable');
  assert.equal(r.email, null);
  assert.equal(r.resolvedDomain, null);
  assert.ok(r.signals.some((s) => s.includes('domain_unresolved')));
});

test('orchestrateur — domaine OK mais rien scrapé → unresolvable (pas d invention)', async () => {
  const { adapters } = makeAdapters({
    scrapeDomain: async () => ({
      emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [],
    }),
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'unresolvable');
  assert.equal(r.email, null);
  assert.equal(r.resolvedDomain, 'acme.fr');
  // Le décideur est quand même renseigné depuis INSEE
  assert.ok(r.resolvedDecisionMaker);
  assert.equal(r.resolvedDecisionMaker.firstName, 'Jean');
});

test('orchestrateur — INSEE absent + scraping donne décideur → rebascule sur scrapé', async () => {
  const { adapters } = makeAdapters({
    scrapeDomain: async () => ({
      emails: [{ email: 'marie.martin@acme.fr', confidence: 0.80, sources: ['scraping:/equipe'] }],
      teamProfiles: [
        { firstName: 'Marie', lastName: 'Martin', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9, foundOn: '/equipe' },
      ],
      pagesVisited: [{ path: '/equipe', status: 200 }],
      pagesFailed: [], signals: [],
    }),
  });
  const r = await leadExhauster(
    { siren: '123456789', beneficiaryId: 'oseys-test', companyName: 'Acme', trancheEffectif: '22' },
    { adapters },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.resolvedDecisionMaker.firstName, 'Marie');
  assert.equal(r.resolvedDecisionMaker.source, 'website');
});

// ─── Cascade Dropcontact (stub Jalon 2) ────────────────────────────────────

test('orchestrateur — dropcontact désactivé → signal cascade.skipped', async () => {
  const { adapters } = makeAdapters({
    scrapeDomain: async () => ({
      emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [],
    }),
    dropcontact: { name: 'dropcontact', enabled: false, resolve: async () => ({ email: null, confidence: 0, cost_cents: 0, providerRaw: {} }) },
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'unresolvable');
  assert.ok(r.signals.includes('cascade.skipped_dropcontact_off'));
});

test('orchestrateur — dropcontact activé avec hit → ok dropcontact', async () => {
  const { adapters } = makeAdapters({
    scrapeDomain: async () => ({
      emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [],
    }),
    dropcontact: {
      name: 'dropcontact',
      enabled: true,
      resolve: async () => ({
        email: 'jean.dupont@acme.fr',
        confidence: 0.95,
        cost_cents: 8,
        providerRaw: { qualification: 'nominative' },
      }),
    },
  });
  const r = await leadExhauster(BASE_INPUT, { adapters });
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.equal(r.source, 'dropcontact');
  assert.equal(r.cost_cents, 8);
});

test('orchestrateur — simulated=true → skip dropcontact', async () => {
  const { adapters } = makeAdapters({
    scrapeDomain: async () => ({
      emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [],
    }),
    dropcontact: {
      name: 'dropcontact',
      enabled: true,
      resolve: async () => { throw new Error('ne devrait pas être appelé'); },
    },
  });
  const r = await leadExhauster({ ...BASE_INPUT, simulated: true }, { adapters });
  assert.equal(r.simulated, true);
  assert.ok(r.signals.includes('cascade.skipped_simulated'));
});

// ─── experimentsContext tagging ────────────────────────────────────────────

test('orchestrateur — experimentsContext → experimentsApplied propagé', async () => {
  const { adapters, calls } = makeAdapters();
  const r = await leadExhauster(
    {
      ...BASE_INPUT,
      experimentsContext: {
        applied: [
          { experiment_id: 'enrichment_method', variant: 'with_cascade', type: 'lead_enrichment' },
        ],
      },
    },
    { adapters },
  );
  assert.deepEqual(r.experimentsApplied, ['enrichment_method:with_cascade']);
  // Et dans la trace (l'orchestrateur passe l'array au writer, le writer
  // trace.js fait le JSON.stringify côté persistance Azure)
  assert.ok(Array.isArray(calls.trace[0].experimentsApplied));
  assert.equal(calls.trace[0].experimentsApplied.length, 1);
  assert.equal(calls.trace[0].experimentsApplied[0], 'enrichment_method:with_cascade');
});

// ─── reportFeedback ────────────────────────────────────────────────────────

test('reportFeedback — swallow erreurs', async () => {
  // updateFeedback pas appelé sans AzureWebJobsStorage → retourne false
  const r = await reportFeedback({ siren: '123456789', status: 'delivered', firstName: 'Jean', lastName: 'Dupont' });
  assert.equal(typeof r, 'boolean');
});

test('leadExhauster.reportFeedback est exposé au même niveau', () => {
  assert.equal(typeof leadExhauster.reportFeedback, 'function');
});
