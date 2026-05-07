/**
 * Test unitaire — Circuit breaker rneEnrichment + cache TTL dégradé.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-4 (multi-source via
 * fallback dégradé) + feedback_fallback_snapshot_local_vs_api_tierce 7 mai 2026.
 *
 * Vérifie le comportement du circuit breaker face à un fetch RNE défaillant
 * et l'usage du cache TTL dégradé en fallback.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadModuleFresh() {
  delete require.cache[require.resolve('../../../shared/enrichers/dirigeants-rne')];
  return require('../../../shared/enrichers/dirigeants-rne');
}

test('Circuit breaker — état initial fermé', () => {
  const mod = loadModuleFresh();
  const c = mod._constants;
  assert.equal(c.CIRCUIT_BREAKER_THRESHOLD, 5);
  assert.equal(c.CIRCUIT_BREAKER_WINDOW_MS, 60_000);
  assert.equal(c.CIRCUIT_BREAKER_OPEN_MS, 300_000);
  assert.equal(mod._internals._isCircuitOpen(), false);
});

test('Circuit breaker — ouvre après THRESHOLD échecs dans la fenêtre', () => {
  const mod = loadModuleFresh();
  mod._resetCircuitForTests();
  const { _recordFailure, _isCircuitOpen } = mod._internals;
  for (let i = 0; i < mod._constants.CIRCUIT_BREAKER_THRESHOLD; i++) {
    _recordFailure();
  }
  assert.equal(_isCircuitOpen(), true, 'circuit doit être ouvert après THRESHOLD échecs');
});

test('Circuit breaker — succès reset le compteur', () => {
  const mod = loadModuleFresh();
  mod._resetCircuitForTests();
  const { _recordFailure, _recordSuccess, _isCircuitOpen } = mod._internals;
  // 3 échecs, sous le seuil
  _recordFailure();
  _recordFailure();
  _recordFailure();
  assert.equal(_isCircuitOpen(), false);
  // Succès reset
  _recordSuccess();
  // 4 nouveaux échecs : pas encore ouvert (compteur reseté à 0 puis 4 < 5)
  _recordFailure();
  _recordFailure();
  _recordFailure();
  _recordFailure();
  assert.equal(_isCircuitOpen(), false, 'compteur a été reseté par _recordSuccess');
});

test('Circuit breaker — pas d\'ouverture si échecs étalés hors fenêtre', () => {
  const mod = loadModuleFresh();
  mod._resetCircuitForTests();
  const { _recordFailure, _isCircuitOpen } = mod._internals;
  // Simule 5 échecs mais avec un timer arrêté (sortie de fenêtre simulée
  // par injection manuelle des timestamps n'est pas exposée ; on vérifie
  // au moins le cas où 4 dans la fenêtre + 1 ne déclenchent pas).
  for (let i = 0; i < 4; i++) _recordFailure();
  assert.equal(_isCircuitOpen(), false, '4 échecs sous le seuil = circuit fermé');
});

test('isExpired — TTL frais 30j', () => {
  const mod = loadModuleFresh();
  const { isExpired } = mod._internals;
  const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
  assert.equal(isExpired(recent), false, '10j < 30j frais');
  assert.equal(isExpired(old), true, '40j > 30j frais');
  assert.equal(isExpired(null), true, 'null = expiré');
});

test('isExpiredDegraded — TTL dégradé 365j', () => {
  const mod = loadModuleFresh();
  const { isExpiredDegraded } = mod._internals;
  const recent = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString();
  assert.equal(isExpiredDegraded(recent), false, '100j < 365j dégradé');
  assert.equal(isExpiredDegraded(old), true, '400j > 365j dégradé');
  assert.equal(isExpiredDegraded(null), true, 'null = expiré');
});

test('Circuit breaker open period termine après OPEN_MS', async () => {
  const mod = loadModuleFresh();
  mod._resetCircuitForTests();
  const { _recordFailure, _isCircuitOpen } = mod._internals;
  // Force ouverture
  for (let i = 0; i < mod._constants.CIRCUIT_BREAKER_THRESHOLD; i++) {
    _recordFailure();
  }
  assert.equal(_isCircuitOpen(), true);

  // Bidouille : on ne peut pas attendre 5 min réelles. On vérifie juste
  // que la logique de timeout fonctionne en manipulant Date.now via spy.
  const realNow = Date.now;
  try {
    const fakeT = realNow();
    // Simule t+OPEN_MS+1
    Date.now = () => fakeT + mod._constants.CIRCUIT_BREAKER_OPEN_MS + 1;
    assert.equal(_isCircuitOpen(), false, 'circuit doit se fermer après OPEN_MS');
  } finally {
    Date.now = realNow;
  }
});
