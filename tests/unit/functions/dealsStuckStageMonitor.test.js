'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  formatStuckDealsHtml,
  formatDateFR,
} = require('../../../src/functions/dealsStuckStageMonitor');

// ============================================================
// formatDateFR
// ============================================================

test('formatDateFR — Pipedrive add_time "2026-05-14 16:18:12" → "14/05/2026"', () => {
  assert.strictEqual(formatDateFR('2026-05-14 16:18:12'), '14/05/2026');
});

test('formatDateFR — ISO sans heure → ok', () => {
  assert.strictEqual(formatDateFR('2026-05-01'), '01/05/2026');
});

test('formatDateFR — null/undefined → "?"', () => {
  assert.strictEqual(formatDateFR(null), '?');
  assert.strictEqual(formatDateFR(undefined), '?');
  assert.strictEqual(formatDateFR(''), '?');
});

test('formatDateFR — format inattendu → renvoie tel quel', () => {
  assert.strictEqual(formatDateFR('foobar'), 'foobar');
});

// ============================================================
// formatStuckDealsHtml
// ============================================================

test('formatStuckDealsHtml — 1 deal → HTML contient ID + société + jours stuck', () => {
  const stuck = [
    {
      id: 2559,
      title: 'PROTECSAN',
      org: 'PROTECSAN',
      person: 'ERIC PIROUD',
      owner: 'morgane@perennereseau.fr',
      addTime: '2026-05-14 16:18:12',
      daysStuck: 5,
    },
  ];
  const html = formatStuckDealsHtml(stuck, 14);
  assert.ok(html.includes('#2559'));
  assert.ok(html.includes('PROTECSAN'));
  assert.ok(html.includes('ERIC PIROUD'));
  assert.ok(html.includes('14/05/2026'));
  assert.ok(html.includes('5 j'));
  assert.ok(html.includes('1 deal(s)'));
  assert.ok(html.includes('14 jours'));
});

test('formatStuckDealsHtml — 3 deals → HTML contient 3 rows + total', () => {
  const stuck = [
    { id: 1, title: '', org: 'Org A', person: 'P A', owner: 'a@b.fr', addTime: '2026-05-01', daysStuck: 18 },
    { id: 2, title: '', org: 'Org B', person: 'P B', owner: 'b@b.fr', addTime: '2026-05-02', daysStuck: 17 },
    { id: 3, title: '', org: 'Org C', person: 'P C', owner: 'c@b.fr', addTime: '2026-05-03', daysStuck: 16 },
  ];
  const html = formatStuckDealsHtml(stuck, 14);
  assert.ok(html.includes('Org A'));
  assert.ok(html.includes('Org B'));
  assert.ok(html.includes('Org C'));
  assert.ok(html.includes('3 deal(s)'));
});

test('formatStuckDealsHtml — XSS protection sur org name', () => {
  const stuck = [
    { id: 99, title: '', org: '<script>alert(1)</script>', person: 'X', owner: 'o', addTime: '2026-05-01', daysStuck: 14 },
  ];
  const html = formatStuckDealsHtml(stuck, 14);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('formatStuckDealsHtml — lien Pipedrive structuré', () => {
  const stuck = [
    { id: 2543, title: '', org: 'UNIVERT', person: '', owner: '', addTime: '2026-05-01', daysStuck: 14 },
  ];
  const html = formatStuckDealsHtml(stuck, 14);
  assert.ok(html.includes('https://oseys.pipedrive.com/deal/2543'));
});

test('formatStuckDealsHtml — vide → rendu vide propre (pas appelé en prod si liste vide mais robustesse)', () => {
  const html = formatStuckDealsHtml([], 14);
  assert.ok(html.includes('0 deal(s)'));
  assert.ok(!html.includes('<tr>\n  <td>')); // pas de row
});
