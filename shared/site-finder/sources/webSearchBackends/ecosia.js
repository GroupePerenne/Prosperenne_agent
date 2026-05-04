'use strict';

/**
 * Backend Ecosia — moteur écolo allemand qui wrappe l'index Bing.
 * Pas de clé API publique nécessaire pour la recherche web. HTML accessible
 * et peu de protection anti-bot observée à ce jour.
 *
 * Endpoint : https://www.ecosia.org/search?q={query}
 *   - GET avec query encodée
 *   - HTML responsive moderne, classes CSS qui changent régulièrement → on
 *     se rabat sur le pattern générique `<a href="https://...">` avec
 *     exclusion des hosts ecosia.org.
 *
 * Avantage : couverture Bing étendue + propre côté éthique (compatible
 * positionnement souverain Pereneo). Diversifie la cascade.
 *
 * Limite : Ecosia tracke en sortie via redirections internes pour les ads
 * sponsorisées — l'extraction filtre les hosts internes, on ignore donc
 * les liens promotionnels.
 */

const { extractResults, looksBlocked } = require('./_genericHtmlExtractor');
const { SearchBlockedError, SearchTransientError } = require('./_searchErrors');

const ENDPOINT = process.env.SITE_FINDER_ECOSIA_URL
  || 'https://www.ecosia.org/search';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_USER_AGENT = process.env.SITE_FINDER_WEBSEARCH_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0';

const BACKEND_ID = 'ecosia';
const EXCLUDE_HOSTS = ['ecosia.org', 'ecosia.com'];

async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new SearchTransientError('fetch not available');

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;

  const url = `${ENDPOINT}?q=${encodeURIComponent(query.trim())}`;

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
      isTimeout ? 'ecosia timeout' : `ecosia network error: ${err && err.message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) throw new SearchTransientError('ecosia no response');

  const status = res.status;
  let body = '';
  try { body = await res.text(); } catch { body = ''; }

  if (status === 429) throw new SearchBlockedError('rate_limited', status);
  if (status === 403) throw new SearchBlockedError('forbidden', status);
  if (status >= 500 && status < 600) {
    throw new SearchTransientError(`ecosia http ${status}`, status);
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
