/**
 * Tests — shared/disc-profiler/signals.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSignals,
  hasEnoughSignalsForInference,
  _cleanText,
  _truncate,
  _splitParagraphs,
  MAX_SIGNALS,
  MAX_SIGNAL_LEN,
} = require('../../../shared/disc-profiler/signals');

test('_cleanText — collapse whitespace + non-string', () => {
  assert.equal(_cleanText('foo\n\n\tbar'), 'foo bar');
  assert.equal(_cleanText(null), '');
  assert.equal(_cleanText(42), '');
});

test('_truncate — respecte la longueur max', () => {
  assert.equal(_truncate('abcdef', 4), 'abc…');
  assert.equal(_truncate('abc', 4), 'abc');
});

test('_splitParagraphs — splitte sur double newline ou phrase', () => {
  const parts = _splitParagraphs('Premier. Deuxième. Troisième paragraphe.', 3);
  assert.ok(parts.length >= 2);
});

test('extractSignals — input vide → []', () => {
  assert.deepEqual(extractSignals({}), []);
  assert.deepEqual(extractSignals(), []);
});

test('extractSignals — rôle seul produit 1 signal', () => {
  const s = extractSignals({ role: 'CEO & Fondateur' });
  assert.equal(s.length, 1);
  assert.equal(s[0].type, 'role');
  assert.ok(s[0].text.includes('CEO'));
});

test('extractSignals — rôle trop court est ignoré', () => {
  // "CEO" fait 3 chars, sous MIN_TEXT_LEN (6) → ignoré
  const s = extractSignals({ role: 'CEO' });
  assert.equal(s.length, 0);
});

test('extractSignals — profil LinkedIn complet produit plusieurs types', () => {
  const s = extractSignals({
    role: 'Directeur Commercial',
    linkedin: {
      headline: 'Directeur Commercial chez ACME, passionné par la croissance B2B',
      about: 'J\'accompagne des PME dans leur structuration commerciale. Ancien CAC 40, orientation résultat.',
      tenure: '3 ans',
      experiences: [
        { role: 'Head of Sales', company: 'BetaCorp', start: '2020', end: '2023', description: 'Passage de 5M€ à 15M€ ARR' },
      ],
      recentPosts: [
        { text: 'Retour sur notre trimestre : +22% de signatures, merci à toute l\'équipe.' },
      ],
    },
    companyTone: { excerpt: 'Nous structurons les ventes des PME ambitieuses.' },
    pressMentions: ['Profilé dans Les Echos cette semaine pour sa vision du B2B FR.'],
  });
  const types = new Set(s.map((x) => x.type));
  assert.ok(types.has('role'));
  assert.ok(types.has('headline'));
  assert.ok(types.has('about'));
  assert.ok(types.has('tenure'));
  assert.ok(types.has('experience'));
  assert.ok(types.has('post'));
  assert.ok(types.has('company_tone'));
  assert.ok(types.has('press'));
});

test('extractSignals — cap à MAX_SIGNALS', () => {
  const manyPosts = Array.from({ length: 40 }, (_, i) => ({
    text: `Post numéro ${i} avec assez de caractères pour être gardé`,
  }));
  const s = extractSignals({
    role: 'Directeur',
    linkedin: { recentPosts: manyPosts },
  });
  assert.ok(s.length <= MAX_SIGNALS);
});

test('extractSignals — chaque signal borné en longueur', () => {
  const big = 'x'.repeat(2000);
  const s = extractSignals({ role: 'Directeur', linkedin: { headline: big } });
  for (const sig of s) {
    assert.ok(sig.text.length <= MAX_SIGNAL_LEN);
  }
});

test('hasEnoughSignalsForInference — minimum 2 signaux + type discriminant', () => {
  assert.equal(hasEnoughSignalsForInference([]), false);
  assert.equal(hasEnoughSignalsForInference([{ type: 'press', text: 'x' }]), false);
  assert.equal(
    hasEnoughSignalsForInference([
      { type: 'tenure', text: 'x' },
      { type: 'press', text: 'y' },
    ]),
    false,
  );
  assert.equal(
    hasEnoughSignalsForInference([
      { type: 'role', text: 'CEO' },
      { type: 'press', text: 'y' },
    ]),
    true,
  );
  assert.equal(
    hasEnoughSignalsForInference([
      { type: 'headline', text: 'x' },
      { type: 'about', text: 'y' },
    ]),
    true,
  );
});
