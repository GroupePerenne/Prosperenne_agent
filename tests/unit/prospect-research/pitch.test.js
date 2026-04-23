/**
 * Tests — shared/prospect-research/pitch.js
 *
 * Aucun appel Anthropic réel. llmImpl mockable ; on vérifie :
 *   - routage explicite vers Sonnet
 *   - adaptation DISC conditionnelle (shouldAdaptToneToDISC)
 *   - dégradation gracieuse (LLM throw, JSON invalide, output incomplet)
 *   - absence d'input → null
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPitch,
  _buildUserPrompt,
  _formatDISC,
  SYSTEM_PROMPT,
} = require('../../../shared/prospect-research/pitch');
const { MODEL_SONNET } = require('../../../shared/anthropic');

// ─── unités pures ────────────────────────────────────────────────────────

test('_formatDISC — shape lisible', () => {
  assert.equal(_formatDISC(null), '(non inféré)');
  assert.equal(_formatDISC({ primary: 'unknown', confidence: 0 }), 'unknown (confidence 0)');
  assert.equal(_formatDISC({ primary: 'D', confidence: 0.8 }), 'D confidence=0.80');
  assert.equal(
    _formatDISC({ primary: 'D', secondary: 'I', confidence: 0.85 }),
    'D/I confidence=0.85',
  );
});

test('_buildUserPrompt — DISC actif inclut la directive', () => {
  const prompt = _buildUserPrompt({
    company: { nomEntreprise: 'ACME' },
    decisionMaker: {
      fullName: 'Paul Rudler',
      career: { currentRole: 'CEO' },
      discScore: { primary: 'D', confidence: 0.75 },
    },
    discApplied: true,
  });
  assert.ok(prompt.includes('ADAPTATION DISC ACTIVE'));
  assert.ok(prompt.includes('ACME'));
  assert.ok(prompt.includes('Paul Rudler'));
});

test('_buildUserPrompt — DISC inactif → ton neutre', () => {
  const prompt = _buildUserPrompt({
    company: { nomEntreprise: 'ACME' },
    decisionMaker: null,
    discApplied: false,
  });
  assert.ok(prompt.includes('ADAPTATION DISC INACTIVE'));
  assert.ok(prompt.includes('FICHE DÉCIDEUR non disponible'));
});

test('SYSTEM_PROMPT — contient règles non négociables', () => {
  assert.ok(SYSTEM_PROMPT.includes('inventes RIEN'));
  assert.ok(SYSTEM_PROMPT.includes('DISC'));
  assert.ok(SYSTEM_PROMPT.includes('JSON valide'));
});

// ─── buildPitch ──────────────────────────────────────────────────────────

test('buildPitch — aucun input → null', async () => {
  assert.equal(await buildPitch({}), null);
  assert.equal(await buildPitch({ companyProfile: null, decisionMakerProfile: null }), null);
});

test('buildPitch — appelle Sonnet et retourne hook/angle/discAdaptation', async () => {
  let captured = null;
  const llmImpl = async (req) => {
    captured = req;
    return {
      text: JSON.stringify({
        hook: 'Vu votre levée récente, vous êtes probablement en pleine structuration commerciale.',
        angle: 'La croissance à 3 chiffres force à professionnaliser le pipeline plus tôt que prévu.',
        discAdaptation: 'Ton direct, focus ROI pour profil D confidence 0.8.',
      }),
    };
  };

  const res = await buildPitch(
    {
      companyProfile: {
        nomEntreprise: 'ACME',
        activity: 'Agence B2B',
        specialties: ['Node.js'],
        recentSignals: [{ type: 'fundraising', description: 'Levée 5M€', date: '2026-03' }],
      },
      decisionMakerProfile: {
        fullName: 'Paul Rudler',
        career: { currentRole: 'CEO' },
        discScore: { primary: 'D', confidence: 0.8, secondary: null },
        tone: 'startup',
        publications: [],
        pressMentions: [],
        inferredPainPoints: ['scalabilité équipe'],
      },
    },
    { llmImpl },
  );
  assert.ok(res);
  assert.equal(captured.model, MODEL_SONNET);
  assert.ok(captured.system.includes('consultant commercial B2B'));
  assert.ok(res.hook.length > 0);
  assert.ok(res.angle.length > 0);
  assert.ok(res.discAdaptation.length > 0);
  assert.equal(res.discApplied, true);
  assert.equal(res.tone, 'startup');
  assert.ok(res.costCents >= 0);
});

test('buildPitch — DISC confidence basse → discApplied false', async () => {
  const llmImpl = async () => ({
    text: JSON.stringify({
      hook: 'H',
      angle: 'A',
      discAdaptation: 'Ton neutre par défaut',
    }),
  });
  const res = await buildPitch(
    {
      companyProfile: { nomEntreprise: 'ACME', activity: 'X' },
      decisionMakerProfile: {
        fullName: 'Paul',
        career: { currentRole: 'CEO' },
        discScore: { primary: 'D', confidence: 0.2 },
        tone: 'unknown',
      },
    },
    { llmImpl },
  );
  assert.equal(res.discApplied, false);
});

test('buildPitch — decisionMaker absent mais companyProfile ok → neutre, pas null', async () => {
  const llmImpl = async () => ({
    text: JSON.stringify({
      hook: 'Neutre',
      angle: 'Angle',
      discAdaptation: 'Ton neutre',
    }),
  });
  const res = await buildPitch(
    {
      companyProfile: { nomEntreprise: 'ACME', activity: 'X' },
      decisionMakerProfile: null,
    },
    { llmImpl },
  );
  assert.ok(res);
  assert.equal(res.discApplied, false);
});

test('buildPitch — LLM throw → sortie avec error=llm_error', async () => {
  const llmImpl = async () => {
    throw new Error('sonnet outage');
  };
  const res = await buildPitch(
    {
      companyProfile: { nomEntreprise: 'ACME', activity: 'X' },
      decisionMakerProfile: null,
    },
    { llmImpl },
  );
  assert.equal(res.error, 'llm_error');
  assert.equal(res.hook, null);
});

test('buildPitch — JSON invalide → error=parse_error', async () => {
  const llmImpl = async () => ({ text: 'not a json' });
  const res = await buildPitch(
    {
      companyProfile: { nomEntreprise: 'ACME', activity: 'X' },
      decisionMakerProfile: null,
    },
    { llmImpl },
  );
  assert.equal(res.error, 'parse_error');
});

test('buildPitch — sortie LLM incomplète → error=incomplete_output', async () => {
  const llmImpl = async () => ({
    text: JSON.stringify({ hook: '', angle: null, discAdaptation: 'x' }),
  });
  const res = await buildPitch(
    {
      companyProfile: { nomEntreprise: 'ACME', activity: 'X' },
      decisionMakerProfile: null,
    },
    { llmImpl },
  );
  assert.equal(res.error, 'incomplete_output');
});
