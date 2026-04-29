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

test('validateCandidate — pas de SIREN, nom dans title + ville → cumul faible', async () => {
  const html = '<html><head><title>ACME SAS — Solutions logicielles</title></head>'
    + '<body><h1>ACME SAS</h1><p>Bureau Lyon, France</p></body></html>';
  const { stub } = makeFetcherStub([
    { url: 'https://acme.fr', status: 200, text: html },
  ]);
  const r = await validateCandidate(
    { url: 'https://acme.fr', targetSiren: '123456789', companyName: 'ACME SAS', ville: 'Lyon' },
    { fetcherImpl: stub },
  );
  assert.equal(r.proofType, 'weak_signals');
  // Base 0.40 + nom dans title 0.15 + ville 0.10 + domain like name 0.10 = 0.75
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

test('_internals.computeWeakSignals — base 0.40, plafonne à 0.80', () => {
  const { computeWeakSignals } = _internals;
  const r = computeWeakSignals({
    concatenated: 'ACME SAS Lyon 69003 ACME ACME ACME',
    homePage: { text: '<title>ACME SAS</title><h1>ACME SAS</h1>' },
    companyName: 'ACME SAS',
    ville: 'Lyon',
    codePostal: '69003',
    siteUrl: 'https://acme.fr',
  });
  assert.ok(r.confidence <= 0.80);
  assert.ok(r.confidence >= 0.40);
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
