'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  currentMonthKey,
  currentDayKey,
  periodKey,
} = require('../../../shared/lead-exhauster/budget');

test('currentMonthKey — format YYYYMM UTC', () => {
  const d = new Date('2026-05-06T22:30:00Z');
  assert.equal(currentMonthKey(d), '202605');
});

test('currentMonthKey — janvier padding', () => {
  const d = new Date('2026-01-15T00:00:00Z');
  assert.equal(currentMonthKey(d), '202601');
});

test('currentDayKey — format YYYYMMDD UTC', () => {
  const d = new Date('2026-05-06T22:30:00Z');
  assert.equal(currentDayKey(d), '20260506');
});

test('currentDayKey — UTC pas locale (jour suivant à 22h Paris en été)', () => {
  // 2026-05-06 22:30 Paris = 2026-05-06 20:30 UTC → toujours le 6 UTC
  const d = new Date('2026-05-06T20:30:00Z');
  assert.equal(currentDayKey(d), '20260506');
});

test('currentDayKey — bord de jour UTC', () => {
  const d = new Date('2026-12-31T23:59:00Z');
  assert.equal(currentDayKey(d), '20261231');
});

test('periodKey — daily renvoie YYYYMMDD', () => {
  const d = new Date('2026-05-06T12:00:00Z');
  assert.equal(periodKey('daily', d), '20260506');
});

test('periodKey — monthly renvoie YYYYMM', () => {
  const d = new Date('2026-05-06T12:00:00Z');
  assert.equal(periodKey('monthly', d), '202605');
});

test('periodKey — défaut sur monthly si période non reconnue', () => {
  const d = new Date('2026-05-06T12:00:00Z');
  assert.equal(periodKey('weekly', d), '202605');
  assert.equal(periodKey(undefined, d), '202605');
  assert.equal(periodKey(null, d), '202605');
});
