'use strict';

/**
 * Tests unitaires — shared/autoReplyDetector.js (plan v3.1 Pilier 3).
 *
 * Couvre :
 *   - Auto-Submitted RFC 3834 (auto-replied, auto-generated)
 *   - Auto-Submitted: no → pas d'auto-reply (cas message humain)
 *   - X-Auto-Response-Suppress Microsoft
 *   - Precedence: auto_reply, bulk, list, junk
 *   - X-Autoreply / X-Autorespond legacy
 *   - Subject patterns (out of office, absence, vacances, automatic reply, congés)
 *   - Message sans aucun signal → false
 *   - Headers absents (msg pas enrichi) → fallback subject
 *   - Null safety
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectAutoReply, isAutoReply } = require('../../../shared/autoReplyDetector');

function msgWithHeaders(headers, subject = 'Hello') {
  return {
    subject,
    internetMessageHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  };
}

// ─── Headers SMTP fiables ──────────────────────────────────────────────────

test('Auto-Submitted: auto-replied → true', () => {
  const r = detectAutoReply(msgWithHeaders({ 'Auto-Submitted': 'auto-replied' }));
  assert.equal(r.isAutoReply, true);
  assert.match(r.reason, /header_auto_submitted/);
});

test('Auto-Submitted: auto-generated → true', () => {
  const r = detectAutoReply(msgWithHeaders({ 'Auto-Submitted': 'auto-generated' }));
  assert.equal(r.isAutoReply, true);
});

test('Auto-Submitted: no → false (cas message humain explicite)', () => {
  const r = detectAutoReply(msgWithHeaders({ 'Auto-Submitted': 'no' }));
  assert.equal(r.isAutoReply, false);
});

test('X-Auto-Response-Suppress présent → true', () => {
  const r = detectAutoReply(msgWithHeaders({ 'X-Auto-Response-Suppress': 'OOF, DR, NDR' }));
  assert.equal(r.isAutoReply, true);
  assert.match(r.reason, /x_auto_response_suppress/);
});

test('Precedence: auto_reply → true', () => {
  const r = detectAutoReply(msgWithHeaders({ Precedence: 'auto_reply' }));
  assert.equal(r.isAutoReply, true);
  assert.match(r.reason, /precedence:auto_reply/);
});

test('Precedence: bulk → true', () => {
  const r = detectAutoReply(msgWithHeaders({ Precedence: 'bulk' }));
  assert.equal(r.isAutoReply, true);
});

test('Precedence: list → true', () => {
  const r = detectAutoReply(msgWithHeaders({ Precedence: 'list' }));
  assert.equal(r.isAutoReply, true);
});

test('Precedence: junk → true', () => {
  const r = detectAutoReply(msgWithHeaders({ Precedence: 'junk' }));
  assert.equal(r.isAutoReply, true);
});

test('X-Autoreply legacy → true', () => {
  const r = detectAutoReply(msgWithHeaders({ 'X-Autoreply': 'yes' }));
  assert.equal(r.isAutoReply, true);
});

test('X-Autorespond legacy → true', () => {
  const r = detectAutoReply(msgWithHeaders({ 'X-Autorespond': '1' }));
  assert.equal(r.isAutoReply, true);
});

// ─── Fallback subject ──────────────────────────────────────────────────────

test('Subject "Out of office" → true (fallback)', () => {
  const r = detectAutoReply({ subject: 'Out of office until Friday' });
  assert.equal(r.isAutoReply, true);
  assert.match(r.reason, /subject_pattern/);
});

test('Subject "Automatic reply" → true', () => {
  const r = detectAutoReply({ subject: 'Automatic reply: I am away' });
  assert.equal(r.isAutoReply, true);
});

test('Subject "Absence" FR → true', () => {
  const r = detectAutoReply({ subject: 'Absence du bureau' });
  assert.equal(r.isAutoReply, true);
});

test('Subject "Vacances" FR → true', () => {
  const r = detectAutoReply({ subject: 'En vacances jusqu\'au 30/05' });
  assert.equal(r.isAutoReply, true);
});

test('Subject "Réponse automatique" FR → true', () => {
  const r = detectAutoReply({ subject: 'Réponse automatique: bonjour' });
  assert.equal(r.isAutoReply, true);
});

test('Subject "Congés" FR → true', () => {
  const r = detectAutoReply({ subject: 'En congés jusqu\'à mardi' });
  assert.equal(r.isAutoReply, true);
});

// ─── Messages humains ──────────────────────────────────────────────────────

test('Subject humain normal, pas de header → false', () => {
  const r = detectAutoReply({ subject: 'Merci pour votre message' });
  assert.equal(r.isAutoReply, false);
  assert.equal(r.reason, null);
});

test('Subject Re: humain, pas de header → false', () => {
  const r = detectAutoReply({ subject: 'Re: Pereneo / Présentation' });
  assert.equal(r.isAutoReply, false);
});

// ─── Robustesse ─────────────────────────────────────────────────────────────

test('msg null → false', () => {
  assert.equal(isAutoReply(null), false);
});

test('msg undefined → false', () => {
  assert.equal(isAutoReply(undefined), false);
});

test('msg sans subject ni headers → false', () => {
  const r = detectAutoReply({});
  assert.equal(r.isAutoReply, false);
});

test('headers case-insensitive (AUTO-SUBMITTED vs Auto-Submitted)', () => {
  const r = detectAutoReply(msgWithHeaders({ 'AUTO-SUBMITTED': 'auto-replied' }));
  assert.equal(r.isAutoReply, true);
});

test('headers list absente → fallback subject', () => {
  const r = detectAutoReply({ subject: 'Out of office' });
  assert.equal(r.isAutoReply, true);
});
