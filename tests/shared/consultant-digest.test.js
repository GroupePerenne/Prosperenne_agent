'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatConsultantDigestHtml } = require('../../shared/consultant-digest');

const baseArgs = {
  consultantPrenom: 'Morgane',
  consultantEmail: 'm.dejessey@oseys.fr',
  dateRefIso: '2026-05-11',
};

// ─── Structure générale ────────────────────────────────────────────────────

test('formatConsultantDigestHtml retourne HTML non vide', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [] });
  assert.match(html, /Bonjour Morgane/);
  assert.match(html, /Aucune activité/);
  assert.match(html, /— David/);
  assert.match(html, /app\.pereneo\.eu/);
});

test('vouvoiement par défaut (Bonjour)', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [] });
  assert.match(html, /Bonjour Morgane/);
  assert.doesNotMatch(html, /Salut Morgane/);
});

test('tutoiement si brief tutoiement:true', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [], tutoiement: true });
  assert.match(html, /Salut Morgane/);
  assert.doesNotMatch(html, /Bonjour Morgane/);
});

// ─── Bloc journée ──────────────────────────────────────────────────────────

test('Hier = vide si aucune entrée', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [] });
  assert.match(html, /Hier \(11\/05\/2026\)/);
  assert.match(html, /Aucune activité de prospection/);
});

test('Hier = tableau si entries présentes', () => {
  const html = formatConsultantDigestHtml({
    ...baseArgs,
    entries: [{
      date: '2026-05-11', consultant: 'morgane',
      martin_sent: 3, mila_sent: 2, martin_opens: 1, mila_opens: 0,
      replies: 1, rdv_set: 0,
    }],
  });
  assert.match(html, /Envois prospects/);
  assert.match(html, />5</);  // total sent = 3 + 2 = 5
  assert.match(html, /3 \/ 2/);  // martin / mila
});

// ─── Bloc semaine ──────────────────────────────────────────────────────────

test('Semaine cumul J-6 → J0', () => {
  const html = formatConsultantDigestHtml({
    ...baseArgs,
    entries: [
      { date: '2026-05-10', consultant: 'morgane', martin_sent: 2, mila_sent: 1, replies: 0 },
      { date: '2026-05-11', consultant: 'morgane', martin_sent: 3, mila_sent: 2, replies: 1 },
    ],
  });
  assert.match(html, /Cumul 7 jours \(05\/05\/2026 → 11\/05\/2026\)/);
});

test('Pas de proposition stagiaire — pas de "demain je vais" / "que faire"', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [] });
  // Patterns qu on NE veut PAS — pas de propositions creuses ajoutées
  assert.doesNotMatch(html, /aujourd'hui je vais/i);
  assert.doesNotMatch(html, /proposition d'action/i);
  assert.doesNotMatch(html, /1\. /);  // pas de listes numérotées de propositions
  assert.doesNotMatch(html, /actions concrètes pour aujourd'hui/i);
});

// ─── Alertes ───────────────────────────────────────────────────────────────

test('Bloc alertes absent si liste vide', () => {
  const html = formatConsultantDigestHtml({ ...baseArgs, entries: [], alerts: [] });
  assert.doesNotMatch(html, /À signaler/);
});

test('Bloc alertes affiché si présent', () => {
  const html = formatConsultantDigestHtml({
    ...baseArgs, entries: [],
    alerts: ['1 bounce détecté sur le prospect X — adresse retirée du pipeline'],
  });
  assert.match(html, /À signaler/);
  assert.match(html, /1 bounce détecté/);
});

// ─── XSS protection ─────────────────────────────────────────────────────────

test('echappement nom consultant', () => {
  const html = formatConsultantDigestHtml({
    ...baseArgs,
    consultantPrenom: '<script>alert(1)</script>',
    entries: [],
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('echappement alertes', () => {
  const html = formatConsultantDigestHtml({
    ...baseArgs, entries: [],
    alerts: ['<img src=x onerror=alert(1)>'],
  });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img/);
});
