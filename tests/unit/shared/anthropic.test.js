/**
 * Tests — shared/anthropic.js
 *
 * Vérifie :
 *   - exports des modèles (MODEL_SONNET, MODEL_HAIKU, MODEL_DEFAULT)
 *   - mode mock activable via LLM_ADAPTER=mock
 *   - setMockResponder pilote finement la réponse
 *   - default responder retourne un JSON mock déterministe
 *   - parseJson tolère les fences ```json
 *   - appel réel sans ANTHROPIC_API_KEY → throw explicite
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callClaude,
  parseJson,
  MODEL_SONNET,
  MODEL_HAIKU,
  MODEL_DEFAULT,
  isMockMode,
  setMockResponder,
  resetMockResponder,
} = require('../../../shared/anthropic');

test('exporte les constantes modèles', () => {
  assert.equal(MODEL_SONNET, 'claude-sonnet-4-6');
  assert.equal(MODEL_HAIKU, 'claude-haiku-4-5');
  assert.equal(MODEL_DEFAULT, MODEL_SONNET);
});

test('isMockMode reflète LLM_ADAPTER=mock', () => {
  const prev = process.env.LLM_ADAPTER;
  process.env.LLM_ADAPTER = 'mock';
  assert.equal(isMockMode(), true);
  delete process.env.LLM_ADAPTER;
  assert.equal(isMockMode(), false);
  if (prev !== undefined) process.env.LLM_ADAPTER = prev;
});

test('callClaude — mode mock default responder', async () => {
  const prev = process.env.LLM_ADAPTER;
  process.env.LLM_ADAPTER = 'mock';
  try {
    resetMockResponder();
    const res = await callClaude({
      system: 'sys',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    assert.equal(res.mocked, true);
    const parsed = parseJson(res.text);
    assert.equal(parsed._mock, true);
    assert.equal(parsed.system_len, 3);
    assert.equal(parsed.user_len, 'hello world'.length);
  } finally {
    resetMockResponder();
    if (prev !== undefined) process.env.LLM_ADAPTER = prev;
    else delete process.env.LLM_ADAPTER;
  }
});

test('callClaude — setMockResponder surcharge la sortie', async () => {
  const prev = process.env.LLM_ADAPTER;
  process.env.LLM_ADAPTER = 'mock';
  try {
    let captured = null;
    setMockResponder((req) => {
      captured = req;
      return { text: JSON.stringify({ ok: true, model: req.model }) };
    });
    const res = await callClaude({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      model: MODEL_HAIKU,
    });
    assert.equal(res.mocked, true);
    const parsed = parseJson(res.text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.model, MODEL_HAIKU);
    assert.equal(captured.model, MODEL_HAIKU);
    assert.equal(captured.system, 'sys');
  } finally {
    resetMockResponder();
    if (prev !== undefined) process.env.LLM_ADAPTER = prev;
    else delete process.env.LLM_ADAPTER;
  }
});

test('callClaude — responder invalide throw', async () => {
  const prev = process.env.LLM_ADAPTER;
  process.env.LLM_ADAPTER = 'mock';
  try {
    setMockResponder(() => ({ notext: true }));
    await assert.rejects(
      () => callClaude({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
      /LLM mock responder must return/,
    );
  } finally {
    resetMockResponder();
    if (prev !== undefined) process.env.LLM_ADAPTER = prev;
    else delete process.env.LLM_ADAPTER;
  }
});

test('callClaude — sans ANTHROPIC_API_KEY en mode réel → throw', async () => {
  const prevAdapter = process.env.LLM_ADAPTER;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_ADAPTER;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => callClaude({ system: 's', messages: [{ role: 'user', content: 'x' }] }),
      /ANTHROPIC_API_KEY/,
    );
  } finally {
    if (prevAdapter !== undefined) process.env.LLM_ADAPTER = prevAdapter;
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test('parseJson — tolère fences ```json', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('{"b":2}'), { b: 2 });
});
