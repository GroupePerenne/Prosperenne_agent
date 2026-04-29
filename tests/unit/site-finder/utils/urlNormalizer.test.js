'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalize, extractHost } = require('../../../../shared/site-finder/utils/urlNormalizer');

// ─── normalize ─────────────────────────────────────────────────────────────

test('normalize — strip http://, www., trailing slash, force https', () => {
  assert.equal(normalize('http://www.acme.fr/'), 'https://acme.fr');
  assert.equal(normalize('https://www.Acme.FR'), 'https://acme.fr');
  assert.equal(normalize('www.acme.fr'), 'https://acme.fr');
  assert.equal(normalize('acme.fr'), 'https://acme.fr');
});

test('normalize — préserve les paths non-vides', () => {
  assert.equal(normalize('https://acme.fr/about'), 'https://acme.fr/about');
  assert.equal(normalize('https://acme.fr/about/'), 'https://acme.fr/about');
});

test('normalize — strip query et fragment', () => {
  assert.equal(normalize('https://acme.fr/path?utm=x'), 'https://acme.fr/path');
  assert.equal(normalize('https://acme.fr/path#section'), 'https://acme.fr/path');
});

test('normalize — idempotente', () => {
  const once = normalize('http://www.Acme.fr/');
  const twice = normalize(once);
  assert.equal(once, twice);
});

test('normalize — rejette entrées invalides', () => {
  assert.equal(normalize(null), null);
  assert.equal(normalize(''), null);
  assert.equal(normalize('   '), null);
  assert.equal(normalize('acme'), null); // pas de point
  assert.equal(normalize('acme.x'), null); // TLD < 2
  assert.equal(normalize('ftp://acme.fr'), null); // scheme non-HTTP
});

test('normalize — rejette URL avec espace dans le host', () => {
  assert.equal(normalize('https://ac me.fr'), null);
});

test('normalize — accepte sous-domaines multiples', () => {
  assert.equal(normalize('https://api.v2.acme.fr/health'), 'https://api.v2.acme.fr/health');
});

// ─── extractHost ───────────────────────────────────────────────────────────

test('extractHost — retourne host lowercase sans www.', () => {
  assert.equal(extractHost('https://www.Acme.fr/about'), 'acme.fr');
  assert.equal(extractHost('http://api.v2.acme.fr'), 'api.v2.acme.fr');
});

test('extractHost — retourne null pour entrée invalide', () => {
  assert.equal(extractHost(null), null);
  assert.equal(extractHost('not a url'), null);
});
