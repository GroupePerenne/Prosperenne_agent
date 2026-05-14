'use strict';

/**
 * Tests unitaires — filterCandidatesAlreadyInPipe (leadSelector dedup amont).
 *
 * Cible la racine du dedup non opérant identifiée 14 mai 2026 PM :
 *   - Match par SIREN (immuable, source de vérité)
 *   - Fallback nom normalisé (legacy orgs sans SIREN renseigné)
 *   - Comptage séparé SIREN vs nom pour observabilité
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterCandidatesAlreadyInPipe } = require('../../../shared/leadSelector');

test('dedup amont — candidates vide → fresh vide, compteurs 0', () => {
  const r = filterCandidatesAlreadyInPipe([], { sirens: new Set(), names: new Set() });
  assert.deepEqual(r.fresh, []);
  assert.equal(r.excludedTotal, 0);
  assert.equal(r.excludedBySiren, 0);
  assert.equal(r.excludedByName, 0);
});

test('dedup amont — alreadyInPipe vide → tous candidates passent', () => {
  const candidates = [
    { siren: '123456789', entreprise: 'ACME SA' },
    { siren: '987654321', entreprise: 'BETA SARL' },
  ];
  const r = filterCandidatesAlreadyInPipe(candidates, { sirens: new Set(), names: new Set() });
  assert.equal(r.fresh.length, 2);
  assert.equal(r.excludedTotal, 0);
});

test('dedup amont — match SIREN exclut le candidate, increment excludedBySiren', () => {
  const candidates = [
    { siren: '123456789', entreprise: 'ACME SA' },
    { siren: '987654321', entreprise: 'BETA SARL' },
  ];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(['123456789']),
    names: new Set(),
  });
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].siren, '987654321');
  assert.equal(r.excludedBySiren, 1);
  assert.equal(r.excludedByName, 0);
  assert.equal(r.excludedTotal, 1);
});

test('dedup amont — SIREN candidate type number, alreadyInPipe contient string → match', () => {
  const candidates = [{ siren: 123456789, entreprise: 'ACME SA' }];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(['123456789']),
    names: new Set(),
  });
  assert.equal(r.fresh.length, 0);
  assert.equal(r.excludedBySiren, 1);
});

test('dedup amont — fallback nom normalisé quand pas de SIREN côté candidate', () => {
  const candidates = [
    { entreprise: 'CAPARROS ELECTRICITE' },
    { entreprise: 'AUTRE COMPANY' },
  ];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(),
    names: new Set(['caparros electricite']),
  });
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].entreprise, 'AUTRE COMPANY');
  assert.equal(r.excludedByName, 1);
  assert.equal(r.excludedBySiren, 0);
});

test('dedup amont — match SIREN priorisé sur nom (immuable d\'abord)', () => {
  const candidates = [{ siren: '999999999', entreprise: 'CAPARROS ELECTRICITE' }];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(['999999999']),
    names: new Set(['caparros electricite']),
  });
  assert.equal(r.fresh.length, 0);
  // Match SIREN doit incrémenter excludedBySiren, pas excludedByName
  assert.equal(r.excludedBySiren, 1);
  assert.equal(r.excludedByName, 0);
});

test('dedup amont — candidate sans SIREN ni entreprise → pass-through', () => {
  const candidates = [{ foo: 'bar' }, {}, null];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(['x']),
    names: new Set(['y']),
  });
  assert.equal(r.fresh.length, 3);
  assert.equal(r.excludedTotal, 0);
});

test('dedup amont — argument alreadyInPipe partiel (sirens seul) → fallback ok', () => {
  const candidates = [{ siren: '111', entreprise: 'X' }];
  const r = filterCandidatesAlreadyInPipe(candidates, { sirens: new Set(['111']) });
  assert.equal(r.fresh.length, 0);
  assert.equal(r.excludedBySiren, 1);
});

test('dedup amont — argument alreadyInPipe null/undefined → tous candidates passent', () => {
  const candidates = [{ siren: '111', entreprise: 'X' }];
  const r1 = filterCandidatesAlreadyInPipe(candidates, null);
  assert.equal(r1.fresh.length, 1);
  const r2 = filterCandidatesAlreadyInPipe(candidates);
  assert.equal(r2.fresh.length, 1);
});

test('dedup amont — multi-candidates : 2 exclus (1 SIREN + 1 nom), 1 frais', () => {
  const candidates = [
    { siren: '111', entreprise: 'A' },          // exclu par SIREN
    { entreprise: 'B SAS' },                     // exclu par nom (normalisation lowercase)
    { siren: '222', entreprise: 'C SARL' },     // frais
  ];
  const r = filterCandidatesAlreadyInPipe(candidates, {
    sirens: new Set(['111']),
    names: new Set(['b sas']),
  });
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].siren, '222');
  assert.equal(r.excludedBySiren, 1);
  assert.equal(r.excludedByName, 1);
  assert.equal(r.excludedTotal, 2);
});
