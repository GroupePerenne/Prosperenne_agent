'use strict';

/**
 * Résolution du domaine web d'une entreprise cible.
 *
 * Sources par ordre de priorité V1 :
 *   1. input.companyDomain (si fourni par le caller — vient de LeadBase)
 *      → confidence 1.0, source 'input'
 *   2. API gouv recherche-entreprises (SIREN → site_web)
 *      → confidence 0.90, source 'api_gouv'
 *   3. (Jalon 2) Google site-restricted + scraping léger
 *
 * V1 ne fait PAS :
 *   - Pappers (décision Paul, API gouv exclusive)
 *   - Heuristique sur companyName (acme.fr par inférence) — trop faux positifs
 *     tant qu'on n'a pas de vérification scraping en aval
 *   - Scraping LinkedIn entreprise pour le website (Jalon 2)
 *
 * Contrat de retour :
 *   {
 *     domain: string|null,        // lowercase, sans https:// ni www.
 *     confidence: number,         // 0-1
 *     source: string,             // 'input' | 'api_gouv' | 'none'
 *     signals: string[],          // traceabilité audit
 *     elapsedMs: number,
 *   }
 *
 * Le module est stateless et sans cache — le cache vit dans LeadContacts
 * (via trace.js) et est interrogé par l'orchestrateur avant d'appeler ici.
 */

const { normalizeDomain } = require('./patterns');

const API_GOUV_URL =
  process.env.RECHERCHE_ENTREPRISES_API_URL || 'https://recherche-entreprises.api.gouv.fr';
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Résout le domaine web d'une entreprise.
 *
 * @param {Object} input
 * @param {string} input.siren              SIREN 9 chiffres (obligatoire)
 * @param {string} [input.companyName]      Raison sociale (pour audit signals)
 * @param {string} [input.companyDomain]    Si déjà connu, short-circuit
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]       Injection pour tests
 * @param {number}   [opts.timeoutMs]       Override (défaut 5s)
 * @param {Function|Object} [opts.logger]
 * @returns {Promise<{ domain:string|null, confidence:number, source:string, signals:string[], elapsedMs:number }>}
 */
async function resolveDomain(input = {}, opts = {}) {
  const started = Date.now();
  const signals = [];

  // Validation
  if (!input.siren || !/^\d{9}$/.test(String(input.siren))) {
    return {
      domain: null,
      confidence: 0,
      source: 'none',
      signals: ['invalid_siren'],
      elapsedMs: Date.now() - started,
    };
  }

  // 1. Domain fourni par le caller
  if (input.companyDomain) {
    const normalized = normalizeDomain(input.companyDomain);
    if (normalized) {
      return {
        domain: normalized,
        confidence: 1.0,
        source: 'input',
        signals: ['domain_from_input'],
        elapsedMs: Date.now() - started,
      };
    }
    signals.push('input_domain_malformed');
  }

  // 2. API gouv recherche-entreprises
  const apiResult = await fetchFromApiGouv(input.siren, opts).catch((err) => {
    logLevel(opts.logger, 'warn', 'resolveDomain.api_gouv.error', { err: err && err.message });
    return { ok: false, error: err };
  });

  if (apiResult && apiResult.ok && apiResult.domain) {
    return {
      domain: apiResult.domain,
      confidence: 0.90,
      source: 'api_gouv',
      signals: [...signals, 'api_gouv_site_web', ...apiResult.signals],
      elapsedMs: Date.now() - started,
    };
  }
  if (apiResult && apiResult.ok) signals.push('api_gouv_no_site_web');
  else if (apiResult && apiResult.error) signals.push('api_gouv_error');

  return {
    domain: null,
    confidence: 0,
    source: 'none',
    signals,
    elapsedMs: Date.now() - started,
  };
}

// ─── API gouv recherche-entreprises ────────────────────────────────────────

/**
 * Appelle l'API recherche-entreprises avec SIREN en mot-clé.
 *
 * Stratégie d'extraction du site_web : l'API peut placer le champ à
 * différents endroits selon la mise à jour et le type d'établissement. On
 * scan par ordre de priorité :
 *   1. result.siege.site_web
 *   2. result.matching_etablissements[0].site_web
 *   3. result.site_web (racine, rare mais existe)
 *
 * Retourne { ok: bool, domain: string|null, signals: string[], error?: Error }.
 * Les erreurs réseau, timeout, statuts 4xx/5xx, JSON invalide → { ok:false, error }.
 * Aucun SIREN trouvé → { ok:true, domain:null, signals:['no_results'] }.
 */
async function fetchFromApiGouv(siren, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    return { ok: false, error: new Error('fetch not available'), signals: ['fetch_missing'] };
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const url = `${API_GOUV_URL.replace(/\/+$/, '')}/search?q=${encodeURIComponent(siren)}&per_page=5`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: err, signals: ['network_error'] };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || !res.ok) {
    return {
      ok: false,
      error: new Error(`api_gouv http ${res ? res.status : 'no_response'}`),
      signals: ['http_error'],
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: err, signals: ['json_invalid'] };
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  if (results.length === 0) {
    return { ok: true, domain: null, signals: ['no_results'] };
  }

  // Chercher le résultat qui matche exactement le SIREN (l'API fait un
  // free-text search, un SIREN peut co-exister avec des noms d'entreprises).
  const exact = results.find((r) => String(r.siren) === String(siren)) || results[0];
  if (!exact) return { ok: true, domain: null, signals: ['no_exact_match'] };

  const candidates = [
    exact.siege && exact.siege.site_web,
    Array.isArray(exact.matching_etablissements) && exact.matching_etablissements[0]
      ? exact.matching_etablissements[0].site_web
      : null,
    exact.site_web,
  ];

  for (const c of candidates) {
    if (!c) continue;
    const n = normalizeDomain(c);
    if (n) {
      return { ok: true, domain: n, signals: ['extracted_from_api_gouv'] };
    }
  }

  return { ok: true, domain: null, signals: ['no_site_web_in_payload'] };
}

function logLevel(logger, level, message, payload) {
  if (!logger) return;
  if (typeof logger[level] === 'function') logger[level](message, payload);
  else if (typeof logger === 'function') logger(`${level}: ${message}`, payload);
  else if (typeof logger.log === 'function') logger.log(`[${level}] ${message}`, payload);
}

module.exports = {
  resolveDomain,
  // exposé pour tests :
  fetchFromApiGouv,
  _constants: { API_GOUV_URL, DEFAULT_TIMEOUT_MS },
};
