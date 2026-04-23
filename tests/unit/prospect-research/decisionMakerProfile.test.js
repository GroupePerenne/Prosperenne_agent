/**
 * Tests — shared/prospect-research/decisionMakerProfile.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDecisionMakerProfile,
  _buildPayload,
  _computeOverallConfidence,
  _deriveContactId,
} = require('../../../shared/prospect-research/decisionMakerProfile');

// ─── unités pures ────────────────────────────────────────────────────────

test('_deriveContactId — slug ASCII sûr', () => {
  assert.equal(_deriveContactId({ firstName: 'Paul', lastName: 'Rudler' }), 'paul-rudler');
  assert.equal(_deriveContactId({ firstName: 'Élodie', lastName: 'Martin' }), 'lodie-martin');
  assert.equal(_deriveContactId({ firstName: '', lastName: '' }), 'unknown-contact');
});

test('_computeOverallConfidence — aggrégation', () => {
  const strong = _computeOverallConfidence({
    career: { currentRole: 'CEO' },
    sources: { linkedin: true, press: true, companyTone: false },
    publications: ['post1'],
    pressMentions: ['presse1'],
    discScore: { primary: 'D', confidence: 0.8 },
  });
  assert.ok(strong >= 0.9);

  const weak = _computeOverallConfidence({
    career: { currentRole: null },
    sources: { linkedin: false, press: false, companyTone: false },
    publications: [],
    pressMentions: [],
    discScore: { primary: 'unknown', confidence: 0 },
  });
  assert.equal(weak, 0);
});

// ─── buildDecisionMakerProfile ──────────────────────────────────────────

test('buildDecisionMakerProfile — nom absent → null', async () => {
  assert.equal(await buildDecisionMakerProfile({}), null);
  assert.equal(await buildDecisionMakerProfile({ firstName: '' }), null);
});

test('buildDecisionMakerProfile — LinkedIn stub + pas d\'URL → dégradation propre', async () => {
  const discImpl = async () => ({
    primary: 'unknown',
    secondary: null,
    confidence: 0,
    tone: 'unknown',
    signals: [],
    inferredPainPoints: [],
    costCents: 0,
  });
  const res = await buildDecisionMakerProfile(
    { firstName: 'Paul', lastName: 'Rudler', role: 'CEO' },
    { discImpl },
  );
  assert.ok(res);
  assert.equal(res.contactId, 'paul-rudler');
  assert.equal(res.career.currentRole, 'CEO');
  assert.deepEqual(res.career.previousRoles, []);
  assert.deepEqual(res.publications, []);
  assert.equal(res.discScore.primary, 'unknown');
  assert.equal(res.discScore.confidence, 0);
  assert.equal(res.sources.linkedin, false);
  assert.equal(typeof res.elapsedMs, 'number');
});

test('buildDecisionMakerProfile — LinkedIn profil réel + DISC mock → payload riche', async () => {
  const linkedinImpl = async () => ({
    provider: 'proxycurl',
    status: 'ok',
    profile: {
      fullName: 'Paul Rudler',
      headline: 'CEO @ ACME — B2B growth',
      currentRole: 'CEO',
      currentCompany: 'ACME',
      tenure: '4 ans',
      experiences: [
        { role: 'COO', company: 'BetaCorp', start: '2019', end: '2022' },
        { role: 'Head of Sales', company: 'Gamma', start: '2015', end: '2019' },
      ],
      recentPosts: [
        { text: 'Notre trimestre : +22% ARR, félicitations équipe.' },
        { text: 'Retour sur la stratégie pricing qui a débloqué la croissance.' },
      ],
    },
    elapsedMs: 5,
  });
  const searchImpl = async () => ({ results: [], elapsedMs: 1, provider: 'stub', query: '' });
  const discImpl = async () => ({
    primary: 'D',
    secondary: 'I',
    confidence: 0.78,
    tone: 'startup',
    signals: ['ton direct', 'chiffres ARR'],
    inferredPainPoints: ['scalabilité équipe', 'pricing qui freine'],
    costCents: 2,
  });
  const res = await buildDecisionMakerProfile(
    {
      firstName: 'Paul',
      lastName: 'Rudler',
      role: 'CEO',
      companyName: 'ACME',
      decisionMakerLinkedInUrl: 'https://linkedin.com/in/paul-rudler',
    },
    { linkedinImpl, searchImpl, discImpl },
  );
  assert.ok(res);
  assert.equal(res.career.currentRole, 'CEO');
  assert.equal(res.career.tenure, '4 ans');
  assert.equal(res.career.previousRoles.length, 2);
  assert.ok(res.publications.length >= 1);
  assert.equal(res.discScore.primary, 'D');
  assert.equal(res.discScore.confidence, 0.78);
  assert.equal(res.sources.linkedin, true);
  assert.deepEqual(res.inferredPainPoints, ['scalabilité équipe', 'pricing qui freine']);
  assert.equal(res.costCents, 2);
  assert.ok(res.confidence > 0.7);
});

test('buildDecisionMakerProfile — DISC impl throw → fallback unknown, pas de crash', async () => {
  const discImpl = async () => {
    throw new Error('llm blew up');
  };
  const res = await buildDecisionMakerProfile(
    { firstName: 'Paul', lastName: 'Rudler', role: 'CEO' },
    { discImpl },
  );
  assert.ok(res);
  assert.equal(res.discScore.primary, 'unknown');
  assert.equal(res.discScore.confidence, 0);
  assert.equal(res.inferredPainPoints.length, 0);
});

test('buildDecisionMakerProfile — press mentions agrégées depuis searchImpl', async () => {
  const searchImpl = async () => ({
    results: [
      { title: 'Interview Paul Rudler', snippet: 'Il évoque la transformation B2B.' },
      { title: 'Citation', snippet: 'Il parle de résultats chiffrés.' },
    ],
    elapsedMs: 2,
    provider: 'bing',
    query: '',
  });
  const discImpl = async () => ({
    primary: 'I',
    confidence: 0.65,
    tone: 'commercial',
    signals: [],
    inferredPainPoints: [],
    costCents: 0,
  });
  const res = await buildDecisionMakerProfile(
    { firstName: 'Paul', lastName: 'Rudler', role: 'CEO', companyName: 'ACME' },
    { searchImpl, discImpl },
  );
  assert.equal(res.pressMentions.length, 2);
  assert.equal(res.sources.press, true);
});
