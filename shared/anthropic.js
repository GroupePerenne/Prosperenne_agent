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

// ─── Instrumentation budget Anthropic — plan v3.1 P3 + Task #13 ─────────
// Trace chaque appel réel dans Azure Table `Budgets` (PK='anthropic',
// RK=YYYYMM). Best-effort : aucune erreur de trace ne fait remonter sur
// callClaude (préserve continuité business si Storage indispo).
// Routine CC `anthropic-quota-watch.sh` lit cette table 4×/jour et alerte
// si projection mensuelle >80% du cap.

const BUDGETS_TABLE = process.env.BUDGETS_TABLE || 'Budgets';

function _budgetMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

let _budgetClient = null;
function _getBudgetClient() {
  if (_budgetClient !== null) return _budgetClient;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) { _budgetClient = false; return null; }
  try {
    const { TableClient } = require('@azure/data-tables');
    _budgetClient = TableClient.fromConnectionString(conn, BUDGETS_TABLE);
    return _budgetClient;
  } catch (_) {
    _budgetClient = false;
    return null;
  }
}

function _resetBudgetClientForTests() { _budgetClient = null; }
function _setBudgetClientForTests(c) { _budgetClient = c; }

async function _traceAnthropicCall({ model, inputTokens, outputTokens }) {
  const client = _getBudgetClient();
  if (!client) return;
  const monthKey = _budgetMonthKey();
  try {
    let entity = null;
    try {
      entity = await client.getEntity('anthropic', monthKey);
    } catch (err) {
      if (err && err.statusCode !== 404) throw err;
    }
    const prev = entity || { partitionKey: 'anthropic', rowKey: monthKey, calls: 0, input_tokens: 0, output_tokens: 0 };
    const next = {
      partitionKey: 'anthropic',
      rowKey: monthKey,
      calls: (Number(prev.calls) || 0) + 1,
      input_tokens: (Number(prev.input_tokens) || 0) + (Number(inputTokens) || 0),
      output_tokens: (Number(prev.output_tokens) || 0) + (Number(outputTokens) || 0),
      last_model: String(model || ''),
      lastUpdatedAt: new Date().toISOString(),
    };
    if (entity) {
      await client.updateEntity(next, 'Merge');
    } else {
      await client.createEntity(next);
    }
  } catch (_) {
    // Best-effort : ne jamais faire crasher callClaude.
  }
}

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
 * @returns {Promise<{ text: string, raw?: object, mocked?: boolean }>}
 */
async function callClaude({
  system,
  messages,
  model = MODEL_DEFAULT,
  maxTokens = 2000,
  temperature = 0.7,
}) {
  if (isMockMode()) {
    const res = await _mockResponder({ system, messages, model, maxTokens, temperature });
    if (!res || typeof res.text !== 'string') {
      throw new Error('LLM mock responder must return { text: string }');
    }
    return { text: res.text, raw: res.raw || null, mocked: true };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  // Prompt caching ephemeral sur system prompt — Anthropic facture 10% du
  // tarif input pour ~5min après le 1er appel. Économie ~60-70% sur les
  // appels en batch (générateur séquence, profil prospect) où le system
  // prompt VP 3 couches est identique d'un prospect à l'autre. Minimum
  // 1024 tokens (Sonnet) / 2048 (Haiku) pour que le cache s'active ; en
  // dessous, l'API ignore silencieusement et applique le tarif standard.
  const systemForApi = typeof system === 'string' && system.length > 0
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  const res = await fetch(API_URL, {
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
      system: systemForApi,
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

  // Trace budget — best-effort, fire-and-forget pour ne pas bloquer.
  const usage = data && data.usage ? data.usage : {};
  _traceAnthropicCall({
    model,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  }).catch(() => {});

  return { text, raw: data };
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
  // Tests + lecture externe :
  _traceAnthropicCall,
  _budgetMonthKey,
  _resetBudgetClientForTests,
  _setBudgetClientForTests,
  BUDGETS_TABLE,
  parseJson,
  MODEL_SONNET,
  MODEL_HAIKU,
  MODEL_DEFAULT,
  // Exposés pour les tests uniquement
  isMockMode,
  setMockResponder,
  resetMockResponder,
};
