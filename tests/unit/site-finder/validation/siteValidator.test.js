'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateCandidate,
  _internals,
} = require('../../../../shared/site-finder/validation/siteValidator');

function makeFetcherStub(pages) {
  const calls = [];
  const stub = async (url, opts) => {
    calls.push({ url, opts });
    return pages;
  };
  return { stub, calls };
}

test('validateCandidate — SIREN cible présent dans footer → confidence 0.99', async () => {
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 200, text: '<p>SIREN 123 456 789 — RCS Lyon</p>' },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789' },
    { fetcherImpl: stub },
  );
  assert.equal(r.confidence, 0.99);
  assert.equal(r.proofType, 'siren_match');
  assert.equal(r.proofDetails.matchedSirenOn, 'https://acme.fr');
});

test('validateCandidate — SIREN différent dans le texte → rejet (0.0)', async () => {
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 200, text: '<p>SIREN 999 888 777</p>' },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789' },
    { fetcherImpl: stub },
  );
  assert.equal(r.confidence, 0.0);
  assert.equal(r.proofType, 'siren_mismatch');
  assert.equal(r.proofDetails.rejectedReason, 'siren_mismatch');
  assert.match(r.proofDetails.weakSignals[0], /mismatched_siren=999888777/);
});

test('validateCandidate — pas de SIREN, nom dans title + ville + domaine ressemble → name_city_match (Option C)', async () => {
  const html = '<html><head><title>ACME SAS — Solutions logicielles</title></head>'
    + '<body><h1>ACME SAS</h1><p>Bureau Lyon, France</p></body></html>';
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 200, text: html },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789', companyName: 'ACME SAS', ville: 'Lyon' },
    { fetcherImpl: stub },
  );
  // acme.fr ressemble à "ACME SAS" + Lyon présent → bonus combinatoire Option C
  assert.equal(r.proofType, 'name_city_match');
  assert.ok(r.confidence > 0.85, `got ${r.confidence}`);
  assert.ok(r.signals.includes('company_name_in_title'));
  assert.ok(r.signals.includes('ville_in_text'));
  assert.ok(r.signals.includes('name_city_match_bonus'));
});

test('validateCandidate — pas de SIREN, nom dans title + ville, domaine différent → weak_signals pur', async () => {
  const html = '<html><head><title>ACME SAS — Solutions logicielles</title></head>'
    + '<body><h1>ACME SAS</h1><p>Bureau Lyon, France</p></body></html>';
  const { stub } = makeFetcherStub([
    { url: 'https://xyzrandom.fr', status: 200, text: html },
  ]);
  const r = await validateCandidate(
    { url: 'https://xyzrandom.fr', targetSiren: '123456789', companyName: 'ACME SAS', ville: 'Lyon' },
    { fetcherImpl: stub },
  );
  // domaine xyzrandom.fr ne ressemble pas à ACME SAS → pas de bonus, weak_signals max 0.80
  assert.equal(r.proofType, 'weak_signals');
  assert.ok(r.confidence > 0.5 && r.confidence <= 0.80, `got ${r.confidence}`);
  assert.ok(r.signals.includes('company_name_in_title'));
  assert.ok(r.signals.includes('ville_in_text'));
});

test('validateCandidate — toutes les pages 404 → site_unreachable', async () => {
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 404, text: '' },
    { url: 'https://acme.fr/mentions-legales', status: 404, text: '' },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789' },
    { fetcherImpl: stub },
  );
  assert.equal(r.confidence, 0);
  assert.equal(r.proofType, null);
  assert.equal(r.proofDetails.rejectedReason, 'site_unreachable');
});

test('validateCandidate — toutes les pages timeout → fetch_timeout', async () => {
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 0, text: '', error: 'fetch_timeout' },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789' },
    { fetcherImpl: stub },
  );
  assert.equal(r.confidence, 0);
  assert.equal(r.proofDetails.rejectedReason, 'fetch_timeout');
  assert.ok(r.signals.includes('fetch_timeout'));
});

test('validateCandidate — entrée invalide retourne confidence 0', async () => {
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: 'invalid' },
    { fetcherImpl: async () => [] },
  );
  assert.equal(r.confidence, 0);
  assert.equal(r.proofType, null);
});

test('validateCandidate — SIREN cible dans page secondaire (mentions)', async () => {
  const home = '<html><a href="/mentions-legales">Mentions</a></html>';
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 200, text: home },
    { url: 'https://acme.fr/mentions-legales', status: 200, text: 'SIREN 123 456 789' },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789' },
    { fetcherImpl: stub },
  );
  assert.equal(r.confidence, 0.99);
  assert.equal(r.proofDetails.matchedSirenOn, 'https://acme.fr/mentions-legales');
});

// ─── Internals ─────────────────────────────────────────────────────────────

test('_internals.computeWeakSignals — base 0.40, plafonne à 0.80 sans bonus combinatoire', () => {
  const { computeWeakSignals } = _internals;
  // Domaine xyzrandom.fr ne ressemble pas à ACME SAS → pas de name_city_match
  const r = computeWeakSignals({
    concatenated: 'ACME SAS Lyon 69003 ACME ACME ACME',
    homePage: { text: '<title>ACME SAS</title><h1>ACME SAS</h1>' },
    companyName: 'ACME SAS',
    ville: 'Lyon',
    codePostal: '69003',
    siteUrl: 'https://xyzrandom.fr',
  });
  assert.ok(r.confidence <= 0.80, `confidence attendue ≤ 0.80, obtenu ${r.confidence}`);
  assert.ok(r.confidence >= 0.40);
  assert.equal(r.nameCityMatch, false);
});

test('_internals.computeWeakSignals — bonus name_city_match quand domaine ressemble + ville présente', () => {
  const { computeWeakSignals, NAME_CITY_MATCH_CONFIDENCE } = _internals;
  const r = computeWeakSignals({
    concatenated: 'ACME SAS Lyon 69003',
    homePage: { text: '<title>ACME SAS</title>' },
    companyName: 'ACME SAS',
    ville: 'Lyon',
    siteUrl: 'https://acme.fr',
  });
  assert.equal(r.nameCityMatch, true);
  assert.equal(r.confidence, NAME_CITY_MATCH_CONFIDENCE);
  assert.ok(r.signals.includes('name_city_match_bonus'));
});

test('_internals.domainResemblesName — match exact lowercased', () => {
  const { domainResemblesName } = _internals;
  assert.equal(domainResemblesName('https://acme.fr', 'ACME'), true);
  assert.equal(domainResemblesName('https://acme-sas.fr', 'ACME SAS'), true);
});

test('_internals.domainResemblesName — refuse domaines très différents', () => {
  const { domainResemblesName } = _internals;
  assert.equal(domainResemblesName('https://google.fr', 'ACME'), false);
});

test('_internals.levenshtein — distance correcte', () => {
  const { levenshtein } = _internals;
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'abd'), 1);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('_internals.normalizeForCompare — accents et ponctuation', () => {
  const { normalizeForCompare } = _internals;
  assert.equal(normalizeForCompare('Éloïse Dupré'), 'eloise dupre');
  assert.equal(normalizeForCompare('ACME, SAS!'), 'acme sas');
});

// ──────────────── Multi-signaux RNE (15 mai 2026 — refonte multi-preuves) ────────────────

test('_internals.normalizePhone — formats variés normalisés', () => {
  const { normalizePhone } = _internals;
  assert.equal(normalizePhone('0612345678'), '0612345678');
  assert.equal(normalizePhone('06 12 34 56 78'), '0612345678');
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '0612345678');
  assert.equal(normalizePhone('06.12.34.56.78'), '0612345678');
  assert.equal(normalizePhone('06-12-34-56-78'), '0612345678');
  assert.equal(normalizePhone('0033612345678'), '0612345678');
});

test('_internals.matchPhoneOnPage — téléphone RNE retrouvé sur page (formats variés)', () => {
  const { matchPhoneOnPage } = _internals;
  const pageText = 'Contact: 06 12 34 56 78 - DAHAN & FILS plomberie Issy';
  assert.equal(matchPhoneOnPage(pageText, '0612345678'), true);
  assert.equal(matchPhoneOnPage(pageText, '+33612345678'), true);
  assert.equal(matchPhoneOnPage('autre tel: 0987654321', '0612345678'), false);
});

test('_internals.matchPersonNameOnPage — prénom + nom dans window 80 chars', () => {
  const { matchPersonNameOnPage } = _internals;
  const pageText = 'Notre équipe est dirigée par Jean Dupont, fondateur en 1998.';
  assert.equal(matchPersonNameOnPage(pageText, 'Jean', 'Dupont'), true);
  assert.equal(matchPersonNameOnPage(pageText, 'Jean', 'Martin'), false);
});

test('_internals.matchAddressFragment — numéro + rue', () => {
  const { matchAddressFragment } = _internals;
  const pageText = 'Adresse: 12 rue de la paix 75002 paris';
  assert.equal(matchAddressFragment(pageText, '12 RUE DE LA PAIX 75002 PARIS'), true);
  assert.equal(matchAddressFragment(pageText, '5 AVENUE DES CHAMPS 75008 PARIS'), false);
});

test('_internals.matchAddressFragment — fallback rue sans numéro', () => {
  const { matchAddressFragment } = _internals;
  const pageText = 'avenue de la république';
  assert.equal(matchAddressFragment(pageText, 'AVENUE DE LA REPUBLIQUE'), true);
});

test('computeWeakSignals — phone match RNE +0.20', () => {
  const { computeWeakSignals, BASE_WEAK_CONFIDENCE } = _internals;
  const r = computeWeakSignals({
    concatenated: 'Tel 06 12 34 56 78 ACME',
    homePage: { text: '<title>autre</title>' },
    companyName: 'ACME',
    ville: 'autre',
    siteUrl: 'https://random.fr',
    rne: { telephone: '0612345678' },
  });
  assert.ok(r.signals.includes('rne_phone_match'));
  assert.ok(r.confidence >= BASE_WEAK_CONFIDENCE + 0.20 - 0.001);
});

test('computeWeakSignals — phone + dirigeant RNE → multi_signal_match 0.90', () => {
  const { computeWeakSignals, MULTI_SIGNAL_MATCH_CONFIDENCE } = _internals;
  const r = computeWeakSignals({
    concatenated: 'Tel 06 12 34 56 78 - équipe : Jean Dupont fondateur',
    homePage: { text: '<title>random</title>' },
    companyName: 'ACME',
    ville: 'autre',
    siteUrl: 'https://random.fr',
    rne: {
      telephone: '0612345678',
      dirigeantFirstName: 'Jean',
      dirigeantLastName: 'Dupont',
    },
  });
  assert.equal(r.confidence, MULTI_SIGNAL_MATCH_CONFIDENCE);
  assert.equal(r.multiSignalMatch, true);
  assert.ok(r.signals.includes('multi_signal_rne_bonus'));
});

test('computeWeakSignals — sans rne reste comportement legacy', () => {
  const { computeWeakSignals, NAME_CITY_MATCH_CONFIDENCE } = _internals;
  const r = computeWeakSignals({
    concatenated: 'ACME SAS Lyon 69003',
    homePage: { text: '<title>ACME SAS</title>' },
    companyName: 'ACME SAS',
    ville: 'Lyon',
    siteUrl: 'https://acme.fr',
  });
  assert.equal(r.confidence, NAME_CITY_MATCH_CONFIDENCE);
  assert.equal(r.nameCityMatch, true);
});
