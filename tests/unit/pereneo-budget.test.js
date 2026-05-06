'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateAnthropicCostCents,
  assertDailyBudget,
  trackSpend,
  modelFamily,
  BudgetExceededError,
  PROVIDER_TOTAL,
  _DEFAULT_DAILY_BUDGET_CENTS,
} = require('../../shared/pereneo-budget');

test('modelFamily — Sonnet par défaut', () => {
  assert.equal(modelFamily('claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelFamily(), 'sonnet');
  assert.equal(modelFamily(null), 'sonnet');
});

test('modelFamily — Haiku détecté', () => {
  assert.equal(modelFamily('claude-haiku-4-5'), 'haiku');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
});

test('estimateAnthropicCostCents — Sonnet par défaut (2000 in + 2000 out)', () => {
  // Sonnet EUR : 280 cents/Mtok input, 1395 cents/Mtok output
  // (2000 × 280 + 2000 × 1395) / 1e6 = 0.56 + 2.79 = 3.35 cents EUR
  const cost = estimateAnthropicCostCents({
    input_tokens: 2000,
    output_tokens: 2000,
    model: 'claude-sonnet-4-6',
  });
  assert.ok(Math.abs(cost - 3.35) < 0.01, `cost=${cost}, attendu 3.35`);
});

test('estimateAnthropicCostCents — Haiku environ 12x moins cher que Sonnet', () => {
  const haiku = estimateAnthropicCostCents({
    input_tokens: 2000,
    output_tokens: 2000,
    model: 'claude-haiku-4-5',
  });
  const sonnet = estimateAnthropicCostCents({
    input_tokens: 2000,
    output_tokens: 2000,
    model: 'claude-sonnet-4-6',
  });
  assert.ok(sonnet / haiku > 10, `ratio sonnet/haiku=${sonnet / haiku}`);
});

test('estimateAnthropicCostCents — 0 tokens = 0 cents', () => {
  assert.equal(estimateAnthropicCostCents({ input_tokens: 0, output_tokens: 0 }), 0);
  assert.equal(estimateAnthropicCostCents(), 0);
});

test('estimateAnthropicCostCents — override env var prix EUR', () => {
  process.env.ANTHROPIC_PRICE_SONNET_INPUT_CENTS_PER_MTOK_EUR = '600';
  process.env.ANTHROPIC_PRICE_SONNET_OUTPUT_CENTS_PER_MTOK_EUR = '3000';
  try {
    const cost = estimateAnthropicCostCents({
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      model: 'claude-sonnet-4-6',
    });
    assert.equal(cost, 3600);
  } finally {
    delete process.env.ANTHROPIC_PRICE_SONNET_INPUT_CENTS_PER_MTOK_EUR;
    delete process.env.ANTHROPIC_PRICE_SONNET_OUTPUT_CENTS_PER_MTOK_EUR;
  }
});

test('assertDailyBudget — utilise pereneo-total et period daily', async () => {
  let captured;
  const mockBudget = {
    canSpend: async (provider, cost, budget, opts) => {
      captured = { provider, cost, budget, opts };
      return { ok: true, spent: 100, budget: 1000 };
    },
  };
  const r = await assertDailyBudget({ budgetImpl: mockBudget });
  assert.equal(captured.provider, PROVIDER_TOTAL);
  assert.equal(captured.opts.period, 'daily');
  assert.equal(r.ok, true);
  assert.equal(r.spent_cents, 100);
});

test('assertDailyBudget — throw BudgetExceededError si dépassé', async () => {
  const mockBudget = {
    canSpend: async () => ({
      ok: false,
      spent: 1100,
      budget: 1000,
      reason: 'budget_exceeded',
    }),
  };
  await assert.rejects(
    () => assertDailyBudget({ budgetImpl: mockBudget }),
    (err) =>
      err instanceof BudgetExceededError &&
      err.code === 'BUDGET_EXCEEDED' &&
      err.provider === PROVIDER_TOTAL,
  );
});

test('assertDailyBudget — graceful degradation si canSpend throw', async () => {
  const mockBudget = {
    canSpend: async () => {
      throw new Error('Storage KO');
    },
  };
  const r = await assertDailyBudget({ budgetImpl: mockBudget });
  assert.equal(r.ok, true);
  assert.equal(r.degraded, true);
});

test('assertDailyBudget — défaut 10€ (1000 cents)', async () => {
  let captured;
  const mockBudget = {
    canSpend: async (_p, _c, budget) => {
      captured = budget;
      return { ok: true, spent: 0, budget };
    },
  };
  delete process.env.PEREENO_DAILY_BUDGET_CENTS_EUR;
  await assertDailyBudget({ budgetImpl: mockBudget });
  assert.equal(captured, _DEFAULT_DAILY_BUDGET_CENTS);
  assert.equal(captured, 1000);
});

test('trackSpend — écrit provider + pereneo-total', async () => {
  const calls = [];
  const mockBudget = {
    addSpend: async (provider, cost, opts) => {
      calls.push({ provider, cost, opts });
      return true;
    },
  };
  const r = await trackSpend({
    provider: 'anthropic',
    cost_cents: 3.6,
    budgetImpl: mockBudget,
  });
  assert.equal(r.persisted_provider, true);
  assert.equal(r.persisted_total, true);
  assert.equal(r.cost_cents, 4); // ceil(3.6)
  assert.equal(calls.length, 2);
  assert.equal(calls[0].provider, 'anthropic');
  assert.equal(calls[0].opts.period, 'daily');
  assert.equal(calls[1].provider, 'pereneo-total');
  assert.equal(calls[1].opts.period, 'daily');
});

test('trackSpend — sans provider → no-op', async () => {
  const calls = [];
  const mockBudget = {
    addSpend: async () => {
      calls.push(1);
      return true;
    },
  };
  const r = await trackSpend({ cost_cents: 100, budgetImpl: mockBudget });
  assert.equal(r.persisted_provider, false);
  assert.equal(r.persisted_total, false);
  assert.equal(calls.length, 0);
});

test('trackSpend — provider OK mais addSpend total throw', async () => {
  let providerCalls = 0;
  let totalCalls = 0;
  const mockBudget = {
    addSpend: async (provider) => {
      if (provider === 'anthropic') {
        providerCalls++;
        return true;
      }
      totalCalls++;
      throw new Error('Storage hiccup');
    },
  };
  const r = await trackSpend({
    provider: 'anthropic',
    cost_cents: 50,
    budgetImpl: mockBudget,
  });
  assert.equal(r.persisted_provider, true);
  assert.equal(r.persisted_total, false);
  assert.equal(providerCalls, 1);
  assert.equal(totalCalls, 1);
});

test('trackSpend — Math.ceil sur fractions', async () => {
  let captured;
  const mockBudget = {
    addSpend: async (_p, cost) => {
      captured = cost;
      return true;
    },
  };
  await trackSpend({
    provider: 'anthropic',
    cost_cents: 0.1,
    budgetImpl: mockBudget,
  });
  assert.equal(captured, 1); // 0.1 → ceil → 1
});
