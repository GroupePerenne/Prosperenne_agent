'use strict';

/**
 * Cap quotidien Pereneo GLOBAL multi-providers + tracking par provider.
 *
 * Décision Paul 6 mai 2026 : un seul plafond Pereneo (10€/jour par défaut)
 * cumulant TOUS les providers payants (Anthropic + Dropcontact + futurs).
 * Pas de cap individuel par provider — le cap est sur la SOMME journalière.
 *
 * Pour visibilité, on conserve un compteur par provider (PartitionKey=provider)
 * + un compteur global `pereneo-total` (PartitionKey='pereneo-total'). Toutes
 * en mode daily (RowKey=YYYYMMDD).
 *
 * Exposé :
 *   - assertDailyBudget(opts)          throw BudgetExceededError si pereneo-total dépassé
 *   - trackSpend({provider, cost_cents, opts})  addSpend provider + addSpend pereneo-total
 *   - estimateAnthropicCostCents({input_tokens, output_tokens, model})
 *
 * Override par env vars (cents EUR, défauts 2026-05) :
 *   PEREENO_DAILY_BUDGET_CENTS_EUR                           (def 1000 = 10€)
 *   ANTHROPIC_PRICE_SONNET_INPUT_CENTS_PER_MTOK_EUR          (def 280 ≈ $3 × 0.93)
 *   ANTHROPIC_PRICE_SONNET_OUTPUT_CENTS_PER_MTOK_EUR         (def 1395 ≈ $15 × 0.93)
 *   ANTHROPIC_PRICE_HAIKU_INPUT_CENTS_PER_MTOK_EUR           (def 23 ≈ $0.25 × 0.93)
 *   ANTHROPIC_PRICE_HAIKU_OUTPUT_CENTS_PER_MTOK_EUR          (def 116 ≈ $1.25 × 0.93)
 *
 * S'appuie sur shared/lead-exhauster/budget.js avec period='daily'.
 */

const PROVIDER_TOTAL = 'pereneo-total';

const DEFAULT_DAILY_BUDGET_CENTS = 1000; // 10€
const DEFAULT_ANTHROPIC_PRICES_CENTS_PER_MTOK = {
  sonnet: { input: 280, output: 1395 },
  haiku: { input: 23, output: 116 },
};

class BudgetExceededError extends Error {
  constructor({ spent_cents, budget_cents }) {
    super(
      `pereneo daily budget exceeded: ${spent_cents}/${budget_cents} cents EUR`,
    );
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.provider = PROVIDER_TOTAL;
    this.spent_cents = spent_cents;
    this.budget_cents = budget_cents;
  }
}

function getDailyBudgetCents() {
  const v = Number(process.env.PEREENO_DAILY_BUDGET_CENTS_EUR);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_BUDGET_CENTS;
}

function modelFamily(model) {
  if (!model) return 'sonnet';
  const lc = String(model).toLowerCase();
  if (lc.includes('haiku')) return 'haiku';
  return 'sonnet';
}

function getAnthropicPriceCentsPerMtok(family, direction) {
  const envKey = `ANTHROPIC_PRICE_${family.toUpperCase()}_${direction.toUpperCase()}_CENTS_PER_MTOK_EUR`;
  const v = Number(process.env[envKey]);
  if (Number.isFinite(v) && v >= 0) return v;
  return DEFAULT_ANTHROPIC_PRICES_CENTS_PER_MTOK[family][direction];
}

/**
 * Calcule le coût en cents EUR d'un appel Anthropic à partir de l'usage retourné.
 * @param {{input_tokens?:number, output_tokens?:number, model?:string}} arg
 * @returns {number} coût en cents EUR (peut être fractionnaire)
 */
function estimateAnthropicCostCents({
  input_tokens = 0,
  output_tokens = 0,
  model,
} = {}) {
  const family = modelFamily(model);
  const inRate = getAnthropicPriceCentsPerMtok(family, 'input');
  const outRate = getAnthropicPriceCentsPerMtok(family, 'output');
  return (input_tokens * inRate + output_tokens * outRate) / 1_000_000;
}

/**
 * Vérifie le budget Pereneo GLOBAL avant un appel payant. Throw si dépassé.
 *
 * Graceful degradation : si Storage indisponible, retourne degraded:true sans throw.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.budgetImpl]
 * @returns {Promise<{ok:boolean, spent_cents:number, budget_cents:number, degraded?:boolean}>}
 * @throws {BudgetExceededError}
 */
async function assertDailyBudget(opts = {}) {
  const budgetCents = getDailyBudgetCents();
  const impl = opts.budgetImpl || require('./lead-exhauster/budget');
  let res;
  try {
    res = await impl.canSpend(PROVIDER_TOTAL, 0, budgetCents, { period: 'daily' });
  } catch {
    return { ok: true, spent_cents: 0, budget_cents: budgetCents, degraded: true };
  }
  if (!res.ok) {
    throw new BudgetExceededError({
      spent_cents: res.spent,
      budget_cents: res.budget,
    });
  }
  return { ok: true, spent_cents: res.spent, budget_cents: res.budget };
}

/**
 * Enregistre une dépense pour un provider + incrémente le compteur global Pereneo.
 * Best effort, ne throw jamais.
 *
 * @param {Object} arg
 * @param {string} arg.provider
 * @param {number} arg.cost_cents             Coût en cents EUR (entier, on Math.ceil les fractions)
 * @param {Object} [arg.budgetImpl]
 * @returns {Promise<{cost_cents:number, persisted_provider:boolean, persisted_total:boolean}>}
 */
async function trackSpend({ provider, cost_cents, budgetImpl } = {}) {
  if (!provider) {
    return { cost_cents: 0, persisted_provider: false, persisted_total: false };
  }
  const impl = budgetImpl || require('./lead-exhauster/budget');
  const cents = Math.max(0, Math.ceil(cost_cents || 0));
  const dailyBudget = getDailyBudgetCents();

  let persistedProvider = false;
  let persistedTotal = false;
  try {
    persistedProvider = await impl.addSpend(provider, cents, {
      period: 'daily',
    });
  } catch {
    persistedProvider = false;
  }
  try {
    persistedTotal = await impl.addSpend(PROVIDER_TOTAL, cents, {
      period: 'daily',
      budgetCents: dailyBudget,
    });
  } catch {
    persistedTotal = false;
  }
  return {
    cost_cents: cents,
    persisted_provider: persistedProvider,
    persisted_total: persistedTotal,
  };
}

module.exports = {
  PROVIDER_TOTAL,
  BudgetExceededError,
  estimateAnthropicCostCents,
  assertDailyBudget,
  trackSpend,
  modelFamily,
  // Test helpers
  _DEFAULT_DAILY_BUDGET_CENTS: DEFAULT_DAILY_BUDGET_CENTS,
};
