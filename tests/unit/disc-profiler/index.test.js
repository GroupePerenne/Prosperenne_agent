/**
 * Tests — shared/disc-profiler/index.js (API publique)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const disc = require('../../../shared/disc-profiler');

test('exports principaux présents', () => {
  assert.equal(typeof disc.inferDISC, 'function');
  assert.equal(typeof disc.extractSignals, 'function');
  assert.equal(typeof disc.hasEnoughSignalsForInference, 'function');
  assert.equal(typeof disc.shouldAdaptToneToDISC, 'function');
  assert.equal(disc.CONFIDENCE_ADAPT_THRESHOLD, 0.4);
  assert.equal(disc.CONFIDENCE_STRONG_THRESHOLD, 0.7);
});

test('shouldAdaptToneToDISC — false si unknown ou confidence < 0.4', () => {
  assert.equal(disc.shouldAdaptToneToDISC(null), false);
  assert.equal(disc.shouldAdaptToneToDISC({}), false);
  assert.equal(disc.shouldAdaptToneToDISC({ primary: 'unknown', confidence: 0.9 }), false);
  assert.equal(disc.shouldAdaptToneToDISC({ primary: 'D', confidence: 0.39 }), false);
  assert.equal(disc.shouldAdaptToneToDISC({ primary: 'D', confidence: 0.4 }), true);
  assert.equal(disc.shouldAdaptToneToDISC({ primary: 'I', confidence: 0.85 }), true);
});
