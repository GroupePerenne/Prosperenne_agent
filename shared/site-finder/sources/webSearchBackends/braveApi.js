'use strict';

/**
 * Backend Brave Search API — recherche web premium (index Brave indépendant).
 *
 * Endpoint : https://api.search.brave.com/res/v1/web/search
 * Doc      : https://api-dashboard.search.brave.com/app/documentation/web-search
 *
 * Authentification : header `X-Subscription-Token: <api_key>`. Clé fournie
 * via env `SITE_FINDER_BRAVE_API_KEY` (Azure App Settings prod).
 *
 * Free tier "Data for Search" : 1000 req/mois (cf. Paul 4 mai 2026). Au-delà,
 * facturation au volume. Pour rester dans le tier gratuit, on impose un
 * kill-switch local via `_braveQuota` qui compte les requêtes du mois courant
 * en Storage Table. Si le compteur >= `SITE_FINDER_BRAVE_QUOTA_LIMIT` (990
 * par défaut, 10 de buffer — confirmation Paul 4 mai 2026 : on peut aller
 * jusqu'à 990 sans débordement), on throw SearchBlockedError
 * (`quota_exhausted_local`) → le caller webSearch.js bascule sur le backend
 * suivant de la cascade (DDG Lite, Mojeek, Ecosia).
 *
 * Format réponse JSON :
 *   { web: { results: [{ url, title, description, ... }] }, ... }
 *
 * Erreurs classifiées :
 *   - 401 → SearchTransientError ('invalid api key' — pb config, pas blocked)
 *   - 422 → SearchTransientError (mauvaise query, on skip cette stratégie)
 *   - 429 → SearchBlockedError (Brave a rate-limit côté serveur)
 *   - 403 → SearchBlockedError
 *   - 5xx → SearchTransientError
 *   - réseau / timeout → SearchTransientError
 */

const { SearchBlockedError, SearchTransientError } = require('./_searchErrors');
const braveQuota = require('./_braveQuota');
const { normalize } = require('../../utils/urlNormalizer');

const ENDPOINT = process.env.SITE_FINDER_BRAVE_API_URL
  || 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_QUOTA_LIMIT = Number(process.env.SITE_FINDER_BRAVE_QUOTA_LIMIT || 990);

const BACKEND_ID = 'brave';

/**
 * Lance une recherche Brave.
 *
 * @param {string} query
 * @param {Object} [opts]
 * @param {string}   [opts.apiKey]            Override (default env SITE_FINDER_BRAVE_API_KEY)
 * @param {Function} [opts.fetchImpl]
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxResults]
 * @param {number}   [opts.quotaLimit]        Override pour tests
 * @param {Object}   [opts.quotaImpl]         Injection compteur (tests)
 * @returns {Promise<Array<{url, title, rank}>>}
 */
async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const apiKey = opts.apiKey || process.env.SITE_FINDER_BRAVE_API_KEY;
  if (!apiKey) {
    throw new SearchTransientError('brave api key missing (env SITE_FINDER_BRAVE_API_KEY)');
  }

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new SearchTransientError('fetch not available');

  // Kill-switch quota local : si on a déjà consommé le budget du mois, on
  // throw blocked pour que la cascade bascule sur les backends gratuits.
  const quotaImpl = opts.quotaImpl || braveQuota;
  const limit = Number.isFinite(opts.quotaLimit) ? opts.quotaLimit : DEFAULT_QUOTA_LIMIT;
  let currentCount = 0;
  try {
    currentCount = await quotaImpl.getCurrentCount();
  } catch {
    currentCount = 0; // best effort, on continue
  }
  if (currentCount >= limit) {
    throw new SearchBlockedError('quota_exhausted_local', null);
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;

  const url = `${ENDPOINT}?q=${encodeURIComponent(query.trim())}`
    + `&count=${maxResults}&country=FR&search_lang=fr`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    throw new SearchTransientError(
      isTimeout ? 'brave timeout' : `brave network error: ${err && err.message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) throw new SearchTransientError('brave no response');

  // On incrémente best effort dès l'appel effectué (Brave facture aussi
  // certaines erreurs côté serveur — politique conservatrice).
  quotaImpl.increment().catch(() => {});

  const status = res.status;
  if (status === 429) throw new SearchBlockedError('rate_limited', status);
  if (status === 401) throw new SearchTransientError('brave 401 unauthorized', status);
  // S7 (8 mai 2026) — 402 Payment Required : Brave plan payant cap mensuel
  // atteint (USAGE_LIMIT_EXCEEDED). Doit basculer cascade et logger clairement,
  // pas retourner [] silencieusement (bug observé : Brave 0 résultats sans
  // erreur ni log pendant ~1 semaine, découvert post-mortem 8 mai PM).
  if (status === 402) throw new SearchBlockedError('quota_exceeded_server', status);
  if (status === 403) throw new SearchBlockedError('forbidden', status);
  if (status === 422) throw new SearchTransientError('brave 422 invalid query', status);
  if (status >= 500 && status < 600) {
    throw new SearchTransientError(`brave http ${status}`, status);
  }
  if (status < 200 || status >= 300) return [];

  let body;
  try {
    body = await res.json();
  } catch {
    return [];
  }

  return parseResults(body, maxResults);
}

function parseResults(body, maxResults) {
  if (!body || typeof body !== 'object') return [];
  const web = body.web && Array.isArray(body.web.results) ? body.web.results : [];
  const out = [];
  const seen = new Set();
  for (const r of web) {
    if (out.length >= maxResults) break;
    if (!r || typeof r.url !== 'string') continue;
    const normalized = normalize(r.url);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      url: normalized,
      title: typeof r.title === 'string' ? r.title : '',
      rank: out.length + 1,
    });
  }
  return out;
}

module.exports = {
  search,
  SearchBlockedError,
  SearchTransientError,
  BACKEND_ID,
  _internals: {
    ENDPOINT,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS,
    DEFAULT_QUOTA_LIMIT,
    parseResults,
  },
};
