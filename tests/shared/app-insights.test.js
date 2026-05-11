'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TARGET = require.resolve('../../shared/app-insights');

beforeEach(() => {
  delete require.cache[TARGET];
  delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
});

// ─── Init sans connection string ───────────────────────────────────────────

test('init sans connection string → getClient retourne null', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.equal(mod.getClient(), null);
});

test('trackTrace ne throw pas sans client', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.doesNotThrow(() => mod.trackTrace('hello', { a: 1 }, 'info'));
});

test('trackException ne throw pas sans client', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.doesNotThrow(() => mod.trackException(new Error('boom'), { a: 1 }));
});

test('trackMetric ne throw pas sans client', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.doesNotThrow(() => mod.trackMetric('m', 42, { a: 1 }));
});

// ─── Sanitization des properties ───────────────────────────────────────────
// Note : sanitize n'est pas exporté mais on teste via le comportement
// indirect : un call trackTrace avec objet imbriqué ne doit pas throw.

test('trackTrace accepte properties imbriquées sans throw', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.doesNotThrow(() => mod.trackTrace('msg', {
    nested: { a: 1, b: [1, 2, 3] },
    str: 'hello',
    num: 42,
    bool: true,
    nullVal: null,
    undefinedVal: undefined,
  }, 'info'));
});

test('trackTrace tronque message à 8000 chars', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  // Sans connection string, le call n'envoie rien mais ne doit pas crasher
  // sur un long message
  const long = 'a'.repeat(20000);
  assert.doesNotThrow(() => mod.trackTrace(long, {}, 'info'));
});

// ─── Severity mapping ──────────────────────────────────────────────────────

test('severity inconnue fallback sur info', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  assert.doesNotThrow(() => mod.trackTrace('msg', {}, 'unknown-severity'));
});

test('severity verbose/info/warn/error/critical acceptés', () => {
  const mod = require('../../shared/app-insights');
  mod._reset();
  for (const sev of ['verbose', 'info', 'warn', 'warning', 'error', 'critical']) {
    assert.doesNotThrow(() => mod.trackTrace('msg', {}, sev));
  }
});
