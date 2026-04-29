'use strict';

/**
 * Backend DuckDuckGo HTML pour le moteur de recherche site-finder.
 *
 * Endpoint : https://html.duckduckgo.com/html/?q={query_url_encoded}
 * (Pas l'API JSON officielle, dépréciée. L'endpoint HTML est public et stable.)
 *
 * Reconnaissance T2.0 (2026-04-29) :
 *   - HTTP 200 sur requêtes propres, 202 + body avec class `anomaly-modal__image`
 *     en cas de détection bot. On classifie 202 + anomaly comme blocked.
 *   - Résultats organiques : <a class="result__a" href="//duckduckgo.com/l/?uddg=...">
 *     (10 résultats max par défaut sur le HTML public).
 *   - Toutes les URL résultats sont des redirections DDG : il faut décoder le
 *     param `uddg` pour obtenir l'URL réelle.
 *   - Pas de class CSS stable au-delà de `result__a`. On parse via regex sur cet
 *     attribut + sur la présence du préfixe `//duckduckgo.com/l/?uddg=`.
 *
 * Politesse :
 *   - Le caller (webSearch.js) impose un delay entre requêtes au même backend
 *     via un Map<backend, lastFetchAt> module-scope. Ce backend ne fait pas
 *     son propre throttling — il est stateless.
 *   - User-Agent réaliste (Chrome 120 macOS), Accept-Language fr-FR.
 */

const { normalize } = require('../../utils/urlNormalizer');

const DDG_HTML_URL = process.env.SITE_FINDER_DDG_HTML_URL
  || 'https://html.duckduckgo.com/html/';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_USER_AGENT = process.env.SITE_FINDER_WEBSEARCH_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BACKEND_ID = 'duckduckgo_html';

class SearchBlockedError extends Error {
  constructor(reason, status) {
    super(`web search blocked: ${reason}`);
    this.name = 'SearchBlockedError';
    this.code = 'blocked';
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

class SearchTransientError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SearchTransientError';
    this.code = 'transient';
    if (status !== undefined) this.status = status;
  }
}

/**
 * Lance une recherche DuckDuckGo HTML.
 *
 * @param {string} query                    Texte à chercher (sera encodé)
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]       Injection pour tests
 * @param {number}   [opts.timeoutMs]
 * @param {number}   [opts.maxResults]
 * @param {string}   [opts.userAgent]
 * @returns {Promise<Array<{ url: string, title: string, snippet?: string, rank: number }>>}
 */
async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    throw new SearchTransientError('fetch not available');
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;

  const url = `${DDG_HTML_URL.replace(/\/+$/, '/')}?q=${encodeURIComponent(query.trim())}`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    throw new SearchTransientError(
      isTimeout ? 'duckduckgo timeout' : `duckduckgo network error: ${err && err.message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res) throw new SearchTransientError('duckduckgo no response');

  const status = res.status;
  let body;
  try {
    body = await res.text();
  } catch {
    body = '';
  }

  if (status === 429) {
    throw new SearchBlockedError('rate_limited', status);
  }
  if (status === 403) {
    throw new SearchBlockedError('forbidden', status);
  }
  if (status >= 500 && status < 600) {
    throw new SearchTransientError(`duckduckgo http ${status}`, status);
  }
  // 202 + body anomaly = challenge anti-bot DDG (observé en T2.0)
  if (isAnomalyBody(body)) {
    throw new SearchBlockedError('anomaly_challenge', status);
  }
  if (status < 200 || status >= 300) {
    // Autre 4xx : pas un blocage bot, juste une erreur transitoire douce
    return [];
  }

  return parseResults(body, maxResults);
}

// ─── Parsing & helpers ─────────────────────────────────────────────────────

/**
 * Détecte le body de challenge "anomaly" DDG.
 * Heuristiques observées T2.0 : présence du form `action="//duckduckgo.com/anomaly.js"`
 * ou de la classe `anomaly-modal__image`.
 */
function isAnomalyBody(html) {
  if (typeof html !== 'string') return false;
  if (/anomaly\.js\?/i.test(html)) return true;
  if (/anomaly-modal/i.test(html)) return true;
  return false;
}

/**
 * Parse les résultats organiques d'un body DDG HTML.
 *
 * Stratégie :
 *   1. Trouve tous les <a class="result__a" href="..."> (regex permissive,
 *      pas de parser HTML pour ne pas ajouter de dep).
 *   2. Extrait le href, décode si redirection DDG, normalise via urlNormalizer.
 *   3. Capture le texte intérieur du <a> comme titre (strip tags + entities).
 *   4. Déduplique sur URL canonique (le HTML DDG répète chaque résultat
 *      plusieurs fois — ancre titre, ancre snippet, ancre footer…).
 *   5. Limite à maxResults.
 */
function parseResults(html, maxResults) {
  if (typeof html !== 'string' || html.length === 0) return [];

  const seen = new Set();
  const results = [];

  // Match <a ... class="result__a" ... href="..."> ... </a>
  // ou <a ... href="..." ... class="result__a"> ... </a>
  // (l'ordre des attributs n'est pas garanti)
  const re = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const reAlt = /<a\b[^>]*\bhref="([^"]+)"[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const matches = [];
  let m;
  while ((m = re.exec(html)) !== null) matches.push({ href: m[1], inner: m[2], idx: m.index });
  while ((m = reAlt.exec(html)) !== null) matches.push({ href: m[1], inner: m[2], idx: m.index });
  matches.sort((a, b) => a.idx - b.idx);

  for (const match of matches) {
    if (results.length >= maxResults) break;
    const decodedUrl = decodeDuckduckgoRedirect(match.href);
    if (!decodedUrl) continue;
    const normalized = normalize(decodedUrl);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const title = decodeEntities(stripTags(match.inner)).trim();
    results.push({
      url: normalized,
      title,
      rank: results.length + 1,
    });
  }

  return results;
}

/**
 * Décode le param `uddg` des redirections DDG.
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Facme.fr%2F&rut=hash
 *   → https://acme.fr/
 *
 * Si l'href n'est pas une redirection DDG, on retourne tel quel (ex: lien
 * direct vers DDG lui-même → sera filtré par normalize / aggregator).
 */
function decodeDuckduckgoRedirect(href) {
  if (typeof href !== 'string' || !href) return null;

  // Format observé T2.0 : //duckduckgo.com/l/?uddg=...&rut=...
  // On décode `uddg` une seule fois (DDG encode-once en URL).
  let target = href;
  if (target.startsWith('//')) target = `https:${target}`;
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (
    /(^|\.)duckduckgo\.com$/i.test(parsed.hostname)
    && parsed.pathname === '/l/'
  ) {
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return uddg;
    return null;
  }
  return target;
}

function stripTags(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

module.exports = {
  search,
  SearchBlockedError,
  SearchTransientError,
  BACKEND_ID,
  // Exposés pour tests :
  _internals: {
    parseResults,
    decodeDuckduckgoRedirect,
    isAnomalyBody,
    DDG_HTML_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS,
  },
};
