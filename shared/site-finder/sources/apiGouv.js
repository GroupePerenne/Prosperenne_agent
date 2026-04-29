'use strict';

/**
 * Source 1 (T1) — API Recherche d'entreprises (api.gouv.fr).
 *
 * Endpoint : https://recherche-entreprises.api.gouv.fr/search?q={query}
 * Doc      : https://recherche-entreprises.api.gouv.fr/docs/
 *
 * Stratégie : query par SIREN exact, on extrait `site_internet` aux 3
 * emplacements possibles dans le payload (siège, matching_etablissements[0],
 * racine). Chaque site_internet trouvé devient un candidat, normalisé via
 * urlNormalizer.
 *
 * Différence vs `shared/lead-exhauster/resolveDomain.js#fetchFromApiGouv` :
 *   - resolveDomain extrait UN domaine et lui donne autorité 0.90 directement.
 *   - cette source retourne les candidats à valider, sans préjuger : la
 *     confidence finale viendra de siteValidator (preuve par SIREN dans
 *     mentions légales). `initialConfidence` 0.85 ici n'est qu'un floor.
 *
 * Erreurs classifiées :
 *   - 429 / 5xx → throw `ApiGouvError(transient)` (le caller peut retry)
 *   - 4xx (sauf 429) → return [] (pas d'erreur fatale, juste pas de candidat)
 *   - réseau / timeout / JSON invalide → throw `ApiGouvError(transient)`
 */

const { normalize } = require('../utils/urlNormalizer');

const API_GOUV_URL =
  process.env.RECHERCHE_ENTREPRISES_API_URL
  || 'https://recherche-entreprises.api.gouv.fr';
const DEFAULT_TIMEOUT_MS = 5000;
const INITIAL_CONFIDENCE = 0.85;
const SOURCE_ID = 'api_gouv';

class ApiGouvError extends Error {
  constructor(message, code = 'unknown', cause = null) {
    super(message);
    this.name = 'ApiGouvError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * Cherche les candidats site web pour un SIREN via l'API gouv.
 *
 * @param {Object} input
 * @param {string} input.siren                  9 chiffres, obligatoire
 * @param {string} [input.companyName]           Pour traçabilité signals
 * @param {string} [input.ville]                 Idem
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]           Injection pour tests
 * @param {number}   [opts.timeoutMs]           Override (défaut 5s)
 * @returns {Promise<Array<{ url: string, source: string, initialConfidence: number, signals: string[] }>>}
 */
async function findCandidatesViaApiGouv(input = {}, opts = {}) {
  if (!/^\d{9}$/.test(String(input.siren || ''))) {
    return [];
  }
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    throw new ApiGouvError('fetch not available', 'transient');
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const url = `${API_GOUV_URL.replace(/\/+$/, '')}/search?q=${encodeURIComponent(input.siren)}&per_page=5`;

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
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    throw new ApiGouvError(
      isTimeout ? 'api_gouv timeout' : 'api_gouv network error',
      'transient',
      err,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) {
    throw new ApiGouvError('api_gouv no response', 'transient');
  }

  const status = res.status;
  if (status === 429 || (status >= 500 && status < 600)) {
    throw new ApiGouvError(`api_gouv http ${status}`, 'transient');
  }
  if (status === 404) {
    // Pas une erreur — l'API peut retourner 404 quand le SIREN n'existe pas.
    return [];
  }
  if (status < 200 || status >= 300) {
    // Autres 4xx : pas d'exception, juste 0 candidat.
    return [];
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new ApiGouvError('api_gouv invalid JSON', 'transient', err);
  }

  const results = Array.isArray(data && data.results) ? data.results : [];
  if (results.length === 0) return [];

  // L'API fait un free-text search : un SIREN peut co-exister avec d'autres
  // résultats. On cherche le matching exact.
  const exact = results.find((r) => String(r.siren) === String(input.siren)) || null;
  if (!exact) return [];

  const candidatesRaw = collectSiteFields(exact);
  const candidates = [];
  const seen = new Set();
  for (const raw of candidatesRaw) {
    if (!raw) continue;
    const normalized = normalize(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({
      url: normalized,
      source: SOURCE_ID,
      initialConfidence: INITIAL_CONFIDENCE,
      signals: ['extracted_from_api_gouv'],
    });
  }

  return candidates;
}

/**
 * Récupère tous les `site_internet` candidats d'un résultat.
 * L'API gouv place le champ à différents emplacements selon l'établissement.
 * Note : le champ s'appelle `site_internet` côté API (cf. doc officielle), pas
 * `site_web` — `resolveDomain.js` du lead-exhauster utilise `site_web` qui est
 * un legacy / alias selon les versions de l'API. On lit les deux pour
 * robustesse.
 */
function collectSiteFields(result) {
  if (!result || typeof result !== 'object') return [];
  const out = [];
  // Siège
  if (result.siege) {
    if (result.siege.site_internet) out.push(result.siege.site_internet);
    if (result.siege.site_web) out.push(result.siege.site_web);
  }
  // matching_etablissements
  if (Array.isArray(result.matching_etablissements)) {
    for (const e of result.matching_etablissements) {
      if (!e) continue;
      if (e.site_internet) out.push(e.site_internet);
      if (e.site_web) out.push(e.site_web);
    }
  }
  // Racine
  if (result.site_internet) out.push(result.site_internet);
  if (result.site_web) out.push(result.site_web);
  return out;
}

module.exports = {
  findCandidatesViaApiGouv,
  ApiGouvError,
  // Exposés pour tests :
  _internals: {
    collectSiteFields,
    API_GOUV_URL,
    DEFAULT_TIMEOUT_MS,
    INITIAL_CONFIDENCE,
    SOURCE_ID,
  },
};
