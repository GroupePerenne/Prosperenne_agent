'use strict';

/**
 * Backend DuckDuckGo Lite — version sans-JS, beaucoup moins protégée que
 * `html.duckduckgo.com`. Sortie HTML très simple (tableau de liens directs,
 * pas de redirection wrapper).
 *
 * Endpoint : https://lite.duckduckgo.com/lite/?q={query}
 *   - GET avec query encodée (encodeURIComponent)
 *   - Retourne du HTML5 simple, parseable par regex sur les `<a href="..."`
 *
 * Différence vs html.duckduckgo.com :
 *   - Pas de challenge "anomaly" observé en T2.0 sur la version lite
 *   - Pas de redirection `/l/?uddg=...` : les liens sont directs
 *   - Volume de résultats plus restreint (~10 par page) mais qualité OK
 *
 * Anti-bot : on s'appuie sur la détection blocked générique de
 * `_genericHtmlExtractor` (Cloudflare, captcha) et HTTP 403/429.
 */

const { extractResults, looksBlocked } = require('./_genericHtmlExtractor');
const { SearchBlockedError, SearchTransientError } = require('./_searchErrors');

const ENDPOINT = process.env.SITE_FINDER_DDG_LITE_URL
  || 'https://lite.duckduckgo.com/lite/';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_USER_AGENT = process.env.SITE_FINDER_WEBSEARCH_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BACKEND_ID = 'duckduckgo_lite';
const EXCLUDE_HOSTS = ['duckduckgo.com', 'duck.com'];

async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new SearchTransientError('fetch not available');

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;

  const url = `${ENDPOINT.replace(/\/+$/, '/')}?q=${encodeURIComponent(query.trim())}`;

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
      isTimeout ? 'ddg_lite timeout' : `ddg_lite network error: ${err && err.message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) throw new SearchTransientError('ddg_lite no response');

  const status = res.status;
  let body = '';
  try { body = await res.text(); } catch { body = ''; }

  if (status === 429) throw new SearchBlockedError('rate_limited', status);
  if (status === 403) throw new SearchBlockedError('forbidden', status);
  if (status >= 500 && status < 600) {
    throw new SearchTransientError(`ddg_lite http ${status}`, status);
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
