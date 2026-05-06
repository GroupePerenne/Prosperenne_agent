'use strict';

/**
 * Cache négatif intelligent — tests pour isFreshCacheHit.
 *
 * Vérifie le comportement post-fix burn 6 mai 2026 :
 *   - cache hit normal pour rows avec email valide < TTL
 *   - cache hit "négatif" pour rows none < retryDays (skip retent)
 *   - cache miss pour rows none >= retryDays (retent autorisé)
 *   - cache miss pour rows > TTL global
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../shared/lead-exhauster');
const { isFreshCacheHit } = _internals;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

test('isFreshCacheHit — row null/undefined → false', () => {
  assert.equal(isFreshCacheHit(null), false);
  assert.equal(isFreshCacheHit(undefined), false);
  assert.equal(isFreshCacheHit({}), false);
});

test('isFreshCacheHit — lastVerifiedAt invalide → false', () => {
  assert.equal(isFreshCacheHit({ lastVerifiedAt: 'pas-une-date' }), false);
});

test('isFreshCacheHit — row email valide < TTL → cache hit', () => {
  const row = {
    email: 'paul@oseys.fr',
    source: 'dropcontact',
    confidence: 0.85,
    lastVerifiedAt: isoDaysAgo(30),
  };
  assert.equal(isFreshCacheHit(row), true);
});

test('isFreshCacheHit — row email valide > TTL (90j) → cache miss', () => {
  const row = {
    email: 'paul@oseys.fr',
    source: 'dropcontact',
    lastVerifiedAt: isoDaysAgo(120),
  };
  assert.equal(isFreshCacheHit(row), false);
});

test('isFreshCacheHit — row source=none + email absent < retryDays(7j) → cache hit (skip retent)', () => {
  const row = {
    email: null,
    source: 'none',
    lastVerifiedAt: isoDaysAgo(3),
  };
  assert.equal(isFreshCacheHit(row), true);
});

test('isFreshCacheHit — row source=none + email absent >= retryDays(7j) → cache miss (retent autorisé)', () => {
  const row = {
    email: null,
    source: 'none',
    lastVerifiedAt: isoDaysAgo(8),
  };
  assert.equal(isFreshCacheHit(row), false);
});

test('isFreshCacheHit — override LEADCONTACTS_NEGATIVE_RETRY_DAYS=14', () => {
  const prev = process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS;
  process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS = '14';
  try {
    const row = {
      email: null,
      source: 'none',
      lastVerifiedAt: isoDaysAgo(10),
    };
    // 10 < 14 → toujours cache hit (skip retent)
    assert.equal(isFreshCacheHit(row), true);

    const row2 = { ...row, lastVerifiedAt: isoDaysAgo(15) };
    // 15 >= 14 → cache miss (retent)
    assert.equal(isFreshCacheHit(row2), false);
  } finally {
    if (prev !== undefined) process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS = prev;
    else delete process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS;
  }
});

test('isFreshCacheHit — row email vide string + source=none → traité comme négatif', () => {
  const row = {
    email: '',
    source: 'none',
    lastVerifiedAt: isoDaysAgo(2),
  };
  // 2 < 7 → skip retent (cache hit)
  assert.equal(isFreshCacheHit(row), true);
});

test('isFreshCacheHit — row source=none mais > TTL global (90j) → cache miss', () => {
  const row = {
    email: null,
    source: 'none',
    lastVerifiedAt: isoDaysAgo(95),
  };
  // TTL global a la priorité, retentée même si fenêtre négative était écoulée
  assert.equal(isFreshCacheHit(row), false);
});
