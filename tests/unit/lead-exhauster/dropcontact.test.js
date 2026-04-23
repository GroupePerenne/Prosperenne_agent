/**
 * Tests unitaires — shared/lead-exhauster/adapters/dropcontact.js
 *
 * Squelette Jalon 1 : pas d'appel HTTP, juste la contract de l'adapter
 * + mapping qualification → confidence + validation d'entrée.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DropcontactAdapter,
  QUALIFICATION_MAP,
} = require('../../../shared/lead-exhauster/adapters/dropcontact');
const { validateAdapter } = require('../../../shared/lead-exhauster/adapters/interface');

// Nettoyage vars d'env pour chaque test — elles peuvent être héritées
// du shell. On force via opts du constructeur.
function makeAdapter(opts = {}) {
  return new DropcontactAdapter({ enabled: false, ...opts });
}

// ─── Contrat EmailExternalAdapter ──────────────────────────────────────────

test('DropcontactAdapter — respecte le contrat EmailExternalAdapter', () => {
  const adapter = makeAdapter();
  const { ok, errors } = validateAdapter(adapter);
  assert.equal(ok, true, `validateAdapter errors: ${errors.join('; ')}`);
  assert.equal(adapter.name, 'dropcontact');
  assert.equal(adapter.enabled, false);
  assert.equal(typeof adapter.resolve, 'function');
});

test('DropcontactAdapter — enabled=true sans apiKey lance à construction', () => {
  assert.throws(
    () => new DropcontactAdapter({ enabled: true, apiKey: '' }),
    /apiKey manquante/i,
  );
});

test('DropcontactAdapter — enabled=true avec apiKey OK', () => {
  const a = new DropcontactAdapter({ enabled: true, apiKey: 'test-key' });
  assert.equal(a.enabled, true);
  assert.equal(a.apiKey, 'test-key');
});

// ─── qualificationToConfidence ─────────────────────────────────────────────

test('qualificationToConfidence — mapping SPEC §5.3', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative_verified'), 0.98);
  assert.equal(DropcontactAdapter.qualificationToConfidence('nominative'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence('catch_all'), 0.50);
  assert.equal(DropcontactAdapter.qualificationToConfidence('role'), 0.30);
});

test('qualificationToConfidence — tolère casse et espaces', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('NOMINATIVE'), 0.95);
  assert.equal(DropcontactAdapter.qualificationToConfidence(' nominative '), 0.95);
});

test('qualificationToConfidence — qualifs inconnues → 0', () => {
  assert.equal(DropcontactAdapter.qualificationToConfidence('bogus'), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(''), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(null), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(undefined), 0);
  assert.equal(DropcontactAdapter.qualificationToConfidence(123), 0);
});

test('QUALIFICATION_MAP — figé, pas mutable', () => {
  assert.throws(() => {
    QUALIFICATION_MAP.nominative = 0.01;
  });
});

// ─── validateInput ─────────────────────────────────────────────────────────

test('validateInput — champs minimaux requis', () => {
  assert.deepEqual(
    DropcontactAdapter.validateInput({
      firstName: 'Jean',
      lastName: 'Dupont',
      companyName: 'Acme',
      siren: '123456789',
    }),
    [],
  );
});

test('validateInput — companyDomain accepté à la place de companyName', () => {
  const errors = DropcontactAdapter.validateInput({
    firstName: 'Jean',
    lastName: 'Dupont',
    companyDomain: 'acme.fr',
    siren: '123456789',
  });
  assert.deepEqual(errors, []);
});

test('validateInput — champs manquants remontent erreurs explicites', () => {
  const errors = DropcontactAdapter.validateInput({});
  assert.ok(errors.some((e) => e.includes('firstName')));
  assert.ok(errors.some((e) => e.includes('lastName')));
  assert.ok(errors.some((e) => e.includes('companyName')));
  assert.ok(errors.some((e) => e.includes('siren')));
});

test('validateInput — SIREN doit faire 9 chiffres', () => {
  const e1 = DropcontactAdapter.validateInput({
    firstName: 'Jean', lastName: 'Dupont', companyName: 'x', siren: '12345',
  });
  assert.ok(e1.some((e) => e.includes('siren')));

  const e2 = DropcontactAdapter.validateInput({
    firstName: 'Jean', lastName: 'Dupont', companyName: 'x', siren: 'abc123456',
  });
  assert.ok(e2.some((e) => e.includes('siren')));
});

// ─── resolve() stub Jalon 1 ────────────────────────────────────────────────

test('resolve — input invalide → error, cost_cents=0, pas d appel', async () => {
  const adapter = makeAdapter();
  const r = await adapter.resolve({ siren: 'bogus' });
  assert.equal(r.email, null);
  assert.equal(r.cost_cents, 0);
  assert.ok(r.error);
  assert.ok(r.providerRaw.validation_errors);
});

test('resolve — adapter désactivé → skip sans coût', async () => {
  const adapter = makeAdapter({ enabled: false });
  const r = await adapter.resolve({
    firstName: 'Jean', lastName: 'Dupont', companyName: 'Acme', siren: '123456789',
  });
  assert.equal(r.email, null);
  assert.equal(r.cost_cents, 0);
  assert.equal(r.providerRaw.skipped, 'disabled');
});

test('resolve — adapter activé → stub Jalon 1 retourne not_implemented', async () => {
  const adapter = makeAdapter({ enabled: true, apiKey: 'test-key' });
  const r = await adapter.resolve({
    firstName: 'Jean', lastName: 'Dupont', companyName: 'Acme', siren: '123456789',
  });
  assert.equal(r.email, null);
  assert.equal(r.cost_cents, 0);
  assert.equal(r.providerRaw.stub, 'not_implemented_jalon_1');
});
