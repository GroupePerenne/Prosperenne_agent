/**
 * Tests unitaires — shared/lead-exhauster/linkedin.js
 *
 * Module volontairement conservateur (ToS LinkedIn strict). V1 = signal
 * faible de confirmation nom, pas d'extraction email.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  probeLinkedIn,
  isLinkedInUrl,
  extractProfileSlug,
} = require('../../../shared/lead-exhauster/linkedin');

// ─── isLinkedInUrl ─────────────────────────────────────────────────────────

test('isLinkedInUrl — accepte tous les sous-domaines linkedin', () => {
  assert.equal(isLinkedInUrl('https://www.linkedin.com/in/jean-dupont'), true);
  assert.equal(isLinkedInUrl('https://fr.linkedin.com/in/jean-dupont'), true);
  assert.equal(isLinkedInUrl('https://linkedin.com/company/acme'), true);
});

test('isLinkedInUrl — rejette domaines tiers', () => {
  assert.equal(isLinkedInUrl('https://acme.fr'), false);
  assert.equal(isLinkedInUrl('https://fake-linkedin.com/in/x'), false);
  assert.equal(isLinkedInUrl('not a url'), false);
  assert.equal(isLinkedInUrl(null), false);
  assert.equal(isLinkedInUrl(''), false);
});

// ─── extractProfileSlug ───────────────────────────────────────────────────

test('extractProfileSlug — extraction correcte', () => {
  assert.equal(extractProfileSlug('https://www.linkedin.com/in/jean-dupont/'), 'jean-dupont');
  assert.equal(extractProfileSlug('https://fr.linkedin.com/in/JeanDupont?ref=x'), 'jeandupont');
});

test('extractProfileSlug — URL non profil retourne null', () => {
  assert.equal(extractProfileSlug('https://www.linkedin.com/company/acme'), null);
  assert.equal(extractProfileSlug('https://acme.fr'), null);
});

// ─── probeLinkedIn ─────────────────────────────────────────────────────────

test('probeLinkedIn — pas d URL LinkedIn → signal no_linkedin_url', async () => {
  const r = await probeLinkedIn({ firstName: 'Jean', lastName: 'Dupont' });
  assert.equal(r.matched, false);
  assert.ok(r.signals.includes('no_linkedin_url'));
});

test('probeLinkedIn — URL non-linkedin → no_linkedin_url', async () => {
  const r = await probeLinkedIn({ profileLinkedInUrl: 'https://acme.fr' });
  assert.equal(r.matched, false);
  assert.ok(r.signals.includes('no_linkedin_url'));
});

test('probeLinkedIn — HTML contient nom complet → matched', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '<html><body><h1>Jean Dupont</h1><p>CEO chez Acme</p></body></html>',
  });
  const r = await probeLinkedIn(
    { profileLinkedInUrl: 'https://www.linkedin.com/in/jean-dupont', firstName: 'Jean', lastName: 'Dupont' },
    { fetchImpl },
  );
  assert.equal(r.matched, true);
  assert.ok(r.signals.includes('name_match_full'));
  assert.equal(r.profileSlug, 'jean-dupont');
});

test('probeLinkedIn — détecte wall login', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '<html>Sign in to LinkedIn to see more</html>',
  });
  const r = await probeLinkedIn(
    { profileLinkedInUrl: 'https://linkedin.com/in/xxx', firstName: 'Jean', lastName: 'Dupont' },
    { fetchImpl },
  );
  assert.ok(r.signals.some((s) => s.includes('auth_wall')));
});

test('probeLinkedIn — network error → graceful', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await probeLinkedIn(
    { profileLinkedInUrl: 'https://linkedin.com/in/xxx', firstName: 'Jean', lastName: 'Dupont' },
    { fetchImpl },
  );
  assert.equal(r.matched, false);
  assert.ok(r.signals.includes('network_error'));
});

test('probeLinkedIn — HTTP non-2xx → http_XXX signal', async () => {
  const fetchImpl = async () => ({ ok: false, status: 999 });
  const r = await probeLinkedIn(
    { profileLinkedInUrl: 'https://linkedin.com/in/xxx', firstName: 'Jean', lastName: 'Dupont' },
    { fetchImpl },
  );
  assert.equal(r.matched, false);
  assert.ok(r.signals.some((s) => s.startsWith('http_')));
});

test('probeLinkedIn — indice rôle détecté', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    text: async () => '<html>Jean Dupont - CEO founder at Acme</html>',
  });
  const r = await probeLinkedIn(
    { profileLinkedInUrl: 'https://linkedin.com/in/xxx', firstName: 'Jean', lastName: 'Dupont' },
    { fetchImpl },
  );
  assert.ok(r.roleHint);
  assert.ok(['ceo', 'founder'].includes(r.roleHint));
});
