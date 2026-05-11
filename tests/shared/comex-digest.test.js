'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregate7Days,
  aggregateSingleDay,
  computeRates,
  formatComexDigestHtml,
} = require('../../shared/comex-digest');

// ─── aggregate7Days ────────────────────────────────────────────────────────

test('aggregate7Days fenêtre J-6 → J0 (7 jours)', () => {
  const refIso = '2026-05-12';
  const result = aggregate7Days([], refIso);
  assert.equal(result.dateEnd, '2026-05-12');
  assert.equal(result.dateStart, '2026-05-06');
  assert.equal(result.numDays, 7);
  assert.equal(result.hasData, false);
});

test('aggregate7Days hors fenêtre exclus', () => {
  const entries = [
    { date: '2026-04-30', consultant: 'morgane', martin_sent: 5 }, // hors fenêtre (J-12)
    { date: '2026-05-06', consultant: 'morgane', martin_sent: 3 }, // dans fenêtre (J-6)
    { date: '2026-05-12', consultant: 'morgane', martin_sent: 2 }, // dans fenêtre (J0)
    { date: '2026-05-13', consultant: 'morgane', martin_sent: 1 }, // futur, hors fenêtre
  ];
  const result = aggregate7Days(entries, '2026-05-12');
  assert.equal(result.entriesCount, 2);
  assert.equal(result.perConsultant.get('morgane').martin_sent, 5);
});

test('aggregate7Days segmente par consultant', () => {
  const entries = [
    { date: '2026-05-10', consultant: 'morgane', martin_sent: 5, mila_sent: 3, replies: 1 },
    { date: '2026-05-11', consultant: 'morgane', martin_sent: 4, mila_sent: 2, replies: 0 },
    { date: '2026-05-10', consultant: 'johnny', martin_sent: 2, mila_sent: 8, replies: 2, rdv_set: 1 },
  ];
  const result = aggregate7Days(entries, '2026-05-12');
  assert.equal(result.perConsultant.size, 2);
  const morgane = result.perConsultant.get('morgane');
  assert.equal(morgane.martin_sent, 9);
  assert.equal(morgane.mila_sent, 5);
  assert.equal(morgane.total_sent, 14);
  assert.equal(morgane.replies, 1);
  const johnny = result.perConsultant.get('johnny');
  assert.equal(johnny.martin_sent, 2);
  assert.equal(johnny.mila_sent, 8);
  assert.equal(johnny.rdv_set, 1);
});

test('aggregate7Days totals = somme par consultant', () => {
  const entries = [
    { date: '2026-05-10', consultant: 'morgane', martin_sent: 5, mila_sent: 3, replies: 1, rdv_set: 0 },
    { date: '2026-05-10', consultant: 'johnny', martin_sent: 2, mila_sent: 8, replies: 2, rdv_set: 1 },
  ];
  const result = aggregate7Days(entries, '2026-05-12');
  assert.equal(result.totals.martin_sent, 7);
  assert.equal(result.totals.mila_sent, 11);
  assert.equal(result.totals.total_sent, 18);
  assert.equal(result.totals.replies, 3);
  assert.equal(result.totals.rdv_set, 1);
});

// ─── aggregateSingleDay ────────────────────────────────────────────────────

test('aggregateSingleDay ne garde que la date exacte', () => {
  const entries = [
    { date: '2026-05-11', consultant: 'morgane', martin_sent: 3 },
    { date: '2026-05-12', consultant: 'morgane', martin_sent: 5 },
    { date: '2026-05-13', consultant: 'morgane', martin_sent: 1 },
  ];
  const result = aggregateSingleDay(entries, '2026-05-12');
  assert.equal(result.hasData, true);
  assert.equal(result.perConsultant.get('morgane').martin_sent, 5);
});

test('aggregateSingleDay hasData=false si aucune entrée matchante', () => {
  const result = aggregateSingleDay([], '2026-05-12');
  assert.equal(result.hasData, false);
});

// ─── computeRates ──────────────────────────────────────────────────────────

test('computeRates calcule taux corrects', () => {
  const totals = {
    total_sent: 100, total_opens: 40, replies: 10, rdv_set: 3,
    martin_sent: 60, mila_sent: 40,
  };
  const rates = computeRates(totals);
  assert.equal(rates.openRate, 40);
  assert.equal(rates.replyRate, 10);
  assert.equal(rates.rdvRate, 30); // 3/10
  assert.equal(rates.martinShare, 60);
});

test('computeRates retourne null si dénominateur zéro', () => {
  const totals = {
    total_sent: 0, total_opens: 0, replies: 0, rdv_set: 0,
    martin_sent: 0, mila_sent: 0,
  };
  const rates = computeRates(totals);
  assert.equal(rates.openRate, null);
  assert.equal(rates.replyRate, null);
  assert.equal(rates.rdvRate, null);
  assert.equal(rates.martinShare, null);
});

test('computeRates rdvRate null si replies=0 même si rdv_set non nul (cas impossible mais robuste)', () => {
  const totals = {
    total_sent: 10, total_opens: 0, replies: 0, rdv_set: 0,
    martin_sent: 10, mila_sent: 0,
  };
  const rates = computeRates(totals);
  assert.equal(rates.rdvRate, null); // pas de division par zéro
});

// ─── formatComexDigestHtml ─────────────────────────────────────────────────

test('formatComexDigestHtml génère un HTML non vide', () => {
  const singleDay = aggregateSingleDay([], '2026-05-12');
  const weekly = aggregate7Days([], '2026-05-12');
  const html = formatComexDigestHtml({ singleDay, weekly, dateLabel: '12/05/2026' });
  assert.ok(html.includes('Récap COMEX'));
  assert.ok(html.includes('12/05/2026'));
  assert.ok(html.includes('Aucune activité')); // état initial vide
});

test('formatComexDigestHtml inclut les consultants avec data', () => {
  const entries = [
    { date: '2026-05-12', consultant: 'morgane', martin_sent: 5, mila_sent: 3, replies: 1 },
    { date: '2026-05-12', consultant: 'johnny', martin_sent: 2, mila_sent: 8 },
  ];
  const singleDay = aggregateSingleDay(entries, '2026-05-12');
  const weekly = aggregate7Days(entries, '2026-05-12');
  const html = formatComexDigestHtml({ singleDay, weekly, dateLabel: '12/05/2026' });
  assert.ok(html.includes('Morgane'));
  assert.ok(html.includes('Johnny'));
  assert.ok(html.includes('Total'));
});

test('formatComexDigestHtml inclut bloc alertes si fournies', () => {
  const singleDay = aggregateSingleDay([], '2026-05-12');
  const weekly = aggregate7Days([], '2026-05-12');
  const html = formatComexDigestHtml({
    singleDay, weekly, dateLabel: '12/05/2026',
    alerts: ['1 groupe doublon détecté david@ → j.serra@oseys.fr', '2 exceptions Error en 24h'],
  });
  assert.ok(html.includes('Alertes'));
  assert.ok(html.includes('1 groupe doublon détecté'));
  assert.ok(html.includes('2 exceptions Error'));
});

test('formatComexDigestHtml dit "Aucune alerte" si liste vide', () => {
  const singleDay = aggregateSingleDay([], '2026-05-12');
  const weekly = aggregate7Days([], '2026-05-12');
  const html = formatComexDigestHtml({ singleDay, weekly, dateLabel: '12/05/2026', alerts: [] });
  assert.ok(html.includes('Aucune alerte'));
});

// ─── XSS escape ────────────────────────────────────────────────────────────

test('formatComexDigestHtml échappe les inputs malveillants', () => {
  const singleDay = aggregateSingleDay([
    { date: '2026-05-12', consultant: '<script>alert(1)</script>', martin_sent: 1 },
  ], '2026-05-12');
  const weekly = aggregate7Days([], '2026-05-12');
  const html = formatComexDigestHtml({ singleDay, weekly, dateLabel: '12/05/2026' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
