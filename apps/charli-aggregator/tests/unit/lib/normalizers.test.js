/**
 * Tests — apps/charli-aggregator/lib/normalizers
 *
 * Vérifie :
 *   - anonymizeSummary : email → "le dirigeant de SIREN XXX" (avec metadata.siren)
 *   - anonymizeSummary : email → "le dirigeant de l'entreprise" (sans siren)
 *   - anonymizeSummary : pas d'email → inchangé
 *   - ensureAbsoluteDate : déjà date ISO ou format français → inchangé
 *   - ensureAbsoluteDate : pas de date → préfixe "Le DD MOIS YYYY"
 *   - normalizeDavidEvent : metadata Option B complète + content sémantique pur
 *   - normalizeEvent : agent inconnu → throw
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEvent,
  _internals,
} = require('../../../lib/normalizers');

// ─── anonymizeSummary ───────────────────────────────────────────────────────

test('anonymizeSummary — email présent + metadata.siren : remplace par "le dirigeant de SIREN XXX"', () => {
  const out = _internals.anonymizeSummary(
    'Email envoyé à marc.dupont@example.fr suite à la qualification.',
    { siren: '12345678901234' },
  );
  assert.equal(out, 'Email envoyé à le dirigeant de SIREN 12345678901234 suite à la qualification.');
  assert.equal(/marc\.dupont/.test(out), false);
});

test('anonymizeSummary — email présent SANS metadata.siren : remplace par "le dirigeant de l\'entreprise"', () => {
  const out = _internals.anonymizeSummary('Réponse positive de marc@oseys.fr.', {});
  assert.equal(out, 'Réponse positive de le dirigeant de l\'entreprise.');
});

test('anonymizeSummary — plusieurs emails : tous anonymisés', () => {
  const out = _internals.anonymizeSummary(
    'Échange entre alice@a.com et bob@b.fr.',
    { siren: '999' },
  );
  assert.equal(/alice|bob/.test(out), false);
});

test('anonymizeSummary — pas d\'email : inchangé', () => {
  const summary = 'Le dirigeant a répondu favorablement.';
  assert.equal(_internals.anonymizeSummary(summary, {}), summary);
});

// ─── ensureAbsoluteDate ─────────────────────────────────────────────────────

test('ensureAbsoluteDate — summary contient déjà date ISO YYYY-MM-DD : inchangé', () => {
  const summary = 'Le 2026-04-30, le dirigeant a été qualifié.';
  assert.equal(_internals.ensureAbsoluteDate(summary, '2026-04-30T15:00:00Z'), summary);
});

test('ensureAbsoluteDate — summary contient date format français : inchangé', () => {
  const summary = 'Le 30 avril 2026, RDV pris.';
  assert.equal(_internals.ensureAbsoluteDate(summary, '2026-04-30T15:00:00Z'), summary);
});

test('ensureAbsoluteDate — summary sans date : préfixe "Le DD MOIS YYYY"', () => {
  const summary = 'Le dirigeant a été qualifié niveau 2.';
  const out = _internals.ensureAbsoluteDate(summary, '2026-04-30T15:00:00Z');
  assert.match(out, /^Le 30 avril 2026, /);
  assert.match(out, /qualifié niveau 2/);
});

test('formatAbsoluteDateFr — formats variés', () => {
  assert.equal(_internals.formatAbsoluteDateFr('2026-01-05T12:00:00Z'), 'Le 5 janvier 2026');
  assert.equal(_internals.formatAbsoluteDateFr('2026-12-31T23:59:59Z'), 'Le 31 décembre 2026');
  assert.equal(_internals.formatAbsoluteDateFr('not-a-date'), null);
});

// ─── normalizeDavidEvent ────────────────────────────────────────────────────

test('normalizeDavidEvent — content sémantique pur, metadata Option B complète', () => {
  const event = {
    agent: 'david',
    eventType: 'qualif_done',
    summary: 'Le dirigeant SIREN 12345678901234 a été qualifié niveau 2.',
    eventId: 'evt-uuid-123',
    timestamp: '2026-04-30T15:00:00Z',
    metadata: { dealId: 42, consultantId: 'morgane', siren: '12345678901234' },
  };
  const out = _internals.normalizeDavidEvent(event);

  // Content sémantique pur : pas de préfixe [date source: X], date absolue garantie
  assert.equal(out.content.includes('['), false, 'pas de préfixe [date source]');
  assert.match(out.content, /2026-04-30|30 avril 2026/);

  // Metadata Option B
  assert.equal(out.metadata.date, '2026-04-30');
  assert.equal(out.metadata.source, 'david-fa');
  assert.equal(out.metadata.agent, 'david');
  assert.equal(out.metadata.event_type, 'qualif_done');
  assert.equal(out.metadata.event_id, 'evt-uuid-123');
  // Champs contextuels du caller préservés
  assert.equal(out.metadata.dealId, 42);
  assert.equal(out.metadata.consultantId, 'morgane');
  assert.equal(out.metadata.siren, '12345678901234');
});

test('normalizeDavidEvent — anonymisation email avec siren disponible', () => {
  const event = {
    agent: 'david',
    eventType: 'email_sent',
    summary: 'Mail envoyé à marc.dupont@example.fr.',
    eventId: 'evt-x',
    timestamp: '2026-04-30T09:00:00Z',
    metadata: { siren: '111' },
  };
  const out = _internals.normalizeDavidEvent(event);
  assert.equal(/marc\.dupont/.test(out.content), false);
  assert.match(out.content, /SIREN 111/);
});

// ─── normalizeEvent dispatch ────────────────────────────────────────────────

test('normalizeEvent — agent david : dispatch vers normalizeDavidEvent', () => {
  const out = normalizeEvent({
    agent: 'david',
    eventType: 'email_sent',
    summary: 'Test.',
    eventId: 'e1',
    timestamp: '2026-04-30T10:00:00Z',
    metadata: {},
  });
  assert.equal(out.metadata.agent, 'david');
});

test('normalizeEvent — agent inconnu : throw explicite', () => {
  assert.throws(
    () => normalizeEvent({ agent: 'unknown-agent', eventType: 'x', summary: 'y', eventId: 'z', timestamp: '2026-04-30T10:00:00Z' }),
    /No normalizer registered.*unknown-agent/,
  );
});
