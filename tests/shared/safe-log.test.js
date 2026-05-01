'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeSafeLogger } = require('../../shared/safe-log');

// ─── Helpers ─────────────────────────────────────────────────────────────

function captureConsole(fn) {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const captured = { log: [], warn: [], error: [] };
  console.log = (...args) => captured.log.push(args);
  console.warn = (...args) => captured.warn.push(args);
  console.error = (...args) => captured.error.push(args);
  try {
    fn();
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  return captured;
}

// ─── Tests : context null / undefined ────────────────────────────────────

test('makeSafeLogger ne throw jamais quand context est null', () => {
  const log = makeSafeLogger(null);
  assert.doesNotThrow(() => log('msg'));
  assert.doesNotThrow(() => log.info('msg'));
  assert.doesNotThrow(() => log.warn('msg'));
  assert.doesNotThrow(() => log.error('msg'));
});

test('makeSafeLogger ne throw jamais quand context est undefined', () => {
  const log = makeSafeLogger();
  assert.doesNotThrow(() => log('msg', { detail: 1 }));
  assert.doesNotThrow(() => log.info('msg', { detail: 1 }));
});

// ─── Tests : context Azure Functions v4 (méthodes natives) ───────────────

test('utilise context.info/warn/error si dispo (Azure Functions v4)', () => {
  const calls = { info: [], warn: [], error: [] };
  const context = {
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
  const log = makeSafeLogger(context);
  log('hello');
  log.info('info-msg', { x: 1 });
  log.warn('warn-msg');
  log.error('error-msg', { stack: 'trace' });

  assert.deepEqual(calls.info[0], ['hello']);
  assert.deepEqual(calls.info[1], ['info-msg', { x: 1 }]);
  assert.deepEqual(calls.warn[0], ['warn-msg']);
  assert.deepEqual(calls.error[0], ['error-msg', { stack: 'trace' }]);
});

// ─── Tests : context.log.info / .warn (legacy v3 ou wrapper custom) ──────

test('utilise context.log.info/warn si pas de context.info', () => {
  const calls = { info: [], warn: [] };
  const context = {
    log: {
      info: (...args) => calls.info.push(args),
      warn: (...args) => calls.warn.push(args),
    },
  };
  const log = makeSafeLogger(context);
  log('msg');
  log.warn('warning');

  assert.deepEqual(calls.info[0], ['msg']);
  assert.deepEqual(calls.warn[0], ['warning']);
});

// ─── Tests : context.log callable direct ─────────────────────────────────

test('utilise context.log callable si ni v4 ni .info/.warn', () => {
  const calls = [];
  const context = { log: (...args) => calls.push(args) };
  const log = makeSafeLogger(context);
  log('msg-1');
  log.info('msg-2');

  assert.deepEqual(calls[0], ['msg-1']);
  assert.deepEqual(calls[1], ['msg-2']);
});

// ─── Tests : fallback console si méthode throw (cas BL-45 #privateField) ─

test('fallback console.log si context.info throw (cas #privateField)', () => {
  const context = {
    info: () => { throw new Error('Cannot read private member'); },
  };
  const log = makeSafeLogger(context);

  const captured = captureConsole(() => {
    log('fallback test');
    log.info('explicit info', { foo: 'bar' });
  });

  assert.equal(captured.log.length, 2);
  assert.deepEqual(captured.log[0], ['fallback test']);
  assert.deepEqual(captured.log[1], ['explicit info', { foo: 'bar' }]);
});

test('fallback console.warn si context.warn throw', () => {
  const context = {
    warn: () => { throw new Error('boom'); },
  };
  const log = makeSafeLogger(context);

  const captured = captureConsole(() => {
    log.warn('warn-msg');
  });

  assert.equal(captured.warn.length, 1);
  assert.deepEqual(captured.warn[0], ['warn-msg']);
});

test('fallback console.error si context.error throw', () => {
  const context = {
    error: () => { throw new Error('boom'); },
  };
  const log = makeSafeLogger(context);

  const captured = captureConsole(() => {
    log.error('err-msg', { stack: 's' });
  });

  assert.equal(captured.error.length, 1);
  assert.deepEqual(captured.error[0], ['err-msg', { stack: 's' }]);
});

// ─── Tests : silence absolu si fallback aussi throw ──────────────────────

test('silence absolu si méthode native ET console fallback throw', () => {
  const context = {
    info: () => { throw new Error('native fail'); },
  };
  const log = makeSafeLogger(context);

  // Sabote console.log à l'intérieur du test pour simuler double échec
  const original = console.log;
  console.log = () => { throw new Error('console fail'); };
  try {
    assert.doesNotThrow(() => log('msg'));
  } finally {
    console.log = original;
  }
});

// ─── Tests : alias log() === log.info() ──────────────────────────────────

test('log() est aliasé sur log.info() — compat call sites historiques', () => {
  const calls = [];
  const context = { info: (...args) => calls.push(args) };
  const log = makeSafeLogger(context);

  log('via callable');
  log.info('via method');

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['via callable']);
  assert.deepEqual(calls[1], ['via method']);
});

// ─── Tests : warn fallback sur info si pas de warn ───────────────────────

test('warn dégrade vers info si context n\'a ni warn ni log.warn', () => {
  const calls = { info: [], warn: [] };
  const context = {
    info: (msg) => calls.info.push(msg),
  };
  const log = makeSafeLogger(context);
  log.warn('soft-warn');
  // Dégradation : warn route vers info en absence de warn natif
  assert.deepEqual(calls.info, ['soft-warn']);
});

// ─── Tests : error fallback en cascade error → warn → info ───────────────

test('error dégrade vers warn puis info en cascade', () => {
  const calls = { info: [] };
  const context = {
    info: (msg) => calls.info.push(msg),
  };
  const log = makeSafeLogger(context);
  log.error('soft-error');
  assert.deepEqual(calls.info, ['soft-error']);
});

// ─── Tests : payload optionnel non passé si undefined ────────────────────

test('payload undefined ne casse pas les méthodes bindées arity-strict', () => {
  let lastArgs = null;
  const context = {
    info: (...args) => { lastArgs = args; },
  };
  const log = makeSafeLogger(context);
  log('msg-no-payload');
  assert.equal(lastArgs.length, 1);
  assert.deepEqual(lastArgs, ['msg-no-payload']);
});
