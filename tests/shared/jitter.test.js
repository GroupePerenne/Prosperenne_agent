'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  randomJitterMs,
  isBusinessHour,
  nextBusinessSlotStart,
  computeScheduledAt,
  getJitterWindowForSenderType,
  _JITTER_PROSPECT_MIN_MS,
  _JITTER_PROSPECT_MAX_MS,
  _JITTER_CONSULTANT_MIN_MS,
  _JITTER_CONSULTANT_MAX_MS,
} = require('../../shared/jitter');

const TZ = 'Europe/Paris';

// ─── randomJitterMs ────────────────────────────────────────────────────────

test('randomJitterMs retourne min si min === max', () => {
  assert.equal(randomJitterMs(1000, 1000), 1000);
});

test('randomJitterMs respecte les bornes [min, max)', () => {
  for (let i = 0; i < 50; i++) {
    const v = randomJitterMs(5 * 60_000, 45 * 60_000);
    assert.ok(v >= 5 * 60_000, `v=${v} < min`);
    assert.ok(v < 45 * 60_000 + 1, `v=${v} >= max+1`);
  }
});

test('randomJitterMs accepte un rng injecté pour tests déterministes', () => {
  const v = randomJitterMs(0, 10_000, () => 0.5);
  assert.equal(v, 5000);
});

test('randomJitterMs corrige min > max (swap)', () => {
  const v = randomJitterMs(45_000, 5_000, () => 0);
  assert.equal(v, 5_000);
});

// ─── isBusinessHour ────────────────────────────────────────────────────────

test('isBusinessHour true pour mardi 10h Paris', () => {
  // 12 mai 2026 = mardi
  const d = new Date('2026-05-12T08:00:00.000Z'); // 10h Paris (CEST = UTC+2)
  assert.equal(isBusinessHour(d, TZ), true);
});

test('isBusinessHour false pour samedi 10h Paris', () => {
  const d = new Date('2026-05-09T08:00:00.000Z'); // samedi 10h Paris
  assert.equal(isBusinessHour(d, TZ), false);
});

test('isBusinessHour false pour dimanche 10h Paris', () => {
  const d = new Date('2026-05-10T08:00:00.000Z'); // dimanche 10h Paris
  assert.equal(isBusinessHour(d, TZ), false);
});

test('isBusinessHour false pour mardi 8h Paris (avant 9h)', () => {
  const d = new Date('2026-05-12T06:00:00.000Z'); // 8h Paris
  assert.equal(isBusinessHour(d, TZ), false);
});

test('isBusinessHour false pour mardi 18h Paris (18 exclus)', () => {
  const d = new Date('2026-05-12T16:00:00.000Z'); // 18h Paris
  assert.equal(isBusinessHour(d, TZ), false);
});

test('isBusinessHour true pour mardi 9h Paris (9 inclus)', () => {
  const d = new Date('2026-05-12T07:00:00.000Z'); // 9h Paris
  assert.equal(isBusinessHour(d, TZ), true);
});

test('isBusinessHour true pour vendredi 17h59 Paris', () => {
  const d = new Date('2026-05-15T15:59:00.000Z'); // 17h59 Paris (vendredi)
  assert.equal(isBusinessHour(d, TZ), true);
});

// ─── nextBusinessSlotStart ─────────────────────────────────────────────────

test('nextBusinessSlotStart depuis samedi midi → lundi 9h Paris', () => {
  const sat = new Date('2026-05-09T10:00:00.000Z'); // sam 12h Paris
  const next = nextBusinessSlotStart(sat, TZ);
  // Doit être lundi 11 mai 9h Paris = 07:00 UTC (CEST)
  assert.equal(next.toISOString(), '2026-05-11T07:00:00.000Z');
});

test('nextBusinessSlotStart depuis mardi 20h → mercredi 9h Paris', () => {
  const tue = new Date('2026-05-12T18:00:00.000Z'); // mar 20h Paris
  const next = nextBusinessSlotStart(tue, TZ);
  // mercredi 13 mai 9h Paris = 07:00 UTC
  assert.equal(next.toISOString(), '2026-05-13T07:00:00.000Z');
});

test('nextBusinessSlotStart depuis mardi 10h → reste mardi 9h ce jour-là (cale au début créneau)', () => {
  // C'est en business hour : on veut quand même le START du créneau actuel
  // pour servir de base à l'ajout du jitter (cas où on a basculé en heures
  // ouvrées entre-temps). Comportement testé : retourne 9h ce jour-là.
  const tue = new Date('2026-05-12T08:00:00.000Z'); // mar 10h Paris
  const next = nextBusinessSlotStart(tue, TZ);
  assert.equal(next.toISOString(), '2026-05-12T07:00:00.000Z');
});

// ─── computeScheduledAt ────────────────────────────────────────────────────

test('computeScheduledAt en heures ouvrées : receivedAt + jitter direct', () => {
  // Mardi 10h Paris, jitter rng=0.5 → 25 min sur [5, 45]
  const received = new Date('2026-05-12T08:00:00.000Z');
  const scheduled = computeScheduledAt(received, {
    minMs: 5 * 60_000, maxMs: 45 * 60_000, tz: TZ, rng: () => 0.5,
  });
  // jitter = floor(5min + 0.5 * 40min) = 5min + 20min = 25min = 1_500_000 ms
  const expected = new Date(received.getTime() + 25 * 60_000);
  assert.equal(scheduled.toISOString(), expected.toISOString());
});

test('computeScheduledAt depuis samedi midi reporte au lundi 9h + jitter', () => {
  // Samedi 12h Paris → next slot = lundi 9h Paris (= lun 07:00 UTC)
  // jitter rng=0.0 → min = 5 min
  const sat = new Date('2026-05-09T10:00:00.000Z');
  const scheduled = computeScheduledAt(sat, {
    minMs: 5 * 60_000, maxMs: 45 * 60_000, tz: TZ, rng: () => 0,
  });
  const expected = new Date('2026-05-11T07:05:00.000Z'); // lundi 9h05
  assert.equal(scheduled.toISOString(), expected.toISOString());
});

test('computeScheduledAt depuis vendredi 17h55 + jitter qui déborde → lundi 9h+jitter', () => {
  // vendredi 17h55 Paris = 15:55 UTC ; jitter 30 min → tomberait à 18h25 vendredi (hors créneau)
  const fri = new Date('2026-05-15T15:55:00.000Z');
  const scheduled = computeScheduledAt(fri, {
    minMs: 30 * 60_000, maxMs: 30 * 60_000, tz: TZ, rng: () => 0,
  });
  // candidate = 18h25 vendredi → hors créneau → next slot = lundi 18 mai 9h Paris + 30min
  // lundi 18 mai 9h Paris = 07:00 UTC, +30min = 07:30 UTC
  assert.equal(scheduled.toISOString(), '2026-05-18T07:30:00.000Z');
});

test('computeScheduledAt à mardi 17h45 + jitter 5min → reste mardi 17h50 (toujours en créneau)', () => {
  const tue = new Date('2026-05-12T15:45:00.000Z'); // 17h45 Paris
  const scheduled = computeScheduledAt(tue, {
    minMs: 5 * 60_000, maxMs: 5 * 60_000, tz: TZ, rng: () => 0,
  });
  assert.equal(scheduled.toISOString(), '2026-05-12T15:50:00.000Z');
});

// ─── getJitterWindowForSenderType ──────────────────────────────────────────

test('getJitterWindowForSenderType prospect → fenêtre 5-45 min par défaut', () => {
  const w = getJitterWindowForSenderType('prospect');
  assert.equal(w.minMs, _JITTER_PROSPECT_MIN_MS);
  assert.equal(w.maxMs, _JITTER_PROSPECT_MAX_MS);
  assert.equal(w.kind, 'prospect');
});

test('getJitterWindowForSenderType consultant → fenêtre 15-45 min par défaut', () => {
  const w = getJitterWindowForSenderType('consultant');
  assert.equal(w.minMs, _JITTER_CONSULTANT_MIN_MS);
  assert.equal(w.maxMs, _JITTER_CONSULTANT_MAX_MS);
  assert.equal(w.kind, 'consultant');
});

test('getJitterWindowForSenderType internal → fenêtre consultant (border case)', () => {
  const w = getJitterWindowForSenderType('internal');
  assert.equal(w.minMs, _JITTER_CONSULTANT_MIN_MS);
  assert.equal(w.maxMs, _JITTER_CONSULTANT_MAX_MS);
});

test('getJitterWindowForSenderType unknown → fenêtre consultant', () => {
  const w = getJitterWindowForSenderType('weird');
  assert.equal(w.minMs, _JITTER_CONSULTANT_MIN_MS);
  assert.equal(w.maxMs, _JITTER_CONSULTANT_MAX_MS);
});

// ─── Defaults env ──────────────────────────────────────────────────────────

test('valeurs par défaut prospect = 5-45 min', () => {
  assert.equal(_JITTER_PROSPECT_MIN_MS, 5 * 60_000);
  assert.equal(_JITTER_PROSPECT_MAX_MS, 45 * 60_000);
});

test('valeurs par défaut consultant = 15-45 min', () => {
  assert.equal(_JITTER_CONSULTANT_MIN_MS, 15 * 60_000);
  assert.equal(_JITTER_CONSULTANT_MAX_MS, 45 * 60_000);
});
