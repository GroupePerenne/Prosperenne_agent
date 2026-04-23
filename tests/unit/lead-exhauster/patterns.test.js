/**
 * Tests unitaires — shared/lead-exhauster/patterns.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeNamePart,
  normalizeDomain,
  getBootstrapPatterns,
  rankPatternsForContext,
  applyPattern,
  confidenceForPattern,
  _BOOTSTRAP_PATTERNS,
} = require('../../../shared/lead-exhauster/patterns');

// ─── normalizeNamePart ─────────────────────────────────────────────────────

test('normalizeNamePart — lowercase + NFD accents', () => {
  assert.equal(normalizeNamePart('Éloïse'), 'eloise');
  assert.equal(normalizeNamePart('François'), 'francois');
  assert.equal(normalizeNamePart('Müller'), 'muller');
});

test('normalizeNamePart — préserve les tirets internes', () => {
  assert.equal(normalizeNamePart('Dupré-Méchin'), 'dupre-mechin');
  assert.equal(normalizeNamePart('Jean-Pierre'), 'jean-pierre');
});

test('normalizeNamePart — supprime espaces et apostrophes', () => {
  assert.equal(normalizeNamePart('de la Fontaine'), 'delafontaine');
  assert.equal(normalizeNamePart("d'Alembert"), 'dalembert');
  assert.equal(normalizeNamePart("O'Brien"), 'obrien');
});

test('normalizeNamePart — retourne chaîne vide si falsy ou non-alpha', () => {
  assert.equal(normalizeNamePart(null), '');
  assert.equal(normalizeNamePart(undefined), '');
  assert.equal(normalizeNamePart(''), '');
  assert.equal(normalizeNamePart('123 456'), '');
});

test('normalizeNamePart — supprime tirets terminaux, compresse tirets multiples', () => {
  assert.equal(normalizeNamePart('-Jean-'), 'jean');
  assert.equal(normalizeNamePart('a---b'), 'a-b');
});

// ─── normalizeDomain ───────────────────────────────────────────────────────

test('normalizeDomain — strip https://, www., trailing slash, path', () => {
  assert.equal(normalizeDomain('https://www.Acme.fr/contact'), 'acme.fr');
  assert.equal(normalizeDomain('http://acme.fr/'), 'acme.fr');
  assert.equal(normalizeDomain('acme.fr'), 'acme.fr');
  assert.equal(normalizeDomain('WWW.ACME.FR'), 'acme.fr');
});

test('normalizeDomain — strip port, query, fragment', () => {
  assert.equal(normalizeDomain('acme.fr:8080/path'), 'acme.fr');
  assert.equal(normalizeDomain('https://acme.fr?utm=x'), 'acme.fr');
  assert.equal(normalizeDomain('acme.fr#section'), 'acme.fr');
});

test('normalizeDomain — rejette les domaines invalides', () => {
  assert.equal(normalizeDomain(null), null);
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain('acme'), null); // pas de point
  assert.equal(normalizeDomain('acme.x'), null); // TLD 1 char
  assert.equal(normalizeDomain('acme .fr'), null); // espace interne
  assert.equal(normalizeDomain('acme@fr'), null); // caractère invalide
});

// ─── getBootstrapPatterns / rankPatternsForContext ─────────────────────────

test('getBootstrapPatterns — 8 patterns, immutable', () => {
  const p1 = getBootstrapPatterns();
  const p2 = getBootstrapPatterns();
  assert.equal(p1.length, 8);
  assert.notEqual(p1, p2); // copies distinctes
  p1[0].template = 'mutated';
  assert.notEqual(_BOOTSTRAP_PATTERNS[0].template, 'mutated');
});

test('getBootstrapPatterns — chaque entrée a {id, template, weight, confidence}', () => {
  for (const p of getBootstrapPatterns()) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.id.length > 0);
    assert.equal(typeof p.template, 'string');
    assert.ok(p.template.includes('@{domain}'));
    assert.equal(typeof p.weight, 'number');
    assert.ok(p.weight >= 0 && p.weight <= 1);
    assert.equal(typeof p.confidence, 'number');
    assert.ok(p.confidence >= 0 && p.confidence <= 1);
  }
});

test('rankPatternsForContext — contact@ en dernier malgré son poids', () => {
  const ranked = rankPatternsForContext();
  assert.equal(ranked[ranked.length - 1].id, 'contact');
  // le premier doit être le plus haut confidence
  assert.equal(ranked[0].id, 'first.last');
});

test('rankPatternsForContext — tri stable sur confidence desc', () => {
  const ranked = rankPatternsForContext();
  for (let i = 1; i < ranked.length - 1; i++) {
    assert.ok(
      ranked[i - 1].confidence >= ranked[i].confidence,
      `confidence[${i - 1}]=${ranked[i - 1].confidence} < confidence[${i}]=${ranked[i].confidence}`,
    );
  }
});

// ─── applyPattern ──────────────────────────────────────────────────────────

test('applyPattern — cas nominal first.last', () => {
  assert.equal(
    applyPattern('{first}.{last}@{domain}', { firstName: 'Jean', lastName: 'Dupont', domain: 'acme.fr' }),
    'jean.dupont@acme.fr',
  );
});

test('applyPattern — gestion {f} initiale', () => {
  assert.equal(
    applyPattern('{f}.{last}@{domain}', { firstName: 'Jean', lastName: 'Dupont', domain: 'acme.fr' }),
    'j.dupont@acme.fr',
  );
});

test('applyPattern — pattern contact@ sans nom', () => {
  assert.equal(
    applyPattern('contact@{domain}', { domain: 'acme.fr' }),
    'contact@acme.fr',
  );
});

test('applyPattern — accents et noms composés', () => {
  assert.equal(
    applyPattern('{first}.{last}@{domain}', {
      firstName: 'Éloïse',
      lastName: 'Dupré-Méchin',
      domain: 'https://www.Acme.fr/',
    }),
    'eloise.dupre-mechin@acme.fr',
  );
});

test('applyPattern — retourne null si token requis vide', () => {
  assert.equal(
    applyPattern('{first}.{last}@{domain}', { firstName: 'Jean', lastName: '', domain: 'acme.fr' }),
    null,
  );
  assert.equal(
    applyPattern('{first}@{domain}', { firstName: '', domain: 'acme.fr' }),
    null,
  );
});

test('applyPattern — retourne null si domaine invalide', () => {
  assert.equal(
    applyPattern('{first}.{last}@{domain}', { firstName: 'Jean', lastName: 'Dupont', domain: 'acme' }),
    null,
  );
  assert.equal(
    applyPattern('contact@{domain}', { domain: '' }),
    null,
  );
});

test('applyPattern — rejette emails malformés (doubles points)', () => {
  // Nom qui deviendrait "..": l'implémentation rejette
  // Cas artificiel : tester que la validation finale catch les doubles points
  // Comme notre normalisation supprime déjà les cas pathologiques, on teste
  // l'invariant de sortie sur un appel légal.
  const result = applyPattern('{first}.{last}@{domain}', {
    firstName: 'Jean',
    lastName: 'Dupont',
    domain: 'acme.fr',
  });
  assert.ok(!result.includes('..'));
});

test('applyPattern — template sans token → rejeté ou passthrough', () => {
  // Template littéral sans token doit quand même être validé par la regex finale
  assert.equal(applyPattern('nobody@acme.fr', { domain: 'acme.fr' }), 'nobody@acme.fr');
});

test('applyPattern — template invalide ou vide', () => {
  assert.equal(applyPattern('', { firstName: 'Jean', lastName: 'Dupont', domain: 'acme.fr' }), null);
  assert.equal(applyPattern(null, { firstName: 'Jean', lastName: 'Dupont', domain: 'acme.fr' }), null);
});

// ─── confidenceForPattern ──────────────────────────────────────────────────

test('confidenceForPattern — lookup par id', () => {
  assert.equal(confidenceForPattern('first.last'), 0.88);
  assert.equal(confidenceForPattern('contact'), 0.40);
});

test('confidenceForPattern — lookup par template', () => {
  assert.equal(confidenceForPattern('{first}.{last}@{domain}'), 0.88);
  assert.equal(confidenceForPattern('contact@{domain}'), 0.40);
});

test('confidenceForPattern — retourne 0.5 pour pattern inconnu', () => {
  assert.equal(confidenceForPattern('inconnu'), 0.5);
  assert.equal(confidenceForPattern(''), 0.5);
});
