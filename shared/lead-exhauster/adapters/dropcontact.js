'use strict';

/**
 * Adapter Dropcontact — cascade externe de résolution email.
 *
 * Décision Paul : Dropcontact > Hunter pour le pilote Pérenne (match rate
 * 55% vs 33%, bounce 0.9% vs 11.2%, souveraineté FR/RGPD). Budget V1 =
 * 24€/mois sur le plan Starter 1000 crédits. Pay-on-success : pas de
 * coût facturé si email non trouvé (cost_cents=0 dans ce cas).
 *
 * Implémentation (Jalon 3) :
 *   - HTTP POST /batch avec apiKey dans body (format API V1 Dropcontact)
 *   - Polling GET /batch/{request_id}?apiKey=... avec backoff exponentiel
 *   - Timeout global 15s par résolution (soumission + polling)
 *   - Budget check préalable via Azure Table `Budgets` (lecture puis
 *     write atomique à succès)
 *   - Circuit breaker in-memory : 3 échecs consécutifs → ouvert 10 min,
 *     toutes requêtes retournent unresolvable sans contact Dropcontact
 *   - Mapping qualification → confidence (table figée V1, SPEC §5.3)
 *   - Pay-on-success : cost_cents=0 si email=null dans la réponse
 *
 * La policy budget + circuit breaker vit **dans l'adapter** et non chez
 * l'orchestrateur : l'orchestrateur appelle `resolve()` de façon naïve,
 * l'adapter protège le budget / le SLA / le provider.
 *
 * Self-check contrat au chargement pour détecter les régressions
 * d'interface en amont de la prod.
 */

const { validateAdapter } = require('./interface');
const { canSpend, addSpend } = require('../budget');

// ─── Mapping qualification Dropcontact → confidence (SPEC §5.3) ────────────
// Source : doc Dropcontact API + observation marché. Table figée V1, à
// surcharger seulement si Dropcontact introduit de nouvelles qualifications
// ou si nos relevés post-Jalon 4 montrent une dérive > 10% sur un bucket.
const QUALIFICATION_MAP = Object.freeze({
  nominative_verified: 0.98,
  nominative: 0.95,
  catch_all: 0.50,
  role: 0.30,
});

// ─── Constantes réseau / coût / circuit breaker ───────────────────────────
const DEFAULT_API_URL = 'https://api.dropcontact.io/batch';
// Dropcontact API V1 : "Request not ready yet, try again in 30 seconds"
// Validation terrain 2026-04-24 : batch processing ~30-60s réel.
// Polls 30s × 3 = 90s cumulés + timeout 110s. Dropcontact répond
// fréquemment "Request not ready yet, try again in 30 seconds" sur les
// premiers polls pour les batch ; la V1 [30, 15, 15, 15] = 75s était trop
// court (poll exhausted observé 5 mai 2026 PM). 5 polls (150s) était trop
// long : enrichBatch est SÉQUENTIEL côté candidates (boucle for await),
// donc 10 candidates × 220s = 36 min, hors fenêtre 10 min functionTimeout
// Linux Consumption (timeout fatal observé). 3 polls couvre la majorité
// des matches en restant compatible batchSize 10 sur 10 min.
//
// TODO post-pilote : paralléliser exhauster sur les candidates via
// Promise.allSettled avec concurrency limitée (~3-5) pour libérer
// l'enveloppe et permettre des polls plus longs (5-7 polls).
const DEFAULT_TIMEOUT_MS = 110_000;
const DEFAULT_POLL_DELAYS_MS = [30_000, 30_000, 30_000];
const DEFAULT_COST_PER_LOOKUP_CENTS = 3; // Starter plan ~2.4c/lookup, arrondi 3
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_OPEN_MS = 10 * 60 * 1000; // 10 min

// ─── Circuit breaker état in-memory (process) ──────────────────────────────
// État shared au niveau module (volontaire : tous les adapters Dropcontact
// instanciés dans ce process partagent le breaker, protection commune).
const _breaker = {
  consecutiveFailures: 0,
  openedAt: 0, // timestamp ms, 0 = fermé
};

function isCircuitOpen(now = Date.now()) {
  if (_breaker.openedAt === 0) return false;
  if (now - _breaker.openedAt > CIRCUIT_BREAKER_OPEN_MS) {
    // Half-open : on réinitialise, prochain appel testera
    _breaker.openedAt = 0;
    _breaker.consecutiveFailures = 0;
    return false;
  }
  return true;
}

function noteFailure() {
  _breaker.consecutiveFailures++;
  if (_breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    _breaker.openedAt = Date.now();
  }
}

function noteSuccess() {
  _breaker.consecutiveFailures = 0;
  _breaker.openedAt = 0;
}

function _resetBreakerForTests() {
  _breaker.consecutiveFailures = 0;
  _breaker.openedAt = 0;
}

// ─── Adapter ───────────────────────────────────────────────────────────────

class DropcontactAdapter {
  /**
   * @param {Object} [opts]
   * @param {string}  [opts.apiKey]     Défaut process.env.DROPCONTACT_API_KEY
   * @param {string}  [opts.apiUrl]     Défaut process.env.DROPCONTACT_API_URL
   * @param {boolean} [opts.enabled]    Défaut process.env.DROPCONTACT_ENABLED
   * @param {number}  [opts.timeoutMs]  Timeout HTTP global (défaut 15s)
   * @param {number[]}[opts.pollDelays] Backoff polling (ms)
   * @param {number}  [opts.budgetCents] Défaut DROPCONTACT_MONTHLY_BUDGET_CENTS
   * @param {number}  [opts.costPerLookupCents] Défaut 3
   * @param {Function}[opts.fetchImpl]  Injection pour tests
   * @param {Function|Object} [opts.logger]
   * @param {Object}  [opts.budgetAdapter] { canSpend, addSpend } injectable tests
   * @param {Function}[opts.sleepFn]    Injection pour tests (bypass poll delays)
   */
  constructor(opts = {}) {
    this.name = 'dropcontact';
    this.apiKey = opts.apiKey || process.env.DROPCONTACT_API_KEY || '';
    this.apiUrl = opts.apiUrl || process.env.DROPCONTACT_API_URL || DEFAULT_API_URL;
    const envEnabled = process.env.DROPCONTACT_ENABLED === 'true'
      || process.env.DROPCONTACT_ENABLED === '1';
    this.enabled = typeof opts.enabled === 'boolean' ? opts.enabled : envEnabled;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.pollDelays = Array.isArray(opts.pollDelays) ? opts.pollDelays.slice() : DEFAULT_POLL_DELAYS_MS.slice();
    this.budgetCents = Number.isFinite(opts.budgetCents)
      ? opts.budgetCents
      : Number(process.env.DROPCONTACT_MONTHLY_BUDGET_CENTS || 0);
    this.costPerLookupCents = Number.isFinite(opts.costPerLookupCents)
      ? opts.costPerLookupCents
      : Number(process.env.DROPCONTACT_COST_PER_LOOKUP_CENTS || DEFAULT_COST_PER_LOOKUP_CENTS);
    this._fetch = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    this._logger = opts.logger || null;
    this._budget = opts.budgetAdapter || { canSpend, addSpend };
    this._sleep = opts.sleepFn || defaultSleep;

    if (this.enabled && !this.apiKey) {
      throw new Error('DropcontactAdapter: enabled=true mais apiKey manquante');
    }
  }

  /**
   * Mapping brut qualification → confidence. Exposé statiquement pour tests
   * et pour le lookup direct sans instancier l'adapter.
   * Qualification inconnue → 0 (confiance nulle, rejetée par l'orchestrateur).
   */
  static qualificationToConfidence(q) {
    if (!q || typeof q !== 'string') return 0;
    const key = q.toLowerCase().trim();
    // Format Dropcontact V1 : "nominative", "catch_all", "role"
    if (typeof QUALIFICATION_MAP[key] === 'number') return QUALIFICATION_MAP[key];
    // Format Dropcontact V2 (observé 2026-05-05 sur fichier exemple app.dropcontact.com) :
    // "nominative@pro", "catch-all@pro", "role@pro" — préfixe sémantique avant '@',
    // tirets normalisés en underscore pour matcher la map.
    const prefix = key.split('@')[0].replace(/-/g, '_');
    if (typeof QUALIFICATION_MAP[prefix] === 'number') return QUALIFICATION_MAP[prefix];
    return 0;
  }

  /**
   * Validation minimale d'un ResolveInput. Retourne une liste d'erreurs
   * (vide = OK). Exposé pour tests.
   */
  static validateInput(input) {
    const errors = [];
    if (!input || typeof input !== 'object') return ['input is required'];
    if (!input.firstName || typeof input.firstName !== 'string') errors.push('firstName required');
    if (!input.lastName || typeof input.lastName !== 'string') errors.push('lastName required');
    if (!input.companyName && !input.companyDomain) {
      errors.push('companyName or companyDomain required');
    }
    if (!input.siren || !/^\d{9}$/.test(String(input.siren))) {
      errors.push('siren must be 9 digits');
    }
    return errors;
  }

  /**
   * Résout un email pour un décideur donné via Dropcontact.
   *
   * Flow complet Jalon 3 :
   *   1. Validate input
   *   2. Skip si disabled
   *   3. Skip si circuit breaker ouvert
   *   4. Budget check via Azure Table Budgets
   *   5. POST /batch → request_id
   *   6. Polling GET /batch/{request_id}
   *   7. Mapping qualification → confidence
   *   8. addSpend si cost > 0 (pay-on-success)
   *
   * @param {import('./interface').ResolveInput} input
   * @returns {Promise<import('./interface').ResolveResult>}
   */
  async resolve(input) {
    const errors = DropcontactAdapter.validateInput(input);
    if (errors.length > 0) {
      return {
        email: null,
        confidence: 0,
        cost_cents: 0,
        providerRaw: { validation_errors: errors },
        error: new Error(`dropcontact: invalid input: ${errors.join(', ')}`),
      };
    }

    if (!this.enabled) {
      this._log('info', 'dropcontact.skip.disabled', { siren: input.siren });
      return zeroResult('disabled');
    }

    if (isCircuitOpen()) {
      this._log('warn', 'dropcontact.skip.circuit_open', { siren: input.siren });
      return zeroResult('circuit_open');
    }

    // Budget check avant toute requête. On demande le coût du pire cas
    // (nominative résolu, cost_cents=costPerLookupCents) pour réserver.
    const budgetCheck = await this._budget.canSpend(
      'dropcontact',
      this.costPerLookupCents,
      this.budgetCents,
    );
    if (!budgetCheck.ok) {
      this._log('warn', 'dropcontact.skip.budget_exceeded', {
        siren: input.siren,
        reason: budgetCheck.reason,
        spent: budgetCheck.spent,
        budget: budgetCheck.budget,
      });
      return zeroResult(`budget_${budgetCheck.reason}`);
    }

    try {
      const response = await this._callBatch(input);
      noteSuccess();

      const mapped = this._mapResponse(response);
      if (mapped.email && mapped.cost_cents > 0) {
        // Pay-on-success : facturation seulement quand email trouvé
        await this._budget.addSpend('dropcontact', mapped.cost_cents, {
          budgetCents: this.budgetCents,
        });
      }
      return mapped;
    } catch (err) {
      noteFailure();
      this._log('error', 'dropcontact.call.error', {
        siren: input.siren,
        err: err && err.message,
      });
      return {
        email: null,
        confidence: 0,
        cost_cents: 0,
        providerRaw: { error: (err && err.message) || 'unknown_error' },
        error: err,
      };
    }
  }

  // ─── HTTP batch + polling ─────────────────────────────────────────────

  async _callBatch(input) {
    const submissionStart = Date.now();

    // Étape 1 : POST /batch
    // Dropcontact API V1 : l'authentification se fait via header
    // `X-Access-Token`, pas via clé dans le body. Validation terrain
    // 2026-04-24 : body.apiKey → 403 avec message "No api key received.
    // Please set 'X-Access-Token' header with your api key as value."
    const submitRes = await this._fetchWithTimeout(this.apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Access-Token': this.apiKey,
      },
      body: JSON.stringify({
        data: [{
          first_name: input.firstName,
          last_name: input.lastName,
          company: input.companyName || '',
          website: input.companyDomain || '',
          num_siren: input.siren,
        }],
        language: 'fr',
        siren: true,
      }),
    }, this.timeoutMs);

    if (!submitRes.ok) {
      throw new Error(`dropcontact submit http_${submitRes.status}`);
    }
    const submitBody = await submitRes.json();
    if (!submitBody || submitBody.success === false || !submitBody.request_id) {
      throw new Error(
        `dropcontact submit no_request_id: ${JSON.stringify(submitBody).slice(0, 200)}`,
      );
    }
    const requestId = submitBody.request_id;

    // Étape 2 : polling GET /batch/{request_id}
    let lastBody = null;
    for (let i = 0; i < this.pollDelays.length; i++) {
      if (Date.now() - submissionStart > this.timeoutMs) {
        throw new Error('dropcontact poll timeout');
      }
      await this._sleep(this.pollDelays[i]);
      const pollUrl = `${this.apiUrl.replace(/\/+$/, '')}/${encodeURIComponent(requestId)}`;
      const pollRes = await this._fetchWithTimeout(pollUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'X-Access-Token': this.apiKey,
        },
      }, this.timeoutMs);
      if (!pollRes.ok) {
        throw new Error(`dropcontact poll http_${pollRes.status}`);
      }
      const body = await pollRes.json();
      lastBody = body;
      if (body && body.success === true && Array.isArray(body.data) && body.data.length > 0) {
        return body;
      }
      // success=false + reason=wait → continue polling
    }
    throw new Error(
      `dropcontact poll exhausted: ${JSON.stringify(lastBody).slice(0, 200)}`,
    );
  }

  async _fetchWithTimeout(url, opts, timeoutMs) {
    if (!this._fetch) throw new Error('fetch_unavailable');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await this._fetch(url, {
        ...opts,
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Mapping réponse → ResolveResult ────────────────────────────────

  _mapResponse(body) {
    const row = Array.isArray(body && body.data) && body.data[0] ? body.data[0] : null;
    if (!row) {
      return {
        email: null,
        confidence: 0,
        cost_cents: 0,
        providerRaw: body || {},
      };
    }
    // Dropcontact peut retourner plusieurs emails (nominative + pro), on
    // prend celui avec la meilleure qualification.
    const emails = Array.isArray(row.email) ? row.email : (row.email ? [row.email] : []);
    let bestEmail = null;
    let bestQualif = '';
    let bestConfidence = 0;
    for (const e of emails) {
      const addr = typeof e === 'string' ? e : e.email;
      const q = typeof e === 'string' ? (row.qualification || '') : (e.qualification || row.qualification || '');
      const c = DropcontactAdapter.qualificationToConfidence(q);
      if (c > bestConfidence) {
        bestEmail = addr;
        bestQualif = q;
        bestConfidence = c;
      }
    }

    // Pay-on-success : on facture seulement si qualification payante
    // (nominative/nominative_verified). catch_all et role sont rejetés
    // par l'orchestrateur (sous seuil) et ne sont pas facturés non plus.
    const cost = bestEmail && bestConfidence >= QUALIFICATION_MAP.nominative
      ? this.costPerLookupCents
      : 0;

    return {
      email: bestEmail || null,
      confidence: bestConfidence,
      cost_cents: cost,
      qualification: bestQualif,
      providerRaw: row,
    };
  }

  _log(level, message, payload) {
    if (!this._logger) return;
    const logger = this._logger;
    if (logger && typeof logger[level] === 'function') {
      logger[level](message, payload);
    } else if (typeof logger === 'function') {
      logger(`${level}: ${message}`, payload);
    } else if (logger && typeof logger.log === 'function') {
      logger.log(`[${level}] ${message}`, payload);
    }
  }
}

// Self-check au chargement : l'adapter doit respecter le contrat
// EmailExternalAdapter. On instancie un adapter désactivé (sans apiKey)
// juste pour la validation de forme. L'erreur est fatale — si elle saute
// on a introduit une régression de signature.
(function assertAdapterContract() {
  const dummy = new DropcontactAdapter({ enabled: false });
  const { ok, errors } = validateAdapter(dummy);
  if (!ok) {
    throw new Error(`DropcontactAdapter contract violation: ${errors.join('; ')}`);
  }
})();

function zeroResult(reason) {
  return {
    email: null,
    confidence: 0,
    cost_cents: 0,
    providerRaw: { skipped: reason },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  DropcontactAdapter,
  QUALIFICATION_MAP,
  _resetBreakerForTests,
  // exposés pour tests :
  _constants: {
    DEFAULT_API_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_POLL_DELAYS_MS,
    DEFAULT_COST_PER_LOOKUP_CENTS,
    CIRCUIT_BREAKER_THRESHOLD,
    CIRCUIT_BREAKER_OPEN_MS,
  },
};
