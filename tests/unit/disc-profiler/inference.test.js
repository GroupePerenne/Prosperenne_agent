/**
 * Tests — shared/disc-profiler/inference.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { inferDISC, _normalizeDISC, _buildUserPrompt } = require('../../../shared/disc-profiler/inference');

// ─── _normalizeDISC ──────────────────────────────────────────────────────

test('_normalizeDISC — valeur ok conservée', () => {
  const res = _normalizeDISC({
    primary: 'D',
    secondary: 'I',
    confidence: 0.8,
    tone: 'corporate',
    signals: ['a', 'b'],
    inferredPainPoints: ['p1', 'p2'],
  });
  assert.equal(res.primary, 'D');
  assert.equal(res.secondary, 'I');
  assert.equal(res.confidence, 0.8);
  assert.equal(res.tone, 'corporate');
  assert.deepEqual(res.signals, ['a', 'b']);
  assert.deepEqual(res.inferredPainPoints, ['p1', 'p2']);
});

test('_normalizeDISC — primary invalide → unknown', () => {
  const res = _normalizeDISC({ primary: 'Z', confidence: 0.9 });
  assert.equal(res.primary, 'unknown');
  assert.equal(res.confidence, 0, 'unknown force confidence à 0');
});

test('_normalizeDISC — secondary invalide → null', () => {
  const res = _normalizeDISC({ primary: 'D', secondary: 'X', confidence: 0.5 });
  assert.equal(res.secondary, null);
});

test('_normalizeDISC — confidence clamp [0,1]', () => {
  assert.equal(_normalizeDISC({ primary: 'D', confidence: 2 }).confidence, 1);
  assert.equal(_normalizeDISC({ primary: 'D', confidence: -0.1 }).confidence, 0);
  assert.equal(_normalizeDISC({ primary: 'D', confidence: 'foo' }).confidence, 0);
});

test('_normalizeDISC — tone invalide → unknown', () => {
  assert.equal(_normalizeDISC({ primary: 'I', tone: 'bizarre' }).tone, 'unknown');
});

test('_normalizeDISC — signals et painPoints filtrés + tronqués', () => {
  const res = _normalizeDISC({
    primary: 'D',
    confidence: 0.6,
    signals: ['ok', '', null, 42, 'ok2', 'ok3', 'ok4', 'ok5', 'ok6', 'ok7', 'ok8', 'ok9'],
    inferredPainPoints: ['pain1', 'pain2', 'pain3', 'pain4'],
  });
  assert.equal(res.signals.length, 8);
  assert.equal(res.inferredPainPoints.length, 3);
});

// ─── _buildUserPrompt ────────────────────────────────────────────────────

test('_buildUserPrompt — inclut rôle et signaux formatés', () => {
  const prompt = _buildUserPrompt(
    { role: 'CEO', linkedin: { currentCompany: 'ACME' } },
    [
      { type: 'role', text: 'CEO & Fondateur' },
      { type: 'headline', text: 'Je construis la croissance B2B' },
    ],
  );
  assert.ok(prompt.includes('Rôle cible : CEO'));
  assert.ok(prompt.includes('ACME'));
  assert.ok(prompt.includes('[role]'));
  assert.ok(prompt.includes('[headline]'));
  assert.ok(prompt.includes('JSON strict'));
});

// ─── inferDISC ───────────────────────────────────────────────────────────

test('inferDISC — signaux insuffisants → unknown sans appel LLM', async () => {
  let called = false;
  const res = await inferDISC(
    { role: 'X' }, // 1 seul signal, rôle trop court en plus
    { llmImpl: () => { called = true; return { text: '{}' }; } },
  );
  assert.equal(res.primary, 'unknown');
  assert.equal(res.confidence, 0);
  assert.equal(res.signals.length, 0);
  assert.equal(called, false);
});

test('inferDISC — LLM renvoie classification valide', async () => {
  const llmImpl = async () => ({
    text: JSON.stringify({
      primary: 'D',
      secondary: 'C',
      confidence: 0.82,
      tone: 'corporate',
      signals: ['Rôle de décideur', 'Langage orienté résultats'],
      inferredPainPoints: ['Plafonnement croissance', 'Besoin de leviers rapides'],
    }),
  });
  const res = await inferDISC(
    {
      role: 'Directeur Général',
      linkedin: {
        headline: 'DG ACME — transformation commerciale B2B',
        about: 'Je pilote la croissance. Focus ROI. Pas de bullshit.',
      },
    },
    { llmImpl },
  );
  assert.equal(res.primary, 'D');
  assert.equal(res.secondary, 'C');
  assert.equal(res.confidence, 0.82);
  assert.equal(res.tone, 'corporate');
  assert.ok(res.signals.length >= 1);
  assert.ok(res.inferredPainPoints.length >= 1);
  assert.equal(typeof res.elapsedMs, 'number');
  assert.ok(res.costCents >= 0);
});

test('inferDISC — LLM throw → fallback unknown avec error', async () => {
  const llmImpl = async () => {
    throw new Error('anthropic 500');
  };
  const res = await inferDISC(
    {
      role: 'Directeur Général',
      linkedin: { headline: 'DG — B2B growth' },
    },
    { llmImpl },
  );
  assert.equal(res.primary, 'unknown');
  assert.equal(res.confidence, 0);
  assert.equal(res.error, 'llm_error');
});

test('inferDISC — LLM renvoie JSON invalide → unknown + parse_error', async () => {
  const llmImpl = async () => ({ text: 'not a json' });
  const res = await inferDISC(
    {
      role: 'Directeur Général',
      linkedin: { headline: 'DG — growth' },
    },
    { llmImpl },
  );
  assert.equal(res.primary, 'unknown');
  assert.equal(res.error, 'parse_error');
});

test('inferDISC — primary unknown dans la réponse LLM → confidence forcée à 0', async () => {
  const llmImpl = async () => ({
    text: JSON.stringify({ primary: 'unknown', confidence: 0.9, tone: 'unknown', signals: [] }),
  });
  const res = await inferDISC(
    {
      role: 'Dirigeant',
      linkedin: { headline: 'headline qui fait plus de 6 caracteres' },
    },
    { llmImpl },
  );
  assert.equal(res.primary, 'unknown');
  assert.equal(res.confidence, 0);
});
