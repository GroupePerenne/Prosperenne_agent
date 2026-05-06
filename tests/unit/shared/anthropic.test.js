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

// ─── Phase 1 observability : assertDailyBudget + trackSpend dans callClaude ──

const { BudgetExceededError } = require('../../../shared/anthropic');

function withRealMode(fn) {
  return async () => {
    const prevAdapter = process.env.LLM_ADAPTER;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_ADAPTER;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
    try {
      await fn();
    } finally {
      if (prevAdapter !== undefined) process.env.LLM_ADAPTER = prevAdapter;
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  };
}

function makeAnthropicResponseFetch(usage = { input_tokens: 100, output_tokens: 200 }) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: 'response text' }],
      usage,
    }),
    text: async () => '',
  });
}

test('callClaude — path réel : appelle assertDailyBudget AVANT fetch',
  withRealMode(async () => {
    const calls = [];
    const budgetImpl = {
      canSpend: async (provider, _cost, budget, opts) => {
        calls.push({ kind: 'canSpend', provider, budget, period: opts.period });
        return { ok: true, spent: 0, budget };
      },
      addSpend: async (provider, cost, opts) => {
        calls.push({ kind: 'addSpend', provider, cost, period: opts.period });
        return true;
      },
    };
    const fetchImpl = makeAnthropicResponseFetch();
    const res = await callClaude({
      system: 'sys',
      messages: [{ role: 'user', content: 'x' }],
      operation: 'companyProfile',
      budgetImpl,
      fetchImpl,
    });
    assert.equal(res.text, 'response text');
    // canSpend doit être appelé en premier
    assert.equal(calls[0].kind, 'canSpend');
    assert.equal(calls[0].provider, 'pereneo-total');
    assert.equal(calls[0].period, 'daily');
    // Puis 2 addSpend (provider + total)
    const adds = calls.filter((c) => c.kind === 'addSpend');
    assert.equal(adds.length, 2);
    assert.equal(adds[0].provider, 'anthropic');
    assert.equal(adds[1].provider, 'pereneo-total');
  }),
);

test('callClaude — BudgetExceededError propagé, fetch jamais appelé',
  withRealMode(async () => {
    let fetchCalled = false;
    const budgetImpl = {
      canSpend: async () => ({
        ok: false,
        spent: 1100,
        budget: 1000,
        reason: 'budget_exceeded',
      }),
      addSpend: async () => true,
    };
    const fetchImpl = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) };
    };
    await assert.rejects(
      () =>
        callClaude({
          system: 's',
          messages: [{ role: 'user', content: 'x' }],
          budgetImpl,
          fetchImpl,
        }),
      (err) => err instanceof BudgetExceededError && err.code === 'BUDGET_EXCEEDED',
    );
    assert.equal(fetchCalled, false);
  }),
);

test('callClaude — log structuré "anthropic.call" via context.log',
  withRealMode(async () => {
    const logs = [];
    const ctx = { log: (...args) => logs.push(args.join(' ')) };
    const budgetImpl = {
      canSpend: async () => ({ ok: true, spent: 0, budget: 1000 }),
      addSpend: async () => true,
    };
    const fetchImpl = makeAnthropicResponseFetch({ input_tokens: 1000, output_tokens: 500 });
    const res = await callClaude({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      operation: 'pitch',
      context: ctx,
      budgetImpl,
      fetchImpl,
    });
    assert.ok(res.cost_cents > 0);
    const line = logs.find((l) => l.startsWith('anthropic.call '));
    assert.ok(line, 'log "anthropic.call" doit être émis');
    const payload = JSON.parse(line.replace('anthropic.call ', ''));
    assert.equal(payload.operation, 'pitch');
    assert.equal(payload.input_tokens, 1000);
    assert.equal(payload.output_tokens, 500);
    assert.ok(payload.cost_cents > 0);
  }),
);

test('callClaude — mode mock NE TOUCHE PAS pereneo-budget',
  async () => {
    const prev = process.env.LLM_ADAPTER;
    process.env.LLM_ADAPTER = 'mock';
    try {
      let touched = false;
      const budgetImpl = {
        canSpend: async () => {
          touched = true;
          return { ok: false };
        },
        addSpend: async () => {
          touched = true;
          return true;
        },
      };
      resetMockResponder();
      await callClaude({
        system: 'sys',
        messages: [{ role: 'user', content: 'x' }],
        budgetImpl,
      });
      assert.equal(touched, false);
    } finally {
      resetMockResponder();
      if (prev !== undefined) process.env.LLM_ADAPTER = prev;
      else delete process.env.LLM_ADAPTER;
    }
  },
);
