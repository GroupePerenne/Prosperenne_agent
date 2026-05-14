'use strict';

/**
 * Tests unitaires — shared/assignAgent.js (plan v3.1 Pilier 6).
 *
 * Couvre les 3 scénarios E2E cross-sell :
 *   E2E 11 : Martin actif + candidate Martin → re-pioche force Mila
 *   E2E 12 : Martin + Mila actifs → SKIP
 *   E2E 13 : Aucun actif → candidate utilisé tel quel
 *
 * + variations :
 *   - Mila actif + candidate Mila → re-pioche force Martin (symétrique E2E 11)
 *   - Martin actif + candidate Mila → candidate distinct, utilise Mila
 *   - Mila actif + candidate Martin → candidate distinct, utilise Martin
 *   - candidate invalide → SKIP
 *   - extractActiveAgents depuis deals Pipedrive (mapping option_id)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decideAgent,
  extractActiveAgents,
} = require('../../../shared/assignAgent');

// ─── decideAgent ───────────────────────────────────────────────────────────

test('E2E 13 — aucun deal actif → candidate utilisé', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: [] });
  assert.equal(r.agent, 'martin');
  assert.equal(r.skip, false);
  assert.match(r.reason, /no_prior/);
});

test('E2E 11 — Martin actif + candidate Martin → re-pioche force Mila', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: ['martin'] });
  assert.equal(r.agent, 'mila');
  assert.equal(r.skip, false);
  assert.match(r.reason, /cross_sell_repick/);
});

test('symétrique E2E 11 — Mila actif + candidate Mila → re-pioche force Martin', () => {
  const r = decideAgent({ candidateAgent: 'mila', activeAgents: ['mila'] });
  assert.equal(r.agent, 'martin');
  assert.equal(r.skip, false);
});

test('Martin actif + candidate Mila → candidate distinct, utilise Mila', () => {
  const r = decideAgent({ candidateAgent: 'mila', activeAgents: ['martin'] });
  assert.equal(r.agent, 'mila');
  assert.equal(r.skip, false);
  assert.match(r.reason, /candidate_distinct/);
});

test('Mila actif + candidate Martin → candidate distinct, utilise Martin', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: ['mila'] });
  assert.equal(r.agent, 'martin');
  assert.equal(r.skip, false);
});

test('E2E 12 — Martin + Mila actifs → SKIP', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: ['martin', 'mila'] });
  assert.equal(r.agent, null);
  assert.equal(r.skip, true);
  assert.match(r.reason, /both_agents_already_active/);
});

test('activeAgents dédup (Martin x2 → 1 actif)', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: ['martin', 'martin'] });
  assert.equal(r.agent, 'mila');
  assert.equal(r.skip, false);
});

test('candidate invalide → SKIP avec reason', () => {
  const r = decideAgent({ candidateAgent: 'alicia', activeAgents: [] });
  assert.equal(r.agent, null);
  assert.equal(r.skip, true);
  assert.match(r.reason, /invalid_candidate/);
});

test('candidate undefined → SKIP', () => {
  const r = decideAgent({ activeAgents: [] });
  assert.equal(r.skip, true);
});

test('activeAgents avec valeur invalide ignorée', () => {
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: ['martin', 'foo'] });
  // 'foo' filtré → seul Martin actif → re-pioche Mila
  assert.equal(r.agent, 'mila');
  assert.equal(r.skip, false);
});

// ─── extractActiveAgents ───────────────────────────────────────────────────

test('extractActiveAgents — 0 deals → []', () => {
  assert.deepEqual(extractActiveAgents([], { agentSenderFieldKey: 'custom_field_x' }), []);
});

test('extractActiveAgents — fieldKey absent → []', () => {
  // No env var, no opt → skip
  const previous = process.env.PIPEDRIVE_FIELD_AGENT_SENDER;
  delete process.env.PIPEDRIVE_FIELD_AGENT_SENDER;
  try {
    assert.deepEqual(extractActiveAgents([{ custom_field_x: 378 }]), []);
  } finally {
    if (previous !== undefined) process.env.PIPEDRIVE_FIELD_AGENT_SENDER = previous;
  }
});

test('extractActiveAgents — deal Martin option 378 → [martin]', () => {
  const deals = [{ id: 1, custom_field_x: 378 }];
  const r = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  assert.deepEqual(r, ['martin']);
});

test('extractActiveAgents — deals Martin + Mila → [martin, mila]', () => {
  const deals = [
    { id: 1, custom_field_x: 378 },
    { id: 2, custom_field_x: 379 },
  ];
  const r = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  assert.deepEqual(r.sort(), ['martin', 'mila']);
});

test('extractActiveAgents — 2 deals même agent → dédup [martin]', () => {
  const deals = [
    { id: 1, custom_field_x: 378 },
    { id: 2, custom_field_x: 378 },
  ];
  const r = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  assert.deepEqual(r, ['martin']);
});

test('extractActiveAgents — option_id inconnu ignoré', () => {
  const deals = [{ id: 1, custom_field_x: 999 }];
  const r = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  assert.deepEqual(r, []);
});

test('extractActiveAgents — null deals → []', () => {
  assert.deepEqual(extractActiveAgents(null, { agentSenderFieldKey: 'k' }), []);
});

test('extractActiveAgents — deal sans champ agent_sender ignoré', () => {
  const deals = [{ id: 1 }, { id: 2, custom_field_x: 378 }];
  const r = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  assert.deepEqual(r, ['martin']);
});

// ─── Combinaison decideAgent + extractActiveAgents ─────────────────────────

test('Cas réaliste : Pipedrive deals Martin → cross-sell Mila', () => {
  const deals = [{ id: 42, custom_field_x: 378 }];
  const active = extractActiveAgents(deals, { agentSenderFieldKey: 'custom_field_x' });
  const r = decideAgent({ candidateAgent: 'martin', activeAgents: active });
  assert.equal(r.agent, 'mila');
  assert.equal(r.skip, false);
});
