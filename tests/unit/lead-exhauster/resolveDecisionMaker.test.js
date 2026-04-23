/**
 * Tests unitaires — shared/lead-exhauster/resolveDecisionMaker.js
 *
 * Couvre les 4 cas d'entrée (INSEE présent/absent × profils scrapés
 * présents/absents) et la règle de rescore SPEC §3.5.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDecisionMaker,
  inseePriorScore,
  shouldRescore,
  scoreTeamProfile,
  pickBestProfile,
  findInseeMatchInProfiles,
} = require('../../../shared/lead-exhauster/resolveDecisionMaker');

// ─── inseePriorScore ───────────────────────────────────────────────────────

test('inseePriorScore — TPE (tranche < 11) → 0.85', () => {
  assert.equal(inseePriorScore('01'), 0.85);
  assert.equal(inseePriorScore('02'), 0.85);
  assert.equal(inseePriorScore('03'), 0.85);
});

test('inseePriorScore — petite équipe 11/12 → 0.80', () => {
  assert.equal(inseePriorScore('11'), 0.80);
  assert.equal(inseePriorScore('12'), 0.80);
});

test('inseePriorScore — PME 20-49 (tranche 21) → 0.55', () => {
  assert.equal(inseePriorScore('21'), 0.55);
});

test('inseePriorScore — PME 50+ → 0.40', () => {
  assert.equal(inseePriorScore('22'), 0.40);
  assert.equal(inseePriorScore('31'), 0.40);
});

test('inseePriorScore — tranche vide → 0.70 (neutre)', () => {
  assert.equal(inseePriorScore(''), 0.70);
  assert.equal(inseePriorScore(null), 0.70);
  assert.equal(inseePriorScore(undefined), 0.70);
});

// ─── shouldRescore ─────────────────────────────────────────────────────────

test('shouldRescore — tranches < 21 → false', () => {
  assert.equal(shouldRescore('11'), false);
  assert.equal(shouldRescore('12'), false);
  assert.equal(shouldRescore('03'), false);
});

test('shouldRescore — tranches ≥ 21 → true', () => {
  assert.equal(shouldRescore('21'), true);
  assert.equal(shouldRescore('22'), true);
  assert.equal(shouldRescore('31'), true);
});

test('shouldRescore — tranche vide → false', () => {
  assert.equal(shouldRescore(''), false);
  assert.equal(shouldRescore(null), false);
});

// ─── scoreTeamProfile ──────────────────────────────────────────────────────

test('scoreTeamProfile — DG forte → 0.9 minimum', () => {
  const score = scoreTeamProfile({
    firstName: 'Jean', lastName: 'Dupont',
    role: 'Directeur Général Adjoint', roleKeyword: 'directeur', roleScore: 0.6,
  });
  // roleScore brut 0.6, mais role contient "directeur général" → min 0.9
  assert.ok(score >= 0.9);
});

test('scoreTeamProfile — mot "ceo" boost', () => {
  const score = scoreTeamProfile({
    firstName: 'Marie', lastName: 'Martin',
    role: 'CEO & Fondatrice', roleKeyword: 'founder', roleScore: 0.9,
  });
  assert.ok(score >= 0.9);
});

test('scoreTeamProfile — profil sans nom → 0', () => {
  assert.equal(scoreTeamProfile({ role: 'CEO', roleScore: 0.9 }), 0);
  assert.equal(scoreTeamProfile(null), 0);
  assert.equal(scoreTeamProfile({}), 0);
});

// ─── findInseeMatchInProfiles ──────────────────────────────────────────────

test('findInseeMatchInProfiles — match lastName identique', () => {
  const insee = { firstName: 'Jean', lastName: 'Dupont' };
  const profiles = [
    { firstName: 'Marie', lastName: 'Martin' },
    { firstName: 'Jean', lastName: 'Dupont', role: 'DG' },
  ];
  const match = findInseeMatchInProfiles(insee, profiles);
  assert.ok(match);
  assert.equal(match.role, 'DG');
});

test('findInseeMatchInProfiles — lastName diff → null', () => {
  const insee = { firstName: 'Jean', lastName: 'Dupont' };
  const profiles = [{ firstName: 'Jean', lastName: 'Martin' }];
  assert.equal(findInseeMatchInProfiles(insee, profiles), null);
});

test('findInseeMatchInProfiles — tolère initiale diff si lastName OK', () => {
  const insee = { firstName: 'Jean-Pierre', lastName: 'Dupont' };
  const profiles = [{ firstName: 'Jean', lastName: 'Dupont', role: 'CEO' }];
  const match = findInseeMatchInProfiles(insee, profiles);
  assert.ok(match);
});

// ─── resolveDecisionMaker : 4 cas ──────────────────────────────────────────

test('cas 1 : pas INSEE, pas scrapé → null', () => {
  const r = resolveDecisionMaker({});
  assert.equal(r, null);
});

test('cas 2 : pas INSEE, scrapé → prend meilleur scrapé', () => {
  const r = resolveDecisionMaker({
    teamProfiles: [
      { firstName: 'Paul', lastName: 'Smith', role: 'consultant', roleScore: 0.3 },
      { firstName: 'Marie', lastName: 'Martin', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9 },
    ],
  });
  assert.equal(r.firstName, 'Marie');
  assert.equal(r.source, 'website');
  assert.ok(r.confidence >= 0.9);
});

test('cas 2 bis : pas INSEE, scrapé mais aucun valide → null', () => {
  const r = resolveDecisionMaker({
    teamProfiles: [{ role: 'CEO', roleScore: 0.9 }], // pas de firstName/lastName
  });
  assert.equal(r, null);
});

test('cas 3 : INSEE + pas scrapé → INSEE kept', () => {
  const r = resolveDecisionMaker({
    firstName: 'Jean', lastName: 'Dupont', trancheEffectif: '12',
  });
  assert.equal(r.firstName, 'Jean');
  assert.equal(r.source, 'insee');
  assert.equal(r.rescored, false);
  assert.equal(r.confidence, 0.80);
});

test('cas 4a : TPE + INSEE + scrapé différent → garde INSEE sans rescore', () => {
  const r = resolveDecisionMaker({
    firstName: 'Jean', lastName: 'Dupont', trancheEffectif: '11',
    teamProfiles: [
      { firstName: 'Marie', lastName: 'Martin', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9 },
    ],
  });
  assert.equal(r.source, 'insee');
  assert.equal(r.firstName, 'Jean');
  assert.equal(r.rescored, false);
  assert.ok(r.signals.some((s) => s.includes('rescore_skipped_small_tranche')));
});

test('cas 4b : PME + INSEE absent du site, scrapé fort → switch', () => {
  const r = resolveDecisionMaker({
    firstName: 'Jean', lastName: 'Dupont', trancheEffectif: '22',
    teamProfiles: [
      { firstName: 'Marie', lastName: 'Martin', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9 },
    ],
  });
  assert.equal(r.source, 'website');
  assert.equal(r.firstName, 'Marie');
  assert.equal(r.rescored, true);
  assert.ok(r.signals.some((s) => s.includes('rescore_switched')));
});

test('cas 4b bis : PME + INSEE + scrapé match INSEE → boost confidence, garde INSEE', () => {
  const r = resolveDecisionMaker({
    firstName: 'Jean', lastName: 'Dupont', trancheEffectif: '21',
    teamProfiles: [
      { firstName: 'Jean', lastName: 'Dupont', role: 'CEO', roleKeyword: 'ceo', roleScore: 0.9 },
    ],
  });
  assert.equal(r.source, 'insee');
  assert.equal(r.rescored, false);
  assert.ok(r.confidence >= 0.80);
  assert.ok(r.signals.some((s) => s.includes('insee_name_confirmed')));
});

test('cas 4c : PME + INSEE + scrapé faible (gap < 0.2) → garde INSEE sans rescore', () => {
  const r = resolveDecisionMaker({
    firstName: 'Jean', lastName: 'Dupont', trancheEffectif: '21',
    teamProfiles: [
      { firstName: 'Paul', lastName: 'Robert', role: 'consultant', roleScore: 0.3 },
    ],
  });
  // INSEE prior PME = 0.55, scrapé = 0.3 → gap négatif, garde INSEE
  assert.equal(r.source, 'insee');
  assert.equal(r.firstName, 'Jean');
  assert.equal(r.rescored, false);
});
