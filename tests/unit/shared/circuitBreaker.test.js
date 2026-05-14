'use strict';

/**
 * Tests unitaires — shared/circuitBreaker.js (plan v3.1 P3 Task #14).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  withBreaker,
  CircuitOpenError,
  getState,
  STATES,
  _resetForTests,
} = require('../../../shared/circuitBreaker');

test.beforeEach(() => { _resetForTests(); });

test('withBreaker — success → state closed, failCount 0', async () => {
  const r = await withBreaker('test-ok', async () => 42);
  assert.equal(r, 42);
  const s = getState('test-ok');
  assert.equal(s.state, STATES.CLOSED);
  assert.equal(s.failCount, 0);
});

test('withBreaker — 1 échec → failCount=1, state encore closed', async () => {
  try {
    await withBreaker('test-1fail', async () => { throw new Error('boom'); });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.message, 'boom');
  }
  const s = getState('test-1fail');
  assert.equal(s.state, STATES.CLOSED);
  assert.equal(s.failCount, 1);
});

test('withBreaker — N échecs consécutifs (N=threshold) → state open', async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await withBreaker('test-open', async () => { throw new Error('boom'); }, { failThreshold: 3 });
    } catch (_) {}
  }
  const s = getState('test-open');
  assert.equal(s.state, STATES.OPEN);
  assert.equal(s.failCount, 3);
  assert.ok(s.openedAt > 0);
});

test('withBreaker — état open → CircuitOpenError sans exécuter asyncFn', async () => {
  // Ouvrir le circuit
  for (let i = 0; i < 3; i++) {
    try { await withBreaker('test-block', async () => { throw new Error('e'); }, { failThreshold: 3 }); } catch (_) {}
  }
  let asyncFnCalled = false;
  try {
    await withBreaker('test-block', async () => {
      asyncFnCalled = true;
      return 99;
    });
    assert.fail('should throw CircuitOpenError');
  } catch (err) {
    assert.ok(err instanceof CircuitOpenError);
    assert.equal(err.code, 'CIRCUIT_OPEN');
    assert.equal(err.skipped, true);
  }
  assert.equal(asyncFnCalled, false);
});

test('withBreaker — succès après échecs (sous threshold) → reset failCount', async () => {
  try { await withBreaker('test-recover', async () => { throw new Error('e'); }, { failThreshold: 5 }); } catch (_) {}
  try { await withBreaker('test-recover', async () => { throw new Error('e'); }, { failThreshold: 5 }); } catch (_) {}
  const r = await withBreaker('test-recover', async () => 'recovered');
  assert.equal(r, 'recovered');
  const s = getState('test-recover');
  assert.equal(s.state, STATES.CLOSED);
  assert.equal(s.failCount, 0);
});

test('withBreaker — après openDurationMs, passe half-open + probe success → closed', async () => {
  for (let i = 0; i < 2; i++) {
    try {
      await withBreaker('test-half', async () => { throw new Error('e'); }, { failThreshold: 2, openDurationMs: 10 });
    } catch (_) {}
  }
  assert.equal(getState('test-half').state, STATES.OPEN);
  await new Promise((res) => setTimeout(res, 15));
  const r = await withBreaker('test-half', async () => 'probe_ok');
  assert.equal(r, 'probe_ok');
  assert.equal(getState('test-half').state, STATES.CLOSED);
});

test('withBreaker — after openDurationMs, probe fail → reopen', async () => {
  for (let i = 0; i < 2; i++) {
    try {
      await withBreaker('test-reopen', async () => { throw new Error('e'); }, { failThreshold: 2, openDurationMs: 10 });
    } catch (_) {}
  }
  await new Promise((res) => setTimeout(res, 15));
  try {
    await withBreaker('test-reopen', async () => { throw new Error('still down'); }, { failThreshold: 2, openDurationMs: 10 });
  } catch (err) {
    assert.equal(err.message, 'still down');
  }
  assert.equal(getState('test-reopen').state, STATES.OPEN);
});

test('withBreaker — shouldCount filter : erreur ignorée ne compte pas', async () => {
  const shouldCount = (err) => err.message !== 'ignored';
  try {
    await withBreaker('test-filter', async () => { throw new Error('ignored'); }, { failThreshold: 2, shouldCount });
  } catch (_) {}
  try {
    await withBreaker('test-filter', async () => { throw new Error('ignored'); }, { failThreshold: 2, shouldCount });
  } catch (_) {}
  const s = getState('test-filter');
  assert.equal(s.failCount, 0); // shouldCount filtre
  assert.equal(s.state, STATES.CLOSED);
});

test('withBreaker — circuits indépendants par nom', async () => {
  try { await withBreaker('a', async () => { throw new Error('e'); }, { failThreshold: 1 }); } catch (_) {}
  assert.equal(getState('a').state, STATES.OPEN);
  assert.equal(getState('b').state, STATES.CLOSED);
});

test('CircuitOpenError — propriétés exposées (name, ISO timestamps)', async () => {
  for (let i = 0; i < 1; i++) {
    try {
      await withBreaker('iso-test', async () => { throw new Error('e'); }, { failThreshold: 1, openDurationMs: 60000 });
    } catch (_) {}
  }
  try {
    await withBreaker('iso-test', async () => 'never');
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof CircuitOpenError);
    assert.equal(err.circuitName, 'iso-test');
    assert.match(err.openedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(err.willHalfOpenAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});
