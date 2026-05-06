/**
 * Wrapper Anthropic Claude API.
 *
 * Usages :
 *   - David (orchestration conversationnelle avec les consultants)
 *   - Générateur de séquence Martin/Mila (JSON strict, sans mémoire)
 *   - prospect-profiler (Haiku 4.5 extraction factuelle, Sonnet 4.6 accroche)
 *
 * Modèles supportés :
 *   MODEL_SONNET = 'claude-sonnet-4-6'  (défaut, narratif, plus cher)
 *   MODEL_HAIKU  = 'claude-haiku-4-5'   (extraction factuelle, rapide, bon marché)
 *
 * Mode mock (tests) :
 *   process.env.LLM_ADAPTER=mock  → callClaude renvoie un stub déterministe
 *   sans appel réseau. Permet aux tests unitaires/intégration de tourner sans
 *   ANTHROPIC_API_KEY et sans coût. Le stub peut être piloté finement via
 *   setMockResponder(fn) : fn({ model, system, messages, maxTokens, temperature })
 *   doit retourner { text } ou une promesse.
 *
 * Variable d'env requise en mode réel : ANTHROPIC_API_KEY
 */

const API_URL = 'https://api.anthropic.com/v1/messages';

const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU = 'claude-haiku-4-5';
const MODEL_DEFAULT = MODEL_SONNET;

// Phase 1 observability : hardstop budget Pereneo + tracking dépenses + log structuré
const {
  assertDailyBudget,
  trackSpend,
  estimateAnthropicCostCents,
  BudgetExceededError,
} = require('./pereneo-budget');

// ─── Mode mock (tests) ──────────────────────────────────────────────────────

let _mockResponder = defaultMockResponder;

function isMockMode() {
  return process.env.LLM_ADAPTER === 'mock';
}

function defaultMockResponder({ system, messages }) {
  // Stub JSON neutre : permet aux tests qui parsent la sortie de fonctionner
  // sans avoir à surcharger explicitement le responder. Les tests qui ont
  // besoin d'une réponse précise appelleront setMockResponder() avant.
  const lastUser = Array.isArray(messages) && messages.length
    ? String(messages[messages.length - 1].content || '')
    : '';
  return {
    text: JSON.stringify({
      _mock: true,
      system_len: (system || '').length,
      user_len: lastUser.length,
    }),
  };
}

/**
 * Override le responder mock. Utile dans les tests pour simuler une réponse
 * LLM précise (extraction entreprise, inférence DISC, accroche).
 * @param {Function|null} fn  (request) => { text } | Promise<{ text }>.
 *                            Passer null pour revenir au responder par défaut.
 */
function setMockResponder(fn) {
  _mockResponder = typeof fn === 'function' ? fn : defaultMockResponder;
}

function resetMockResponder() {
  _mockResponder = defaultMockResponder;
}

// ─── Appel réel ou mock ─────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.system       Prompt système
 * @param {Array}  opts.messages     [{ role, content }, ...]
 * @param {string} [opts.model]      Modèle (défaut: claude-sonnet-4-6)
 * @param {number} [opts.maxTokens]  Défaut 2000
 * @param {number} [opts.temperature] Défaut 0.7
 * @param {string} [opts.operation]  Label métier (companyProfile, pitch, classify…) pour KQL filter
 * @param {object} [opts.context]    InvocationContext FA (pour log via context.log)
 * @param {object} [opts.budgetImpl] Override pour tests (canSpend/addSpend mocks)
 * @param {object} [opts.fetchImpl]  Override fetch pour tests
 * @returns {Promise<{ text: string, raw?: object, mocked?: boolean, usage?: object, cost_cents?: number }>}
 * @throws {BudgetExceededError} si pereneo-total daily budget dépassé
 */
async function callClaude({
  system,
  messages,
  model = MODEL_DEFAULT,
  maxTokens = 2000,
  temperature = 0.7,
  operation,
  context,
  budgetImpl,
  fetchImpl,
} = {}) {
  if (isMockMode()) {
    const res = await _mockResponder({ system, messages, model, maxTokens, temperature });
    if (!res || typeof res.text !== 'string') {
      throw new Error('LLM mock responder must return { text: string }');
    }
    return { text: res.text, raw: res.raw || null, mocked: true };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  // Hardstop budget Pereneo GLOBAL (10€/jour par défaut). Throw avant l'appel réseau.
  await assertDailyBudget({ budgetImpl });

  const fetchFn = fetchImpl || fetch;
  const res = await fetchFn(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Tracking dépense (best effort, ne throw pas) + log structuré pour AI/KQL
  const usage = (data && data.usage) || { input_tokens: 0, output_tokens: 0 };
  const costCents = estimateAnthropicCostCents({
    input_tokens: usage.input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    model,
  });
  await trackSpend({ provider: 'anthropic', cost_cents: costCents, budgetImpl });

  const logFn = context && typeof context.log === 'function' ? context.log : console.log;
  try {
    logFn('anthropic.call ' + JSON.stringify({
      operation: operation || 'unknown',
      model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cost_cents: Math.round(costCents * 100) / 100,
    }));
  } catch {
    // logging best effort, ne casse pas l'appel
  }

  return { text, raw: data, usage, cost_cents: costCents };
}

/**
 * Parse un JSON embedded dans une réponse Claude (tolérant aux ```json fences).
 */
function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

module.exports = {
  callClaude,
  parseJson,
  MODEL_SONNET,
  MODEL_HAIKU,
  MODEL_DEFAULT,
  BudgetExceededError,
  // Exposés pour les tests uniquement
  isMockMode,
  setMockResponder,
  resetMockResponder,
};
