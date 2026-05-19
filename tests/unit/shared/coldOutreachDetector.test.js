'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  isInternalSender,
  detectColdOutreachSignals,
  buildInternalWhitelist,
  TRACKING_CODE_REGEX,
} = require('../../../shared/coldOutreachDetector');

// ============================================================
// isInternalSender
// ============================================================

test('isInternalSender — COMEX paul.rudler@oseys.fr retourne true', () => {
  assert.strictEqual(isInternalSender('paul.rudler@oseys.fr', {}), true);
});

test('isInternalSender — COMEX paul.rudler@perennereseau.fr retourne true', () => {
  assert.strictEqual(isInternalSender('paul.rudler@perennereseau.fr', {}), true);
});

test('isInternalSender — direction@perennereseau.fr retourne true', () => {
  assert.strictEqual(isInternalSender('direction@perennereseau.fr', {}), true);
});

test('isInternalSender — charli@pereneo.eu retourne true', () => {
  assert.strictEqual(isInternalSender('charli@pereneo.eu', {}), true);
});

test('isInternalSender — consultant via env var MORGANE_EMAIL', () => {
  const env = { MORGANE_EMAIL: 'm.dejessey@perennereseau.fr' };
  assert.strictEqual(isInternalSender('m.dejessey@perennereseau.fr', env), true);
});

test('isInternalSender — agent via env var MARTIN_EMAIL', () => {
  const env = { MARTIN_EMAIL: 'martin@perennereseau.fr' };
  assert.strictEqual(isInternalSender('martin@perennereseau.fr', env), true);
});

test('isInternalSender — cold outreach domain.top retourne false', () => {
  assert.strictEqual(isInternalSender('john@labsbizopia.top', {}), false);
});

test('isInternalSender — case insensitive', () => {
  assert.strictEqual(isInternalSender('PAUL.RUDLER@OSEYS.FR', {}), true);
});

test('isInternalSender — fromAddress vide retourne false', () => {
  assert.strictEqual(isInternalSender('', {}), false);
  assert.strictEqual(isInternalSender(null, {}), false);
  assert.strictEqual(isInternalSender(undefined, {}), false);
});

test('isInternalSender — env var manquante n\'ajoute rien à la whitelist', () => {
  const env = {}; // pas de MORGANE_EMAIL
  assert.strictEqual(isInternalSender('m.dejessey@perennereseau.fr', env), false);
});

test('buildInternalWhitelist — étend avec env vars consultants + agents', () => {
  const env = {
    MORGANE_EMAIL: 'm.dejessey@perennereseau.fr',
    JOHNNY_EMAIL: 'j.serra@perennereseau.fr',
    MARTIN_EMAIL: 'martin@perennereseau.fr',
  };
  const wl = buildInternalWhitelist(env);
  assert.strictEqual(wl.has('m.dejessey@perennereseau.fr'), true);
  assert.strictEqual(wl.has('j.serra@perennereseau.fr'), true);
  assert.strictEqual(wl.has('martin@perennereseau.fr'), true);
  assert.strictEqual(wl.has('paul.rudler@oseys.fr'), true); // hardcoded COMEX
});

// ============================================================
// detectColdOutreachSignals — B1 tracking codes
// ============================================================

test('B1 tracking_code — subject "Hey Roman RYEH2BT NBH29P6" → cold', () => {
  const r = detectColdOutreachSignals('Hey Roman RYEH2BT NBH29P6', 'a@b.com');
  assert.strictEqual(r.isCold, true);
  assert.ok(r.signals.includes('B1_tracking_code'));
});

test('B1 tracking_code — 7 codes réels mai 2026', () => {
  const realCodes = [
    'RYEH2BT NBH29P6',
    'MJNQTSW NBH29P6',
    'P4E64MX NBH29P6',
    '84RMYT4 NBH29P6',
    'HB4WMHS NBH29P6',
    '775JY6F NBH29P6',
    'P2ASFPJ NBH29P6',
  ];
  for (const code of realCodes) {
    const r = detectColdOutreachSignals(`Imperative Execution ${code}`, 'cold@example.com');
    assert.strictEqual(r.isCold, true, `Code ${code} doit être détecté`);
    assert.ok(r.signals.includes('B1_tracking_code'));
  }
});

test('B1 tracking_code — subject normal français ne match pas', () => {
  const subjects = [
    'Réponse à votre proposition',
    'RE: Des nouvelles de la Prospection',
    'Bonjour',
    'Re: Point quotidien Prospérenne',
    'Question sur votre démarche',
  ];
  for (const s of subjects) {
    const r = detectColdOutreachSignals(s, 'dirigeant@btp-92.fr');
    assert.strictEqual(r.isCold, false, `Subject "${s}" ne doit pas matcher`);
  }
});

test('B1 tracking_code — subject avec un seul bloc alphanumérique ne match pas', () => {
  const r = detectColdOutreachSignals('Order ABC12345', 'a@b.com');
  assert.strictEqual(r.isCold, false);
});

// ============================================================
// detectColdOutreachSignals — B2 TLD suspect
// ============================================================

test('B2 TLD suspect — .top détecté', () => {
  const r = detectColdOutreachSignals('Sujet', 'john@labsbizopia.top');
  assert.strictEqual(r.isCold, true);
  assert.ok(r.signals.some((s) => s.startsWith('B2_suspect_tld')));
});

test('B2 TLD suspect — 4 TLDs réels mesurés mai 2026', () => {
  const realTlds = [
    ['user@labsbizopia.top', '.top'],
    ['user@stratpartner.info', '.info'],
    ['user@telemedrn.co', '.co'],
    ['user@taxinnovatorfachkraefte.com', null], // .com pas suspect — voir test suivant
  ];
  for (const [addr, expectedTld] of realTlds) {
    const r = detectColdOutreachSignals('Sujet', addr);
    if (expectedTld) {
      assert.strictEqual(r.isCold, true, `${addr} doit être détecté`);
      assert.ok(r.signals.includes(`B2_suspect_tld:${expectedTld}`));
    }
  }
});

test('B2 TLD suspect — .com et .fr NE sont PAS suspects', () => {
  const r1 = detectColdOutreachSignals('Sujet', 'contact@example.com');
  assert.strictEqual(r1.isCold, false);
  const r2 = detectColdOutreachSignals('Sujet', 'dirigeant@entreprise-btp.fr');
  assert.strictEqual(r2.isCold, false);
});

test('B2 TLD suspect — case insensitive', () => {
  const r = detectColdOutreachSignals('Sujet', 'USER@LABSBIZOPIA.TOP');
  assert.strictEqual(r.isCold, true);
});

// ============================================================
// detectColdOutreachSignals — B3 headers
// ============================================================

test('B3 List-Unsubscribe — header présent → cold', () => {
  const headers = {
    internetMessageHeaders: [
      { name: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' },
    ],
  };
  const r = detectColdOutreachSignals('Sujet', 'a@b.com', headers);
  assert.strictEqual(r.isCold, true);
  assert.ok(r.signals.includes('B3_list_unsubscribe'));
});

test('B3 Precedence: bulk → cold', () => {
  const headers = {
    internetMessageHeaders: [
      { name: 'Precedence', value: 'bulk' },
    ],
  };
  const r = detectColdOutreachSignals('Sujet', 'a@b.com', headers);
  assert.strictEqual(r.isCold, true);
  assert.ok(r.signals.includes('B3_precedence_bulk'));
});

test('B3 — headers vides ne déclenche rien', () => {
  const r = detectColdOutreachSignals('Sujet normal', 'dirigeant@entreprise.fr', {});
  assert.strictEqual(r.isCold, false);
});

test('B3 — accepte aussi array direct (pas wrappé)', () => {
  const r = detectColdOutreachSignals('Sujet', 'a@b.com', [
    { name: 'List-Unsubscribe', value: '<mailto:x>' },
  ]);
  assert.strictEqual(r.isCold, true);
});

// ============================================================
// detectColdOutreachSignals — combinaisons + edge cases
// ============================================================

test('Combinaison B1+B2 — signals cumulatifs', () => {
  const r = detectColdOutreachSignals('Hey Roman RYEH2BT NBH29P6', 'a@b.top');
  assert.strictEqual(r.isCold, true);
  assert.ok(r.signals.includes('B1_tracking_code'));
  assert.ok(r.signals.includes('B2_suspect_tld:.top'));
});

test('Aucun signal — prospect légitime non détecté', () => {
  const r = detectColdOutreachSignals(
    'Re: Votre démarche commerciale',
    'dirigeant@bati-92.fr',
    {},
  );
  assert.strictEqual(r.isCold, false);
  assert.strictEqual(r.signals.length, 0);
});

test('Edge — subject null/undefined ne crash pas', () => {
  const r1 = detectColdOutreachSignals(null, 'a@b.com');
  assert.strictEqual(r1.isCold, false);
  const r2 = detectColdOutreachSignals(undefined, 'a@b.com');
  assert.strictEqual(r2.isCold, false);
});

test('Edge — fromAddress null ne crash pas', () => {
  const r = detectColdOutreachSignals('Subject', null);
  assert.strictEqual(r.isCold, false);
});

test('TRACKING_CODE_REGEX — figé contrat post-déploiement', () => {
  // Fige le regex actuel pour éviter dérive accidentelle
  assert.strictEqual(TRACKING_CODE_REGEX.source, '\\b[A-Z0-9]{6,8}\\s+[A-Z0-9]{6,8}\\b');
});
