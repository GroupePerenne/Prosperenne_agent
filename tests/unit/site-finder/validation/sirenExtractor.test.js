'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSirens,
  containsTargetSiren,
  _internals,
} = require('../../../../shared/site-finder/validation/sirenExtractor');

// ─── Préfixes explicites ───────────────────────────────────────────────────

test('extractSirens — SIREN 123 456 789', () => {
  const r = extractSirens('Notre SIREN 123 456 789 est public.');
  assert.equal(r.length, 1);
  assert.equal(r[0].siren, '123456789');
  assert.equal(r[0].source, 'labeled');
});

test('extractSirens — SIREN: 123456789 (deux-points)', () => {
  const r = extractSirens('SIREN: 123456789');
  assert.equal(r.length, 1);
  assert.equal(r[0].siren, '123456789');
});

test('extractSirens — n°SIREN 123-456-789 (tirets)', () => {
  const r = extractSirens('n°SIREN 123-456-789 — RCS Lyon');
  assert.ok(r.some((x) => x.siren === '123456789'));
});

test('extractSirens — SIRET 12345678900012 → garde les 9 premiers', () => {
  const r = extractSirens('SIRET 12345678900012');
  assert.equal(r.length, 1);
  assert.equal(r[0].siren, '123456789');
});

test('extractSirens — SIRET 123 456 789 00012 (avec espaces)', () => {
  const r = extractSirens('SIRET 123 456 789 00012');
  assert.equal(r.length, 1);
  assert.equal(r[0].siren, '123456789');
});

test("extractSirens — RCS Lyon 123 456 789", () => {
  const r = extractSirens('RCS Lyon 123 456 789 — Capital 10000€');
  assert.ok(r.some((x) => x.siren === '123456789'));
});

test("extractSirens — N° d'identification 123456789", () => {
  const r = extractSirens("N° d'identification 123456789 (registre)");
  assert.ok(r.some((x) => x.siren === '123456789'));
});

// ─── TVA intra ─────────────────────────────────────────────────────────────

test('extractSirens — TVA intra FR82123456789', () => {
  const r = extractSirens('TVA intracom: FR82123456789');
  assert.ok(r.some((x) => x.siren === '123456789' && x.source === 'tva_fr'));
});

test('extractSirens — TVA intra FR 82 123 456 789 (séparateurs)', () => {
  const r = extractSirens('FR 82 123 456 789');
  const candidates = r.filter((x) => x.siren === '123456789');
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some((x) => x.source === 'tva_fr'));
});

// ─── SIREN isolé ───────────────────────────────────────────────────────────

test('extractSirens — SIREN isolé sur une ligne', () => {
  const r = extractSirens('Capital 10000 EUR\n123 456 789\nForme: SAS');
  assert.ok(r.some((x) => x.siren === '123456789' && x.source === 'isolated'));
});

// ─── Faux positifs (ne doit PAS matcher) ───────────────────────────────────

test('extractSirens — N° de téléphone 0612345678 NE matche PAS', () => {
  const r = extractSirens('Tél : 0612345678');
  assert.equal(r.length, 0);
});

test('extractSirens — N° tel format 06 12 34 56 78 NE matche PAS comme SIREN', () => {
  const r = extractSirens('Tél : 06 12 34 56 78 (10 chiffres)');
  assert.equal(r.length, 0);
});

test('extractSirens — adresse "5 rue Foo, 75001 Paris" NE matche PAS', () => {
  const r = extractSirens('5 rue Foo, 75001 Paris');
  assert.equal(r.length, 0);
});

test('extractSirens — slug ou ID alphanumérique NE matche PAS', () => {
  const r = extractSirens('user-id=ABC123456789XYZ');
  assert.equal(r.length, 0);
});

test('extractSirens — séquence de 8 chiffres NE matche PAS (pas un SIREN)', () => {
  const r = extractSirens('Code: 12345678');
  assert.equal(r.length, 0);
});

// ─── Multiples SIREN dans le même texte ────────────────────────────────────

test('extractSirens — plusieurs formats coexistant', () => {
  const text = 'SIREN 111 222 333. Filiale RCS Paris 444 555 666. TVA FR82777888999.';
  const r = extractSirens(text);
  const sirens = r.map((x) => x.siren).sort();
  assert.deepEqual(sirens, ['111222333', '444555666', '777888999']);
});

test('extractSirens — déduplique pas (multiples occurrences gardées)', () => {
  const r = extractSirens('SIREN 123456789. Voir aussi SIRET 12345678900012.');
  // 2 matches : labeled SIREN + labeled SIRET, tous les deux donnent 123456789
  const matchedAsTarget = r.filter((x) => x.siren === '123456789');
  assert.ok(matchedAsTarget.length >= 2);
});

// ─── HTML brut ─────────────────────────────────────────────────────────────

test('extractSirens — HTML avec balises autour', () => {
  const html = '<footer><p>SIREN <strong>123 456 789</strong></p></footer>';
  const r = extractSirens(html);
  assert.ok(r.some((x) => x.siren === '123456789'));
});

test('extractSirens — HTML mentions légales réaliste', () => {
  const html = `
    <h2>Mentions légales</h2>
    <p>Société : ACME SAS</p>
    <p>Capital : 10 000 €</p>
    <p>SIRET : 123 456 789 00012</p>
    <p>RCS Lyon B 123 456 789</p>
    <p>TVA FR82 123 456 789</p>
  `;
  const r = extractSirens(html);
  // Plusieurs occurrences du même SIREN cible attendues
  const matches = r.filter((x) => x.siren === '123456789');
  assert.ok(matches.length >= 2, `attendu ≥2 occurrences, trouvé ${matches.length}`);
});

// ─── containsTargetSiren ───────────────────────────────────────────────────

test('containsTargetSiren — match positif', () => {
  const r = containsTargetSiren('SIREN 123 456 789', '123456789');
  assert.equal(r.found, true);
  assert.equal(r.source, 'labeled');
});

test('containsTargetSiren — match négatif (autre SIREN dans le texte)', () => {
  const r = containsTargetSiren('SIREN 999 888 777', '123456789');
  assert.equal(r.found, false);
});

test('containsTargetSiren — target invalide retourne found:false', () => {
  const r = containsTargetSiren('SIREN 123 456 789', '12345');
  assert.equal(r.found, false);
});

test('containsTargetSiren — texte vide', () => {
  const r = containsTargetSiren('', '123456789');
  assert.equal(r.found, false);
});

// ─── Internal helpers ──────────────────────────────────────────────────────

test('_internals.takeNineDigits — accepte 9 et 14 chiffres', () => {
  const { takeNineDigits } = _internals;
  assert.equal(takeNineDigits('123456789'), '123456789');
  assert.equal(takeNineDigits('123 456 789'), '123456789');
  assert.equal(takeNineDigits('12345678900012'), '123456789');
  assert.equal(takeNineDigits('12345678'), null);
  assert.equal(takeNineDigits('1234567890'), null);
  assert.equal(takeNineDigits(null), null);
});

test('extractSirens — retourne tableau vide pour entrée invalide', () => {
  assert.deepEqual(extractSirens(null), []);
  assert.deepEqual(extractSirens(undefined), []);
  assert.deepEqual(extractSirens(''), []);
  assert.deepEqual(extractSirens(42), []);
});

test('extractSirens — context capture les 30 chars autour', () => {
  const r = extractSirens('Une phrase longue avec SIREN 123 456 789 dedans.');
  assert.equal(r.length, 1);
  assert.ok(r[0].context.includes('SIREN 123 456 789'));
});
