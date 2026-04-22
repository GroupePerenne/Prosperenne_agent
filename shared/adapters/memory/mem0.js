/**
 * Adapter Mem0 — couche mémoire long terme pour les agents Pérennia.
 *
 * Trois types de mémoires, cloisonnés par namespace côté Mem0 via userId :
 *   - prospect/{siren}          → historique d'interaction et signaux par prospect
 *   - consultant/{consultant_id} → préférences et patterns du consultant
 *   - pattern/global             → patterns globaux partagés entre agents/tenants
 *
 * Variables d'env consommées :
 *   MEM0_API_KEY   (obligatoire sauf si un client est injecté)
 *   MEM0_BASE_URL  (optionnel — override endpoint, par défaut SaaS Cloud)
 *
 * Garanties :
 *   - Cloisonnement strict par namespace (préfixe du userId Mem0).
 *   - Audit trail : chaque retrieve/store produit un log structuré
 *     (method, namespace, id, success, ms, error?).
 *   - Graceful degradation : RateLimitError (429), NetworkError, timeouts
 *     et 5xx renvoient liste vide (retrieve) ou null (store) sans propager.
 *   - Mode d'extraction Mem0 différencié par type :
 *       storeProspect / storeConsultant → infer: true (consolidation native)
 *       storePattern                     → infer: false (pattern pré-agrégé)
 *   - Design prêt pour un futur préfixe tenant dans userId
 *     (ex: tenant:oseys:prospect:{siren}) et un deleteAllMemoriesForTenant().
 *
 * Note timeout : le SDK mem0ai@3.x instancie axios avec timeout 60s en dur
 * (non exposé via ClientOptions). Notre withTimeout plus court fait course
 * via Promise.race — pas de double countdown.
 */

const NS_PROSPECT = 'prospect';
const NS_CONSULTANT = 'consultant';
const NS_PATTERN = 'pattern';
const PATTERN_SCOPE_ID = 'global';

const DEFAULT_TIMEOUT_MS = 8000;

function noopLogger() {
  const fn = () => {};
  fn.info = () => {};
  fn.warn = () => {};
  fn.error = () => {};
  return fn;
}

function namespacedUserId(namespace, id) {
  if (!namespace) throw new Error('namespace required');
  if (id === undefined || id === null || id === '') {
    throw new Error('id required for namespace ' + namespace);
  }
  return `${namespace}:${id}`;
}

function isDegradableError(err) {
  if (!err) return false;
  const name = err.name || '';
  if (name === 'RateLimitError' || name === 'NetworkError' || name === 'AbortError') return true;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') return true;
  const status = err.status || err.statusCode || (err.response && err.response.status);
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out') || msg.includes('rate limit');
}

class Mem0Adapter {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]    Mem0 API key (défaut: process.env.MEM0_API_KEY).
   * @param {string} [opts.baseUrl]   Endpoint Mem0 (défaut: process.env.MEM0_BASE_URL).
   * @param {object} [opts.client]    Client injecté (tests). Si fourni, apiKey ignorée.
   * @param {Function|object} [opts.logger] context.log ou objet { info, warn, error }.
   * @param {number} [opts.timeoutMs] Timeout par appel (défaut 8000).
   */
  constructor(opts = {}) {
    const { apiKey, baseUrl, client, logger, timeoutMs } = opts;
    this.logger = normaliseLogger(logger);
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;

    if (client) {
      this.client = client;
    } else {
      const key = apiKey || process.env.MEM0_API_KEY;
      if (!key) throw new Error('Mem0Adapter: apiKey (ou MEM0_API_KEY) requis');
      const host = baseUrl || process.env.MEM0_BASE_URL;
      const { MemoryClient } = require('mem0ai');
      this.client = new MemoryClient(host ? { apiKey: key, host } : { apiKey: key });
    }
  }

  // ───────────────────────── RETRIEVE ─────────────────────────

  async retrieveProspect(siren, { query, topK = 20 } = {}) {
    return this._retrieve({
      namespace: NS_PROSPECT,
      id: String(siren),
      query: query || `prospect ${siren}`,
      topK
    });
  }

  async retrieveConsultant(consultantId, { query, topK = 20 } = {}) {
    return this._retrieve({
      namespace: NS_CONSULTANT,
      id: String(consultantId),
      query: query || `consultant ${consultantId}`,
      topK
    });
  }

  /**
   * Patterns globaux filtrés par contexte (sector, time_window).
   * @param {object} context  { sector?, time_window?, query? }
   * @param {object} [opts]   { topK }
   */
  async retrievePatterns(context = {}, { topK = 10 } = {}) {
    const metadata = {};
    if (context.sector) metadata.sector = context.sector;
    if (context.time_window) metadata.time_window = context.time_window;
    const query =
      context.query ||
      ['pattern', context.sector, context.time_window].filter(Boolean).join(' ') ||
      'pattern global';
    return this._retrieve({
      namespace: NS_PATTERN,
      id: PATTERN_SCOPE_ID,
      query,
      topK,
      metadata: Object.keys(metadata).length ? metadata : undefined
    });
  }

  // ────────────────────────── STORE ───────────────────────────

  async storeProspect(siren, memory) {
    if (!siren) throw new Error('storeProspect: siren requis');
    if (!memory) throw new Error('storeProspect: memory requis');
    // infer: false — Mem0 Cloud n'extrait rien d'un JSON stringifié même
    // en mode conversationnel simulé (validé par smoke test 21 avr 2026).
    // On stocke verbatim ; la consolidation inter-interactions se fera côté
    // agents ou via un batch dédié (Phase 2). Rétrocompatible avec infer:true
    // si on reformate en prose un jour.
    return this._store({
      namespace: NS_PROSPECT,
      id: String(siren),
      memory,
      metadata: {
        siren: String(siren),
        company_name: memory.company_name
      },
      infer: false
    });
  }

  async storeConsultant(consultantId, memory) {
    if (!consultantId) throw new Error('storeConsultant: consultantId requis');
    if (!memory) throw new Error('storeConsultant: memory requis');
    // infer: false — même raison que storeProspect (cf. commentaire ci-dessus).
    return this._store({
      namespace: NS_CONSULTANT,
      id: String(consultantId),
      memory,
      metadata: {
        consultant_id: String(consultantId),
        display_name: memory.display_name
      },
      infer: false
    });
  }

  async storePattern(pattern) {
    if (!pattern || !pattern.pattern_id) {
      throw new Error('storePattern: pattern.pattern_id requis');
    }
    const ctx = pattern.context || {};
    return this._store({
      namespace: NS_PATTERN,
      id: PATTERN_SCOPE_ID,
      memory: pattern,
      metadata: {
        pattern_id: pattern.pattern_id,
        scope: pattern.scope || 'global',
        sector: ctx.sector,
        time_window: ctx.time_window,
        confidence: pattern.confidence
      },
      infer: false
    });
  }

  // ───────────────────────── internals ────────────────────────

  async _retrieve({ namespace, id, query, topK, metadata }) {
    const userId = namespacedUserId(namespace, id);
    const started = Date.now();
    try {
      // SDK mem0ai@3.x : les entity params (userId, agentId, ...) sont interdits
      // en top-level sur search(), doivent être wrappés dans filters. La
      // metadata pour filtrage côté Mem0 vit aussi dans filters.
      const filters = { user_id: userId };
      if (metadata) filters.metadata = metadata;
      const searchOpts = { filters, topK };
      const res = await withTimeout(this.client.search(query, searchOpts), this.timeoutMs);
      const results = (res && res.results) || [];
      this._log('retrieve', namespace, id, true, null, { count: results.length, ms: Date.now() - started });
      return results;
    } catch (err) {
      const degraded = isDegradableError(err);
      this._log('retrieve', namespace, id, false, err, { degraded, ms: Date.now() - started });
      if (degraded) return [];
      throw err;
    }
  }

  async _store({ namespace, id, memory, metadata, infer = true }) {
    const userId = namespacedUserId(namespace, id);
    const started = Date.now();
    const cleanMeta = stripUndefined({ ...(metadata || {}), namespace });
    const messages = [{ role: 'user', content: JSON.stringify(memory) }];
    try {
      const res = await withTimeout(
        this.client.add(messages, { userId, metadata: cleanMeta, infer }),
        this.timeoutMs
      );
      this._log('store', namespace, id, true, null, { ms: Date.now() - started, infer });
      return res;
    } catch (err) {
      const degraded = isDegradableError(err);
      this._log('store', namespace, id, false, err, { degraded, ms: Date.now() - started, infer });
      if (degraded) return null;
      throw err;
    }
  }

  _log(method, namespace, id, success, err, extra) {
    const entry = {
      adapter: 'mem0',
      method,
      namespace,
      id,
      success,
      ts: new Date().toISOString(),
      ...(extra || {})
    };
    if (err) {
      entry.error = err.name || 'Error';
      entry.errorCode = err.errorCode;
      entry.message = err.message;
    }
    const line = `[mem0] ${method} ns=${namespace} id=${id} success=${success}`;
    if (success) this.logger.info(line, entry);
    else this.logger.warn(line, entry);
  }
}

function normaliseLogger(logger) {
  if (!logger) return noopLogger();
  // On wrappe chaque méthode dans une closure qui invoke dynamiquement.
  // Rationale : le SDK @azure/functions v4 utilise des private fields (#field) 
  // sur son InvocationContext.log. Un .bind() perd l'accès à ces fields quand 
  // la méthode est appelée depuis une autre closure (cas Mem0 singleton réutilisé
  // entre invocations). Un wrapper avec fallback console.log sur erreur évite 
  // tout crash silencieux.
  const safe = (fn, fallback) => (...args) => {
    if (!fn) return fallback(...args);
    try { return fn(...args); } 
    catch (e) { return fallback(...args); }
  };
  if (typeof logger === 'function') {
    return {
      info: safe(logger, console.log),
      warn: safe(logger.warn || logger, console.warn),
      error: safe(logger.error || logger, console.error)
    };
  }
  return {
    info: safe(logger.info, console.log),
    warn: safe(logger.warn || logger.info, console.warn),
    error: safe(logger.error || logger.warn || logger.info, console.error)
  };
}

function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let handle;
  const timer = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`Mem0 request timed out after ${ms}ms`);
      e.name = 'AbortError';
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(handle));
}

// ───────────────────────── singleton par warm container ─────────────────────
//
// Un seul MemoryClient SDK par instance Azure Functions : le constructor ping
// l'API à l'init (cf. mem0ai dist/index.js _initializeClient), autant
// mutualiser. Le logger est rebind à chaque invocation parce que context.log
// change par appel Azure.
//
// Retourne null si MEM0_API_KEY n'est pas configurée → le caller bascule
// proprement en "Mem0 off" (pas d'enrichissement, pas de store). Aucun throw.

let _cachedAdapter = null;

function getMem0(context) {
  if (!process.env.MEM0_API_KEY) return null;
  const logger = context && context.log ? context.log : undefined;
  if (!_cachedAdapter) {
    _cachedAdapter = new Mem0Adapter({ logger });
  } else if (logger) {
    _cachedAdapter.logger = normaliseLogger(logger);
  }
  return _cachedAdapter;
}

// Exposé pour les tests : permet de réinitialiser le singleton entre cas.
function _resetMem0Singleton() {
  _cachedAdapter = null;
}

module.exports = {
  Mem0Adapter,
  NS_PROSPECT,
  NS_CONSULTANT,
  NS_PATTERN,
  getMem0,
  _resetMem0Singleton
};
module.exports.default = Mem0Adapter;
