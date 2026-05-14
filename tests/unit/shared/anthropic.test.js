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

// ──────────────── Instrumentation budget Anthropic (Task #13) ────────────────

const {
  _traceAnthropicCall,
  _budgetMonthKey,
  _resetBudgetClientForTests,
  _setBudgetClientForTests,
} = require('../../../shared/anthropic');

test('_budgetMonthKey — format YYYYMM UTC', () => {
  const d = new Date(Date.UTC(2026, 4, 14, 23, 0, 0));
  assert.equal(_budgetMonthKey(d), '202605');
});

test('_traceAnthropicCall — Storage indispo → no-op silencieux', async () => {
  _resetBudgetClientForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    // Doit ne pas throw
    await _traceAnthropicCall({ model: 'sonnet', inputTokens: 100, outputTokens: 50 });
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('_traceAnthropicCall — première entry du mois → createEntity avec valeurs initiales', async () => {
  let created = null;
  const mockClient = {
    getEntity: async () => { const e = new Error('not found'); e.statusCode = 404; throw e; },
    createEntity: async (e) => { created = e; return true; },
    updateEntity: async () => { throw new Error('should not update'); },
  };
  _setBudgetClientForTests(mockClient);
  await _traceAnthropicCall({ model: 'sonnet', inputTokens: 100, outputTokens: 50 });
  assert.ok(created);
  assert.equal(created.partitionKey, 'anthropic');
  assert.equal(created.calls, 1);
  assert.equal(created.input_tokens, 100);
  assert.equal(created.output_tokens, 50);
  assert.equal(created.last_model, 'sonnet');
});

test('_traceAnthropicCall — entry existante → updateEntity avec cumul', async () => {
  let updated = null;
  const mockClient = {
    getEntity: async () => ({
      partitionKey: 'anthropic', rowKey: '202605',
      calls: 5, input_tokens: 1000, output_tokens: 500,
    }),
    createEntity: async () => { throw new Error('should not create'); },
    updateEntity: async (e) => { updated = e; return true; },
  };
  _setBudgetClientForTests(mockClient);
  await _traceAnthropicCall({ model: 'haiku', inputTokens: 200, outputTokens: 100 });
  assert.ok(updated);
  assert.equal(updated.calls, 6);
  assert.equal(updated.input_tokens, 1200);
  assert.equal(updated.output_tokens, 600);
  assert.equal(updated.last_model, 'haiku');
});

test('_traceAnthropicCall — getEntity throw non-404 → catch best-effort silencieux', async () => {
  const mockClient = {
    getEntity: async () => { throw new Error('storage_500'); },
    createEntity: async () => { throw new Error('should not'); },
    updateEntity: async () => { throw new Error('should not'); },
  };
  _setBudgetClientForTests(mockClient);
  // Doit ne pas throw
  await _traceAnthropicCall({ model: 'x', inputTokens: 0, outputTokens: 0 });
});

test('_traceAnthropicCall — input/output tokens manquants → 0 par défaut', async () => {
  let created = null;
  const mockClient = {
    getEntity: async () => { const e = new Error('nf'); e.statusCode = 404; throw e; },
    createEntity: async (e) => { created = e; return true; },
  };
  _setBudgetClientForTests(mockClient);
  await _traceAnthropicCall({ model: 'sonnet' });
  assert.equal(created.input_tokens, 0);
  assert.equal(created.output_tokens, 0);
});
