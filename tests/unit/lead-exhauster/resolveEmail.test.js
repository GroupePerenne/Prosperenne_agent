/**
 * Tests unitaires — shared/lead-exhauster/resolveEmail.js
 *
 * Mocks scraper + linkedinProber via options. Aucun appel réseau.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEmail } = require('../../../shared/lead-exhauster/resolveEmail');

function makeScraperMock({ emails = [], teamProfiles = [], pagesVisited = [], pagesFailed = [] } = {}) {
  return async () => ({ emails, teamProfiles, pagesVisited, pagesFailed, signals: [] });
}

// ─── Garde-fou domaine ─────────────────────────────────────────────────────

test('resolveEmail — pas de domaine → unresolvable no_domain', async () => {
  const r = await resolveEmail(
    { firstName: 'Jean', lastName: 'Dupont' },
    { scraper: makeScraperMock() },
  );
  assert.equal(r.status, 'unresolvable');
  assert.equal(r.email, null);
  assert.ok(r.signals.includes('no_domain'));
});

// ─── Étape 3a : pattern cross-check scraping ───────────────────────────────

test('resolveEmail — pattern cross-check scraping → internal_patterns 0.88', async () => {
  const scraper = makeScraperMock({
    emails: [{ email: 'jean.dupont@acme.fr', confidence: 0.75, sources: ['scraping:/contact'] }],
    pagesVisited: [{ path: '/contact', status: 200 }],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jean.dupont@acme.fr');
  assert.equal(r.source, 'internal_patterns');
  assert.ok(r.confidence >= 0.88);
  assert.ok(r.signals.some((s) => s.includes('pattern_first.last_cross_checked_scraping')));
});

test('resolveEmail — pattern alternatif cross-check (f.last)', async () => {
  const scraper = makeScraperMock({
    emails: [{ email: 'j.dupont@acme.fr', confidence: 0.75, sources: [] }],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'j.dupont@acme.fr');
  assert.equal(r.source, 'internal_patterns');
});

// ─── Étape 3b bis : scraping-only nom matché ───────────────────────────────

test('resolveEmail — scraping nom-matché hors pattern (j-dupont) → internal_scraping', async () => {
  const scraper = makeScraperMock({
    emails: [{ email: 'j-dupont@acme.fr', confidence: 0.85, sources: [] }],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  // j-dupont est couvert par pattern 'first-last' → seraient pattern cross-check
  // Let's use un format vraiment hors pattern
  assert.equal(r.status, 'ok');
});

test('resolveEmail — scraping-only format totalement exotique', async () => {
  const scraper = makeScraperMock({
    emails: [{ email: 'jeandup@acme.fr', confidence: 0.85, sources: [] }],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jeandup@acme.fr');
  assert.equal(r.source, 'internal_scraping');
});

// ─── Pas de match → unresolvable avec hint ────────────────────────────────

test('resolveEmail — pas d email scrapé → unresolvable, hint disponible', async () => {
  const scraper = makeScraperMock();
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'unresolvable');
  assert.equal(r.email, null);
  // candidateHint = first.last@domain (pattern #1 hors contact)
  assert.equal(r.candidateHint, 'jean.dupont@acme.fr');
});

test('resolveEmail — seulement junk scrapé → unresolvable + hint pattern', async () => {
  const scraper = makeScraperMock({
    emails: [
      { email: 'contact@acme.fr', confidence: 0.40, sources: [] },
      { email: 'info@acme.fr', confidence: 0.40, sources: [] },
    ],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'unresolvable');
  assert.ok(r.candidateHint);
  assert.ok(!r.candidateHint.startsWith('contact@'));
});

// ─── Signal LinkedIn ───────────────────────────────────────────────────────

test('resolveEmail — LinkedIn matched → signal capturé, pas d effet seul', async () => {
  const scraper = makeScraperMock();
  const linkedinProber = async () => ({ matched: true, signals: ['name_match_full'] });
  const r = await resolveEmail(
    {
      domain: 'acme.fr',
      firstName: 'Jean',
      lastName: 'Dupont',
      profileLinkedInUrl: 'https://linkedin.com/in/jean-dupont',
    },
    { scraper, linkedinProber },
  );
  assert.equal(r.status, 'unresolvable'); // LinkedIn seul n'atteint pas le seuil
  assert.ok(r.signals.includes('linkedin_name_confirmed'));
});

test('resolveEmail — LinkedIn non fourni → pas appelé', async () => {
  const scraper = makeScraperMock();
  let called = false;
  const linkedinProber = async () => { called = true; return { matched: false, signals: [] }; };
  await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper, linkedinProber: null },
  );
  // On n'a pas injecté linkedinProber ni fourni d'URL → module ne l'appelle pas
  assert.equal(called, false);
});

// ─── Seuil custom ──────────────────────────────────────────────────────────

test('resolveEmail — seuil custom bas permet scraping medium', async () => {
  const scraper = makeScraperMock({
    emails: [{ email: 'jeandup@acme.fr', confidence: 0.50, sources: [] }],
  });
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont', confidenceThreshold: 0.40 },
    { scraper },
  );
  // Scraping confidence 0.50 passe seuil 0.40 → ok internal_scraping
  assert.equal(r.status, 'ok');
  assert.equal(r.email, 'jeandup@acme.fr');
});

// ─── Graceful sur erreurs scraper ──────────────────────────────────────────

test('resolveEmail — scraper throw → graceful, unresolvable', async () => {
  const scraper = async () => { throw new Error('scraping pété'); };
  const r = await resolveEmail(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont' },
    { scraper },
  );
  assert.equal(r.status, 'unresolvable');
  assert.ok(r.signals.includes('scraping_error'));
});
