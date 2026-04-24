/**
 * Tests — shared/prospect-research/companyProfile.js
 *
 * Orchestration couche A. On injecte les trois sources + le LLM pour
 * valider le contrat sans appel réseau ni LLM réel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCompanyProfile,
  _buildCorpus,
  _computeConfidence,
  _isEmpty,
  _normalizeSignalType,
} = require('../../../shared/prospect-research/companyProfile');

// ─── unités pures ─────────────────────────────────────────────────────────

test('_normalizeSignalType — restreint à la whitelist', () => {
  assert.equal(_normalizeSignalType('hiring'), 'hiring');
  assert.equal(_normalizeSignalType('press'), 'press');
  assert.equal(_normalizeSignalType('autre_truc'), 'other');
  assert.equal(_normalizeSignalType(null), 'other');
  assert.equal(_normalizeSignalType(42), 'other');
});

test('_buildCorpus — concatène identité + pages + signaux', () => {
  const corpus = _buildCorpus({
    apiGouv: {
      nomEntreprise: 'ACME',
      activiteDeclaree: 'Conseil info',
      codeNaf: '62.02A',
      commune: 'Lyon',
    },
    scrape: {
      texts: [
        { url: 'https://acme.fr/', text: 'Bienvenue sur ACME' },
        { url: 'https://acme.fr/clients', text: 'Nos clients' },
      ],
    },
    search: {
      results: [{ title: 'Levée ACME', snippet: '5M€ levés', source: 'lesechos.fr' }],
    },
    companyName: 'ACME',
  });
  assert.ok(corpus.includes('ACME'));
  assert.ok(corpus.includes('Conseil info'));
  assert.ok(corpus.includes('Bienvenue sur ACME'));
  assert.ok(corpus.includes('[PAGE https://acme.fr/]'));
  assert.ok(corpus.includes('[SIGNAUX ACTUALITÉ]'));
  assert.ok(corpus.includes('Levée ACME'));
});

test('_buildCorpus — tronque au budget', () => {
  const big = 'x'.repeat(30000);
  const corpus = _buildCorpus({
    apiGouv: null,
    scrape: { texts: [{ url: '/', text: big }] },
    search: null,
    companyName: 'ACME',
  });
  assert.ok(corpus.length <= 24000);
});

test('_computeConfidence — aggrège les sources', () => {
  const strong = _computeConfidence({
    activity: 'x',
    specialties: ['a'],
    mainClients: ['b'],
    recentSignals: [{}],
    sources: { apiGouv: true, website: true, search: true },
  });
  assert.ok(strong >= 0.9);

  const empty = _computeConfidence({
    activity: null,
    specialties: [],
    mainClients: [],
    recentSignals: [],
    sources: { apiGouv: false, website: false, search: false },
  });
  assert.equal(empty, 0);
});

test('_isEmpty — true si rien d\'exploitable', () => {
  assert.equal(
    _isEmpty({
      activity: null,
      specialties: [],
      mainClients: [],
      recentSignals: [],
      nomEntreprise: null,
    }),
    true,
  );
  assert.equal(
    _isEmpty({
      activity: 'ok',
      specialties: [],
      mainClients: [],
      recentSignals: [],
      nomEntreprise: null,
    }),
    false,
  );
});

// ─── buildCompanyProfile ──────────────────────────────────────────────────

test('buildCompanyProfile — siren invalide → null', async () => {
  assert.equal(await buildCompanyProfile({ siren: 'abc' }), null);
  assert.equal(await buildCompanyProfile({ siren: '12345' }), null);
  assert.equal(await buildCompanyProfile({}), null);
});

test('buildCompanyProfile — chemin happy path, 3 sources + LLM mock', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME SAS',
    activiteDeclaree: 'Programmation informatique',
    codeNaf: '62.01Z',
    commune: 'Paris',
    estActive: true,
    trancheEffectif: '11',
  });
  const scraperImpl = async () => ({
    domain: 'acme.fr',
    texts: [
      {
        url: 'https://acme.fr/',
        text:
          'Nous sommes ACME, agence de développement. Nous construisons des applications web sur-mesure pour des PME et ETI, en Node.js et Azure, avec un focus sur la fiabilité et la sécurité. Nos clients incluent La Poste et Decathlon. Équipe de 12 personnes à Paris.',
      },
    ],
    visitedPages: [{ url: 'https://acme.fr/', status: 200, charCount: 260 }],
    elapsedMs: 10,
  });
  const searchImpl = async () => ({
    query: '"ACME SAS"',
    provider: 'stub',
    results: [],
    elapsedMs: 1,
  });
  const llmImpl = async ({ messages }) => ({
    text: JSON.stringify({
      activity: 'Agence de développement',
      specialties: ['Node.js', 'Azure'],
      mainClients: ['La Poste', 'Decathlon'],
      recentSignals: [
        {
          type: 'hiring',
          description: '3 offres dev Node.js ouvertes',
          sourceUrl: null,
          date: null,
        },
      ],
    }),
  });

  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME SAS', companyDomain: 'acme.fr' },
    { apiGouvImpl, scraperImpl, searchImpl, llmImpl, skipCache: true },
  );

  assert.ok(res);
  assert.equal(res.siren, '123456789');
  assert.equal(res.nomEntreprise, 'ACME SAS');
  assert.equal(res.activity, 'Agence de développement'); // extracted prime sur apiGouv si présent
  assert.deepEqual(res.specialties, ['Node.js', 'Azure']);
  assert.deepEqual(res.mainClients, ['La Poste', 'Decathlon']);
  assert.equal(res.recentSignals.length, 1);
  assert.equal(res.recentSignals[0].type, 'hiring');
  assert.equal(res.sources.apiGouv, true);
  assert.equal(res.sources.website, true);
  assert.equal(res.sources.search, false);
  assert.ok(res.confidence > 0.5);
  assert.equal(res.cached, false);
  assert.equal(typeof res.elapsedMs, 'number');
  assert.equal(typeof res.costCents, 'number');
});

test('buildCompanyProfile — LLM échoue → fallback sur apiGouv seul', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'Conseil',
    codeNaf: '70.22Z',
    commune: 'Lyon',
    estActive: true,
  });
  const scraperImpl = async () => ({
    texts: [{ url: 'https://acme.fr/', text: 'Site ACME. Nous accompagnons des PME.' }],
    visitedPages: [],
    elapsedMs: 0,
  });
  const searchImpl = async () => ({ query: '', results: [], elapsedMs: 0, provider: 'stub' });
  const llmImpl = async () => {
    throw new Error('LLM timeout');
  };
  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME', companyDomain: 'acme.fr' },
    { apiGouvImpl, scraperImpl, searchImpl, llmImpl, skipCache: true },
  );
  assert.ok(res);
  // Pas d'extraction → on retombe sur activiteDeclaree
  assert.equal(res.activity, 'Conseil');
  assert.deepEqual(res.specialties, []);
  assert.deepEqual(res.mainClients, []);
  assert.deepEqual(res.recentSignals, []);
});

test('buildCompanyProfile — site down, LLM ok → extraction sur identité seule OU fallback apiGouv', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'Activité officielle',
    codeNaf: '70.22Z',
    estActive: true,
  });
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ query: '', results: [], elapsedMs: 0, provider: 'stub' });
  // corpus < 200 chars → pas d'appel LLM (pas d'extraction)
  let llmCalled = false;
  const llmImpl = async () => {
    llmCalled = true;
    return { text: '{}' };
  };
  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME', companyDomain: 'acme.fr' },
    { apiGouvImpl, scraperImpl, searchImpl, llmImpl, skipCache: true },
  );
  assert.ok(res);
  assert.equal(res.sources.website, false);
  // Activité déclarée utilisée en fallback
  assert.equal(res.activity, 'Activité officielle');
  // Pas d'appel LLM car corpus trop mince
  assert.equal(llmCalled, false);
});

test('buildCompanyProfile — tout échoue → null', async () => {
  const apiGouvImpl = async () => null;
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ results: [], elapsedMs: 0 });
  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME', companyDomain: 'acme.fr' },
    { apiGouvImpl, scraperImpl, searchImpl, skipCache: true },
  );
  assert.equal(res, null);
});

test('buildCompanyProfile — domain vide → skip scraping sans bloquer', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'Conseil',
  });
  const scraperImpl = async () => {
    throw new Error('should not be called');
  };
  const searchImpl = async () => ({ query: '', results: [], elapsedMs: 0, provider: 'stub' });
  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME' }, // pas de companyDomain
    { apiGouvImpl, scraperImpl, searchImpl, skipCache: true },
  );
  assert.ok(res);
  assert.equal(res.sources.website, false);
});

test('buildCompanyProfile — LLM renvoie du JSON invalide → extraction null, fallback apiGouv', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'ACME',
    activiteDeclaree: 'Fallback',
  });
  const scraperImpl = async () => ({
    texts: [{ url: 'https://acme.fr/', text: 'x'.repeat(500) }],
    visitedPages: [],
    elapsedMs: 0,
  });
  const searchImpl = async () => ({ query: '', results: [], elapsedMs: 0, provider: 'stub' });
  const llmImpl = async () => ({ text: 'not a json at all' });
  const res = await buildCompanyProfile(
    { siren: '123456789', companyName: 'ACME', companyDomain: 'acme.fr' },
    { apiGouvImpl, scraperImpl, searchImpl, llmImpl, skipCache: true },
  );
  assert.ok(res);
  assert.equal(res.activity, 'Fallback');
  assert.deepEqual(res.specialties, []);
});
