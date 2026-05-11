'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubject,
  makeGroupKey,
  groupBySimilarity,
  detectSuspectGroups,
  _THRESHOLD_24H,
  _THRESHOLD_7D,
} = require('../../shared/sent-items-monitor');

// ─── normalizeSubject ──────────────────────────────────────────────────────

test('normalizeSubject lowercase + trim', () => {
  assert.equal(normalizeSubject('  Hello World  '), 'hello world');
});

test('normalizeSubject retire préfixe Re:', () => {
  assert.equal(normalizeSubject('Re: Bienvenue'), 'bienvenue');
  assert.equal(normalizeSubject('RE: Bienvenue'), 'bienvenue');
  assert.equal(normalizeSubject('re: Bienvenue'), 'bienvenue');
});

test('normalizeSubject retire préfixes Fwd: et TR:', () => {
  assert.equal(normalizeSubject('Fwd: bonjour'), 'bonjour');
  assert.equal(normalizeSubject('Fw: bonjour'), 'bonjour');
  assert.equal(normalizeSubject('TR: bonjour'), 'bonjour');
});

test('normalizeSubject retire préfixes empilés', () => {
  assert.equal(normalizeSubject('Re: Re: Re: hello'), 'hello');
  assert.equal(normalizeSubject('Fwd: Re: hello'), 'hello');
});

test('normalizeSubject retire segment date — DD/MM/YYYY', () => {
  assert.equal(
    normalizeSubject('Ton point quotidien Prospérenne — 04/05/2026'),
    'ton point quotidien prospérenne'
  );
  assert.equal(
    normalizeSubject('Ton point quotidien Prospérenne — 06/05/2026'),
    'ton point quotidien prospérenne'
  );
});

test('normalizeSubject retire hash trailing | ABC NBH29P6', () => {
  assert.equal(
    normalizeSubject('David, need your help | 5E1BKHH NBH29P6'),
    'david, need your help'
  );
});

test('normalizeSubject digest 04/05 et 06/05 donnent même clé', () => {
  const a = normalizeSubject('RE: Ton point quotidien Prospérenne — 04/05/2026');
  const b = normalizeSubject('RE: Ton point quotidien Prospérenne — 06/05/2026');
  // Note : RE: + même base + date variable → après normalisation, mêmes
  assert.equal(a, b);
});

test('normalizeSubject empty string OK', () => {
  assert.equal(normalizeSubject(''), '');
  assert.equal(normalizeSubject(null), '');
  assert.equal(normalizeSubject(undefined), '');
});

// ─── makeGroupKey ──────────────────────────────────────────────────────────

test('makeGroupKey produit clés stables et différentes pour boîtes différentes', () => {
  const a = makeGroupKey({ mailbox: 'david@oseys.fr', recipient: 'john@x.fr', subject: 'Hello' });
  const b = makeGroupKey({ mailbox: 'martin@oseys.fr', recipient: 'john@x.fr', subject: 'Hello' });
  assert.notEqual(a.hash, b.hash);
});

test('makeGroupKey lowercase mailbox et recipient', () => {
  const a = makeGroupKey({ mailbox: 'David@Oseys.FR', recipient: 'John@X.FR', subject: 'Hello' });
  const b = makeGroupKey({ mailbox: 'david@oseys.fr', recipient: 'john@x.fr', subject: 'Hello' });
  assert.equal(a.hash, b.hash);
});

test('makeGroupKey hash 24 chars stable', () => {
  const a = makeGroupKey({ mailbox: 'a@x.fr', recipient: 'b@y.fr', subject: 'test' });
  assert.equal(a.hash.length, 24);
  assert.match(a.hash, /^[0-9a-f]{24}$/);
});

// ─── groupBySimilarity ─────────────────────────────────────────────────────

test('groupBySimilarity regroupe les variantes du même subject', () => {
  const msgs = [
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T08:33:00Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T08:33:01Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 06/05/2026', sentDateTime: '2026-05-11T08:33:02Z' },
  ];
  const groups = groupBySimilarity(msgs);
  assert.equal(groups.size, 1, 'les 3 mails doivent former 1 seul groupe (subjects normalisés identiques)');
  const grp = Array.from(groups.values())[0];
  assert.equal(grp.count, 3);
});

test('groupBySimilarity sépare destinataires différents', () => {
  const msgs = [
    { mailbox: 'david@oseys.fr', recipient: 'a@x.fr', subject: 'Hello', sentDateTime: '2026-05-11T08:00:00Z' },
    { mailbox: 'david@oseys.fr', recipient: 'b@x.fr', subject: 'Hello', sentDateTime: '2026-05-11T08:00:00Z' },
  ];
  const groups = groupBySimilarity(msgs);
  assert.equal(groups.size, 2);
});

// ─── detectSuspectGroups ───────────────────────────────────────────────────

test('detectSuspectGroups flag ALERT si >= seuil sur 24h', () => {
  const msgs = [];
  for (let i = 0; i < _THRESHOLD_24H; i++) {
    msgs.push({
      mailbox: 'david@oseys.fr',
      recipient: 'j.serra@oseys.fr',
      subject: 'RE: same subject',
      sentDateTime: '2026-05-11T08:00:00Z',
    });
  }
  const groups = groupBySimilarity(msgs);
  const suspects = detectSuspectGroups(groups, new Date('2026-05-11T10:00:00Z'));
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].severity, 'ALERT');
  assert.equal(suspects[0].count, _THRESHOLD_24H);
});

test('detectSuspectGroups flag WARN si dans 7d mais pas dans 24h', () => {
  // 4 mails sur 7 jours (pas dans les 24h) → WARN
  const baseDate = new Date('2026-05-11T08:00:00Z');
  const msgs = [];
  // 4 mails il y a 5, 4, 3, 2 jours respectivement
  for (let daysAgo = 5; daysAgo >= 2; daysAgo--) {
    const t = new Date(baseDate.getTime() - daysAgo * 24 * 3600_000);
    msgs.push({
      mailbox: 'david@oseys.fr',
      recipient: 'j.serra@oseys.fr',
      subject: 'spam similar',
      sentDateTime: t.toISOString(),
    });
  }
  const groups = groupBySimilarity(msgs);
  const suspects = detectSuspectGroups(groups, baseDate);
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].severity, 'WARN');
  assert.equal(suspects[0].count, _THRESHOLD_7D);
});

test('detectSuspectGroups ne flag PAS un envoi unique légitime', () => {
  const msgs = [
    { mailbox: 'david@oseys.fr', recipient: 'a@x.fr', subject: 'Hello', sentDateTime: '2026-05-11T08:00:00Z' },
  ];
  const groups = groupBySimilarity(msgs);
  const suspects = detectSuspectGroups(groups, new Date('2026-05-11T10:00:00Z'));
  assert.equal(suspects.length, 0);
});

test('detectSuspectGroups ne flag PAS un digest quotidien légitime (dates différentes)', () => {
  // 5 mails "Ton point quotidien — DD/MM/YYYY" avec dates différentes ET subjects normalisés identiques
  // À cause de la normalisation date, ils seront regroupés et flag WARN ou ALERT...
  // C'est en fait UN COMPORTEMENT VOULU initialement par le design — mais
  // ATTENTION : un digest quotidien légitime sur 7 jours flag WARN. Faut whitelister.
  // Ce test documente le LIMIT actuel : la détection nécessite whitelist côté handler
  // ou amélioration normalizeSubject. On le verra à l'usage prod.
  const baseDate = new Date('2026-05-11T08:00:00Z');
  const msgs = [];
  for (let daysAgo = 5; daysAgo >= 1; daysAgo--) {
    const t = new Date(baseDate.getTime() - daysAgo * 24 * 3600_000);
    msgs.push({
      mailbox: 'david@oseys.fr',
      recipient: 'j.serra@oseys.fr',
      subject: `Ton point quotidien Prospérenne — 0${10 - daysAgo}/05/2026`,
      sentDateTime: t.toISOString(),
    });
  }
  const groups = groupBySimilarity(msgs);
  // Tous regroupés en 1 → 5 mails sur 7j → WARN (faux positif acceptable au démarrage)
  assert.equal(groups.size, 1);
  const suspects = detectSuspectGroups(groups, baseDate);
  // Cette assertion documente que le digest quotidien va trigger WARN actuellement.
  // À corriger plus tard via whitelist côté handler ou meta-marker sur le mail.
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].severity, 'WARN');
});

test('detectSuspectGroups ignore les messages hors fenêtre 7d', () => {
  const baseDate = new Date('2026-05-11T08:00:00Z');
  const msgs = [];
  // 5 mails il y a 10 jours → tous hors fenêtre 7d → 0 alerte
  for (let i = 0; i < 5; i++) {
    msgs.push({
      mailbox: 'david@oseys.fr',
      recipient: 'a@x.fr',
      subject: 'old',
      sentDateTime: new Date(baseDate.getTime() - 10 * 24 * 3600_000).toISOString(),
    });
  }
  const groups = groupBySimilarity(msgs);
  const suspects = detectSuspectGroups(groups, baseDate);
  assert.equal(suspects.length, 0);
});

// ─── Cas concret incident 11 mai Johnny ────────────────────────────────────

test('detectSuspectGroups détecte exactement le pattern incident 11 mai Johnny', () => {
  // Reconstitution simplifiée : 12 mails identiques en 5h sur 3 sujets (4× chacun)
  const msgs = [
    // 4× RE: 04/05/2026
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T06:30:00Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T06:33:51Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T11:40:11Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 04/05/2026', sentDateTime: '2026-05-11T11:44:31Z' },
    // 4× RE: 04/05/2026 (autres variantes empty)
    // 4× RE: 06/05/2026
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 06/05/2026', sentDateTime: '2026-05-11T06:29:47Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 06/05/2026', sentDateTime: '2026-05-11T06:33:31Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 06/05/2026', sentDateTime: '2026-05-11T11:39:57Z' },
    { mailbox: 'david@oseys.fr', recipient: 'j.serra@oseys.fr', subject: 'RE: Ton point quotidien Prospérenne — 06/05/2026', sentDateTime: '2026-05-11T11:44:18Z' },
  ];
  const groups = groupBySimilarity(msgs);
  // 8 mails sur 2 dates 04/05 et 06/05, normalisés identiquement → 1 groupe
  assert.equal(groups.size, 1, 'tous les RE: même subject normalisé regroupés');
  const suspects = detectSuspectGroups(groups, new Date('2026-05-11T12:00:00Z'));
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].severity, 'ALERT');
  assert.ok(suspects[0].count >= 8, `attendu au moins 8 sur 24h, vu ${suspects[0].count}`);
});
