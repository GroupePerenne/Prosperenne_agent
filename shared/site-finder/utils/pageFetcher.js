'use strict';

/**
 * Page fetcher pour la validation site-finder.
 *
 * Stratégie :
 *   1. Fetch home (siteUrl normalisée)
 *   2. Si home OK, parse les <a href> dont l'anchor matche les mots-clés
 *      mentions-légales / CGV / about. On déduit jusqu'à 5 URLs additionnelles.
 *   3. Fallback : si aucune anchor trouvée, on tente directement les paths
 *      classiques (/mentions-legales, /mentions, /cgv, /legal, /about,
 *      /a-propos) sur le domaine.
 *   4. On retourne TOUTES les pages effectivement fetchées (status, text).
 *
 * Ne fait PAS :
 *   - JavaScript rendering (les sites SPA modernes ne sont pas couverts en V1 ;
 *     accepté car les mentions légales restent quasi-toujours en HTML statique
 *     même sur les sites SPA pour des raisons SEO/légales).
 *   - Suivi de redirections cross-domain (suivi only same-host).
 *
 * Headers : User-Agent réaliste sans "bot", Accept-Language fr-FR.
 * Timeout per page : `perPageTimeoutMs` (défaut 5s).
 * Budget total : `totalTimeoutMs` (défaut timeoutMs/3 du caller, 5s minimum).
 */

const { normalize, extractHost } = require('./urlNormalizer');

const DEFAULT_PER_PAGE_TIMEOUT_MS = 5000;
const DEFAULT_TOTAL_TIMEOUT_MS = 12000;
const MAX_ADDITIONAL_PAGES = 5;
const FALLBACK_PATHS = [
  '/mentions-legales',
  '/mentions',
  '/cgv',
  '/legal',
  '/about',
  '/a-propos',
];
// Paths supplémentaires activés uniquement en mode AirWorker (opts.extendedPaths).
// /contact contient fréquemment l'adresse + SIREN sur les sites PME.
const EXTENDED_FALLBACK_PATHS = [
  '/contact',
  '/contact-us',
  '/nous-contacter',
  '/coordonnees',
];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Mots-clés (lowercase, accents normalisés) qui font qu'une anchor est
// considérée pertinente pour la validation.
const ANCHOR_KEYWORDS = [
  'mentions legales',
  'mentions légales',
  'mentions',
  'legal',
  'légal',
  'cgv',
  'cgu',
  'conditions',
  'about',
  'a propos',
  'à propos',
];

/**
 * Fetch home + pages annexes pour validation.
 *
 * @param {string} siteUrl — URL canonique normalisée
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]            Injection pour tests
 * @param {number}   [opts.perPageTimeoutMs]
 * @param {number}   [opts.totalTimeoutMs]
 * @param {number}   [opts.maxAdditionalPages]
 * @param {boolean}  [opts.extendedPaths]        AirWorker uniquement — ajoute
 *                                               /contact et variantes aux paths
 *                                               de fallback.
 * @returns {Promise<Array<{ url: string, status: number, text: string, error?: string }>>}
 */
async function fetchPagesForValidation(siteUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) return [];
  const normalized = normalize(siteUrl);
  if (!normalized) return [];

  const perPageTimeoutMs = Number.isFinite(opts.perPageTimeoutMs)
    ? opts.perPageTimeoutMs
    : DEFAULT_PER_PAGE_TIMEOUT_MS;
  const totalTimeoutMs = Number.isFinite(opts.totalTimeoutMs)
    ? opts.totalTimeoutMs
    : DEFAULT_TOTAL_TIMEOUT_MS;
  const maxAdditional = Number.isFinite(opts.maxAdditionalPages)
    ? opts.maxAdditionalPages
    : MAX_ADDITIONAL_PAGES;

  const startedAt = Date.now();
  const budgetReached = () => Date.now() - startedAt > totalTimeoutMs;

  const pages = [];
  const visited = new Set();

  // 1. Fetch home
  const homeResult = await fetchOne(fetchImpl, normalized, perPageTimeoutMs);
  visited.add(normalized);
  pages.push(homeResult);

  const activeFallbackPaths = opts.extendedPaths
    ? [...FALLBACK_PATHS, ...EXTENDED_FALLBACK_PATHS]
    : FALLBACK_PATHS;

  if (!homeResult.text || homeResult.status < 200 || homeResult.status >= 400) {
    // Home indisponible ou non-2xx/3xx : on tente quand même les fallback paths
    for (const path of activeFallbackPaths) {
      if (budgetReached()) break;
      if (pages.length - 1 >= maxAdditional) break;
      const fallbackUrl = buildSameHostUrl(normalized, path);
      if (!fallbackUrl || visited.has(fallbackUrl)) continue;
      visited.add(fallbackUrl);
      const r = await fetchOne(fetchImpl, fallbackUrl, perPageTimeoutMs);
      pages.push(r);
    }
    return pages;
  }

  // 2. Parse anchors et candidate URLs
  const anchorUrls = extractAnchorCandidates(homeResult.text, normalized);

  // 3. Fallback paths si aucune anchor pertinente
  const candidateUrls = anchorUrls.length > 0
    ? anchorUrls
    : activeFallbackPaths.map((p) => buildSameHostUrl(normalized, p)).filter(Boolean);

  // 4. Fetch séquentiel, dans la limite budget + max
  for (const url of candidateUrls) {
    if (budgetReached()) break;
    if (pages.length - 1 >= maxAdditional) break;
    if (visited.has(url)) continue;
    visited.add(url);
    const r = await fetchOne(fetchImpl, url, perPageTimeoutMs);
    pages.push(r);
  }

  return pages;
}

// ─── Helpers privés ────────────────────────────────────────────────────────

async function fetchOne(fetchImpl, url, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    });
    if (timer) clearTimeout(timer);
    if (!res) return { url, status: 0, text: '', error: 'no_response' };
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return { url, status: res.status, text };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    return {
      url,
      status: 0,
      text: '',
      error: isTimeout ? 'fetch_timeout' : 'fetch_error',
    };
  }
}

/**
 * Extrait les URLs candidates depuis un HTML brut. Retourne au max
 * MAX_ADDITIONAL_PAGES URLs canonisées, dédupliquées, filtrées sur same-host.
 */
function extractAnchorCandidates(html, baseUrl) {
  if (typeof html !== 'string' || html.length === 0) return [];
  const baseHost = extractHost(baseUrl);
  if (!baseHost) return [];

  const candidates = [];
  const seen = new Set();

  // Match <a ...> avec href ET texte. On utilise une regex permissive — pas
  // de parser HTML complet (R-J6 : on n'introduit pas de dépendance lourde).
  // Le pattern accepte les anchor sur plusieurs lignes via `[\s\S]`.
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const href = match[1];
    const anchorText = stripTags(match[2]).toLowerCase();
    if (!matchesAnchorKeyword(anchorText)) continue;

    const resolved = resolveUrl(href, baseUrl);
    if (!resolved) continue;
    if (extractHost(resolved) !== baseHost) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push(resolved);
    if (candidates.length >= MAX_ADDITIONAL_PAGES) break;
  }

  return candidates;
}

function matchesAnchorKeyword(text) {
  if (!text) return false;
  const cleaned = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const kw of ANCHOR_KEYWORDS) {
    const cleanedKw = kw.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (cleaned.includes(cleanedKw)) return true;
  }
  return false;
}

function stripTags(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');
}

function resolveUrl(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return normalize(u.toString());
  } catch {
    return null;
  }
}

function buildSameHostUrl(baseUrl, path) {
  try {
    const u = new URL(baseUrl);
    u.pathname = path;
    u.search = '';
    u.hash = '';
    return normalize(u.toString());
  } catch {
    return null;
  }
}

module.exports = {
  fetchPagesForValidation,
  // Exposés pour tests :
  _internals: {
    extractAnchorCandidates,
    matchesAnchorKeyword,
    buildSameHostUrl,
    USER_AGENT,
    FALLBACK_PATHS,
    EXTENDED_FALLBACK_PATHS,
    DEFAULT_PER_PAGE_TIMEOUT_MS,
    DEFAULT_TOTAL_TIMEOUT_MS,
    MAX_ADDITIONAL_PAGES,
  },
};
