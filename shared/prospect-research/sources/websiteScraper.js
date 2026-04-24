'use strict';

/**
 * Source : scraping léger du site public de l'entreprise.
 *
 * Fetch une liste ciblée de pages clés (/, /a-propos, /nos-clients, …),
 * retire le bruit (scripts, styles, nav, footer, cookies, menu) et extrait
 * un texte utile concaténé. Destiné à être passé à un LLM pour extraction
 * structurée côté companyProfile.js.
 *
 * Choix de design :
 *  - Aucune dépendance HTML-parser (cheerio, jsdom) : on vise un minimum
 *    de surface d'attaque et de coût install. Regex + heuristiques.
 *  - Budget global strict (timeout total, nombre max de pages) pour tenir
 *    le budget couche A de 30s.
 *  - Dégradation gracieuse : site down, 404 partout, robots.txt (non testé
 *    ici), JS-only → on retourne au minimum un résultat avec texts=[] et
 *    visitedPages=[]. Le caller continue.
 *  - Respect User-Agent explicite "PerenneoProfiler/1.0" : un UA identifiable
 *    est plus poli que le défaut et permet aux admins de nous contacter si
 *    besoin (aucune obfuscation).
 */

const DEFAULT_PATHS = [
  '/',
  '/a-propos',
  '/about',
  '/qui-sommes-nous',
  '/nos-clients',
  '/clients',
  '/references',
  '/services',
  '/nos-services',
  '/expertise',
  '/actualites',
  '/news',
  '/blog',
];

const DEFAULT_MAX_PAGES = 6;
const DEFAULT_PAGE_TIMEOUT_MS = 5000;
const DEFAULT_GLOBAL_BUDGET_MS = 25000;
const DEFAULT_MAX_CHARS_PER_PAGE = 8000;
const DEFAULT_USER_AGENT = 'PerenneoProfiler/1.0 (+https://oseys.fr)';

/**
 * @param {string} domain                 ex. "acme.fr" ou "https://acme.fr"
 * @param {object} [opts]
 * @param {string[]}   [opts.paths]            Pages à tester (défaut DEFAULT_PATHS)
 * @param {number}     [opts.maxPages]         Pages max fetchées (défaut 6)
 * @param {number}     [opts.pageTimeoutMs]    Timeout par page (défaut 5000)
 * @param {number}     [opts.globalBudgetMs]   Budget total (défaut 25000)
 * @param {number}     [opts.maxCharsPerPage]  Tronque texte extrait
 * @param {string}     [opts.userAgent]
 * @param {Function}   [opts.fetchImpl]        Injectable (tests)
 * @returns {Promise<{
 *   domain: string,
 *   visitedPages: Array<{url: string, status: number, charCount: number}>,
 *   texts: Array<{url: string, text: string}>,
 *   elapsedMs: number
 * }>}
 */
async function scrapeCompanyWebsite(domain, opts = {}) {
  const started = Date.now();
  const out = { domain: String(domain || ''), visitedPages: [], texts: [], elapsedMs: 0 };

  const baseUrl = normalizeBaseUrl(domain);
  if (!baseUrl) {
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const paths = opts.paths || DEFAULT_PATHS;
  const maxPages = opts.maxPages || DEFAULT_MAX_PAGES;
  const pageTimeoutMs = opts.pageTimeoutMs || DEFAULT_PAGE_TIMEOUT_MS;
  const globalBudgetMs = opts.globalBudgetMs || DEFAULT_GLOBAL_BUDGET_MS;
  const maxCharsPerPage = opts.maxCharsPerPage || DEFAULT_MAX_CHARS_PER_PAGE;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const fetchImpl = opts.fetchImpl || fetch;

  for (const path of paths) {
    if (out.texts.length >= maxPages) break;
    if (Date.now() - started > globalBudgetMs) break;

    const url = joinUrl(baseUrl, path);
    const entry = await fetchOnePage(url, {
      fetchImpl,
      userAgent,
      timeoutMs: pageTimeoutMs,
    });
    out.visitedPages.push({ url, status: entry.status, charCount: entry.text.length });
    if (entry.text) {
      out.texts.push({
        url,
        text: entry.text.slice(0, maxCharsPerPage),
      });
    }
  }

  out.elapsedMs = Date.now() - started;
  return out;
}

async function fetchOnePage(url, { fetchImpl, userAgent, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr,en;q=0.8',
      },
    });
    if (!res || !res.ok) return { status: (res && res.status) || 0, text: '' };
    const html = await res.text();
    return { status: res.status, text: extractTextFromHtml(html) };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrait un texte utile d'un HTML : retire scripts, styles, head, nav, footer,
 * aside, et bannières cookie (heuristique sur classes courantes). Collapse
 * les whitespaces, décode quelques entités HTML basiques.
 *
 * Export nommé pour tests — aucune dépendance externe.
 */
function extractTextFromHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  let s = html;

  // 1. Virer les blocs non-texte
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');

  // 2. Virer blocs "bruit" (nav, footer, aside, menu). On tolère le cas où la
  // balise ouvrante contient classes/id/attrs arbitraires.
  s = s.replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
  s = s.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ');
  // Bannières cookie typiques : <div class="cookie-…"> / id="cookie-…" / id="cookieConsent"
  s = s.replace(
    /<(div|section|aside)\b[^>]*(class|id)\s*=\s*["'][^"']*?(cookie|consent|gdpr|rgpd)[^"']*?["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );

  // 3. Remplacer les balises par espaces
  s = s.replace(/<[^>]+>/g, ' ');

  // 4. Entités HTML courantes
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&agrave;/gi, 'à')
    .replace(/&acirc;/gi, 'â')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&ugrave;/gi, 'ù')
    .replace(/&ocirc;/gi, 'ô')
    .replace(/&icirc;/gi, 'î')
    .replace(/&iuml;/gi, 'ï');

  // Décodage numérique basique (utile pour &#233; → é)
  s = s.replace(/&#(\d+);/g, (_m, n) => {
    const code = Number(n);
    if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return ' ';
    try {
      return String.fromCodePoint(code);
    } catch {
      return ' ';
    }
  });

  // 5. Collapse whitespaces (tabs, newlines, espaces multiples)
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

function normalizeBaseUrl(domain) {
  if (!domain) return null;
  let s = String(domain).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function joinUrl(base, path) {
  if (!path.startsWith('/')) path = `/${path}`;
  return `${base.replace(/\/$/, '')}${path}`;
}

module.exports = {
  scrapeCompanyWebsite,
  extractTextFromHtml,
  normalizeBaseUrl,
  DEFAULT_PATHS,
};
