'use strict';

/**
 * Backend Mojeek — moteur indépendant UK, index propre (pas de wrapper).
 * Pas de clé API requise pour la recherche web publique. HTML simple, peu
 * de protection anti-bot observée à ce jour.
 *
 * Endpoint : https://www.mojeek.com/search?q={query}
 *   - GET avec query encodée
 *   - Retourne du HTML5, classes CSS variables → on extrait via le pattern
 *     générique `<a href="https://...">` avec exclusion des hosts internes
 *     (mojeek.com).
 *
 * Avantage : index indépendant Bing/Google → diversifie la cascade et
 * échappe aux blocages corrélés. FR-friendly via Accept-Language fr-FR.
 *
 * Limite : index plus petit que les majors → certains domaines très peu
 * référencés peuvent ne pas remonter. Acceptable en complément.
 */

const { extractResults, looksBlocked } = require('./_genericHtmlExtractor');
const { SearchBlockedError, SearchTransientError } = require('./_searchErrors');

const ENDPOINT = process.env.SITE_FINDER_MOJEEK_URL
  || 'https://www.mojeek.com/search';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_USER_AGENT = process.env.SITE_FINDER_WEBSEARCH_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BACKEND_ID = 'mojeek';
const EXCLUDE_HOSTS = ['mojeek.com'];

async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new SearchTransientError('fetch not available');

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;

  // Mojeek accepte `?q=` ; on précise `&fmt=classic` pour figer le rendu
  // HTML simple plutôt qu'une éventuelle UI moderne (paramètre observé sur
  // la doc publique Mojeek).
  const url = `${ENDPOINT}?q=${encodeURIComponent(query.trim())}&fmt=classic`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: buildHeaders(userAgent),
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    throw new SearchTransientError(
      isTimeout ? 'mojeek timeout' : `mojeek network error: ${err && err.message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) throw new SearchTransientError('mojeek no response');

  const status = res.status;
  let body = '';
  try { body = await res.text(); } catch { body = ''; }

  if (status === 429) throw new SearchBlockedError('rate_limited', status);
  if (status === 403) throw new SearchBlockedError('forbidden', status);
  if (status >= 500 && status < 600) {
    throw new SearchTransientError(`mojeek http ${status}`, status);
  }
  if (looksBlocked(body)) throw new SearchBlockedError('challenge_detected', status);
  if (status < 200 || status >= 300) return [];

  return extractResults(body, {
    excludeHostSuffixes: EXCLUDE_HOSTS,
    maxResults,
  });
}

function buildHeaders(userAgent) {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  };
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
    EXCLUDE_HOSTS,
    buildHeaders,
  },
};
