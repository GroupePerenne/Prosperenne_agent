'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGGREGATOR_DOMAINS,
  extractHost,
  isAggregator,
} = require('../../../shared/site-finder/aggregators');

// ──────────────── extractHost ────────────────

test('extractHost — URL complète https://www.acme.fr/path', () => {
  assert.equal(extractHost('https://www.acme.fr/path'), 'acme.fr');
});

test('extractHost — domaine bare avec www', () => {
  assert.equal(extractHost('www.acme.fr'), 'acme.fr');
});

test('extractHost — domaine bare sans www', () => {
  assert.equal(extractHost('acme.fr'), 'acme.fr');
});

test('extractHost — domaine avec path sans schéma', () => {
  assert.equal(extractHost('acme.fr/path/sub'), 'acme.fr');
});

test('extractHost — chaîne vide ou nulle', () => {
  assert.equal(extractHost(''), null);
  assert.equal(extractHost(null), null);
  assert.equal(extractHost(undefined), null);
});

test('extractHost — chaîne sans point n\'est pas un domaine', () => {
  assert.equal(extractHost('not-a-domain'), null);
});

// ──────────────── isAggregator ────────────────

test('isAggregator — annuaires observés en prod', () => {
  assert.equal(isAggregator('https://rubypayeur.com/societe/abc-123'), true);
  assert.equal(isAggregator('https://datalegal.fr/entreprises/123456789'), true);
  assert.equal(isAggregator('https://batiment.e-pro.fr/eure/societe-x'), true);
  assert.equal(isAggregator('https://prosmaison.fr/entreprise-12345'), true);
});

test('isAggregator — annuaires généralistes existants', () => {
  assert.equal(isAggregator('https://www.societe.com/societe/x'), true);
  assert.equal(isAggregator('https://www.pagesjaunes.fr/'), true);
  assert.equal(isAggregator('https://www.kompass.com/c/abc'), true);
});

test('isAggregator — vrai site entreprise FR retourne false', () => {
  assert.equal(isAggregator('https://acecam.fr'), false);
  assert.equal(isAggregator('https://chevalier-environnement-ozan.fr'), false);
  assert.equal(isAggregator('https://plomberie-chauffage-lancia.fr'), false);
  assert.equal(isAggregator('https://seteam-electricite.fr'), false);
});

test('isAggregator — match sous-domaine d\'agrégateur', () => {
  assert.equal(isAggregator('https://blog.linkedin.com/post'), true);
  assert.equal(isAggregator('https://news.facebook.com/x'), true);
});

test('isAggregator — domaine bare sans schéma', () => {
  assert.equal(isAggregator('rubypayeur.com'), true);
  assert.equal(isAggregator('acme.fr'), false);
});

test('isAggregator — input invalide retourne false', () => {
  assert.equal(isAggregator(''), false);
  assert.equal(isAggregator(null), false);
  assert.equal(isAggregator(undefined), false);
  assert.equal(isAggregator(42), false);
});

test('AGGREGATOR_DOMAINS contient les annuaires critiques observés', () => {
  // Garde-fou contre suppression accidentelle des annuaires observés
  // en prod 5 mai 2026 PM (R-J6 strict, ces ajouts sont sourcés).
  assert.ok(AGGREGATOR_DOMAINS.has('rubypayeur.com'));
  assert.ok(AGGREGATOR_DOMAINS.has('datalegal.fr'));
  assert.ok(AGGREGATOR_DOMAINS.has('e-pro.fr'));
  assert.ok(AGGREGATOR_DOMAINS.has('prosmaison.fr'));
});
