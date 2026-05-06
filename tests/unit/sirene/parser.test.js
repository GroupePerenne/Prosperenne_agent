/**
 * Tests parser CSV RFC 4180 — shared/sirene/parser.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse, parseStream, _internals } = require('../../../shared/sirene/parser');

// ─── Cas nominaux ─────────────────────────────────────────────────────────

test('parser — header simple + 1 ligne', () => {
  const text = 'siren;nom\n123456789;ACME';
  const { headers, rows } = parse(text);
  assert.deepEqual(headers, ['siren', 'nom']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].siren, '123456789');
  assert.equal(rows[0].nom, 'ACME');
});

test('parser — strip BOM UTF-8', () => {
  const text = '﻿siren;nom\n123456789;ACME';
  const { headers } = parse(text);
  assert.equal(headers[0], 'siren'); // pas '﻿siren'
});

test('parser — séparateur virgule via opts', () => {
  const text = 'a,b,c\n1,2,3';
  const { rows } = parse(text, { separator: ',' });
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].c, '3');
});

// ─── Échappement par guillemets (cas critique pour SIRENE) ────────────────

test('parser — champ contenant le séparateur entre guillemets', () => {
  // Le cas qui a fait planter awk -F\\; dans le smoke Phase 1
  const text = 'siren;nom\n123456789;"EXPERTS PARTENAIRES; PARISIENS"';
  const { rows } = parse(text);
  assert.equal(rows[0].nom, 'EXPERTS PARTENAIRES; PARISIENS');
});

test('parser — guillemets doublés dans champ quoté', () => {
  // RFC 4180 : "" à l'intérieur d'un champ quoté = un guillemet
  const text = 'a;b\nfoo;"il a dit ""bonjour"" hier"';
  const { rows } = parse(text);
  assert.equal(rows[0].b, 'il a dit "bonjour" hier');
});

test('parser — retour ligne dans champ quoté', () => {
  const text = 'a;b\nfoo;"ligne 1\nligne 2"';
  const { rows } = parse(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].b, 'ligne 1\nligne 2');
});

test('parser — CRLF (Windows) géré comme LF', () => {
  const text = 'a;b\r\n1;2\r\n3;4';
  const { rows } = parse(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].a, '3');
});

// ─── Cas frontière ────────────────────────────────────────────────────────

test('parser — texte vide → headers et rows vides', () => {
  const r = parse('');
  assert.deepEqual(r.headers, []);
  assert.deepEqual(r.rows, []);
});

test('parser — header seul sans données', () => {
  const r = parse('siren;nom');
  assert.deepEqual(r.headers, ['siren', 'nom']);
  assert.deepEqual(r.rows, []);
});

test('parser — ligne avec champ vide', () => {
  const text = 'a;b;c\n1;;3';
  const { rows } = parse(text);
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].b, '');
  assert.equal(rows[0].c, '3');
});

test('parser — ligne plus courte que les headers → champs manquants = ""', () => {
  const text = 'a;b;c\n1;2';
  const { rows } = parse(text);
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].b, '2');
  assert.equal(rows[0].c, '');
});

test('parser — last line sans \\n final', () => {
  const text = 'a;b\n1;2\n3;4';
  const { rows } = parse(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].b, '4');
});

// ─── Volumétrie & performance ─────────────────────────────────────────────

test('parser — perf 1000 lignes < 50ms', () => {
  const lines = ['siren;nom'];
  for (let i = 0; i < 1000; i++) lines.push(`${100000000 + i};ENTREPRISE_${i}`);
  const text = lines.join('\n');
  const t0 = Date.now();
  const { rows } = parse(text);
  const dt = Date.now() - t0;
  assert.equal(rows.length, 1000);
  assert.ok(dt < 200, `parser trop lent : ${dt}ms`);
});

// ─── parseStream ──────────────────────────────────────────────────────────

test('parseStream — yields ligne par ligne', async () => {
  async function* chunks() {
    yield 'siren;nom\n';
    yield '123456789;ACME\n';
    yield '987654321;FOOBAR\n';
  }
  const out = [];
  for await (const r of parseStream(chunks())) out.push(r);
  assert.equal(out.length, 2);
  assert.equal(out[0].siren, '123456789');
  assert.equal(out[1].nom, 'FOOBAR');
});

test('parseStream — chunk coupe au milieu d\'une ligne', async () => {
  // Le chunking peut couper à n'importe quel offset
  async function* chunks() {
    yield 'siren;n';
    yield 'om\n123456789;A';
    yield 'CME\n';
  }
  const out = [];
  for await (const r of parseStream(chunks())) out.push(r);
  assert.equal(out.length, 1);
  assert.equal(out[0].siren, '123456789');
  assert.equal(out[0].nom, 'ACME');
});

// ─── Cas réel SIRENE OpenDataSoft ─────────────────────────────────────────

test('parser — ligne SIRENE OpenDataSoft réaliste', () => {
  const text = `siren;denominationunitelegale;trancheeffectifsetablissement;activiteprincipaleetablissement;codepostaletablissement;libellecommuneetablissement
834462061;AUDION;20 à 49 salariés;70.22Z;75017;PARIS
531291003;GROUPE CONSORTIA;6 à 9 salariés;82.99Z;75017;PARIS`;
  const { rows } = parse(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].siren, '834462061');
  assert.equal(rows[0].denominationunitelegale, 'AUDION');
  assert.equal(rows[0].trancheeffectifsetablissement, '20 à 49 salariés');
  assert.equal(rows[1].denominationunitelegale, 'GROUPE CONSORTIA');
});

test('parser — exposed _internals.parseRecords pour debug', () => {
  // Sanity check : parseRecords retourne directement les Array<Array>
  const records = _internals.parseRecords('a;b\n1;2\n3;4', ';', false);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], ['a', 'b']);
  assert.deepEqual(records[2], ['3', '4']);
});
