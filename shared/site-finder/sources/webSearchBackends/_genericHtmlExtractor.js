'use strict';

/**
 * Extracteur HTML générique pour les backends webSearch sans clé API.
 *
 * Pourquoi générique : DDG Lite, Mojeek, Ecosia (et la plupart des moteurs
 * "lite" / sans-JS) utilisent des classes CSS variables d'une version à
 * l'autre. Pour rester robuste aux changements HTML mineurs, on extrait
 * tous les `<a href="https://...">` du document, on retire les hosts
 * internes du moteur (navigation, footer, ads), on déduplique sur l'URL
 * canonique, et on limite à maxResults dans l'ordre d'apparition.
 *
 * Le filtrage des agrégateurs métiers (societe.com, linkedin.com…) reste
 * de la responsabilité de `webSearch.js` (pour ne pas dupliquer la liste).
 *
 * Détection blocked : heuristiques génériques + patterns Cloudflare. Ne
 * remplace pas les détections spécifiques d'un backend (ex: anomaly DDG)
 * mais sert de filet de secours pour les nouveaux backends.
 */

const { normalize } = require('../../utils/urlNormalizer');

// Marqueurs anti-bot transverses observés sur Cloudflare, Akamai, Imperva,
// PerimeterX. Si l'un est présent dans le body, on classe blocked.
const BLOCKED_MARKERS = [
  'just a moment',                         // Cloudflare challenge
  'cf-challenge',
  'ddos protection by cloudflare',
  'cf-mitigated',
  'verify you are human',
  'verify you are a human',
  'i\'m not a robot',
  'recaptcha',
  'hcaptcha',
  'g-recaptcha',
  'pxhuman',                                // PerimeterX
  '_pxcaptcha',
  'access denied',
  'access has been blocked',
  '<title>403 forbidden',
  '<title>access denied',
];

const ANCHOR_RE = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

// Patterns d'URLs publicitaires/tracking à exclure des résultats de recherche.
// Les moteurs comme DDG Lite et Mojeek incluent parfois les liens sponsorisés
// avant les résultats organiques dans le HTML, sans redirection interne filtrable.
const AD_URL_PATTERNS = [
  /[?&]gclid=/i,           // Google Ads click ID
  /[?&]fbclid=/i,          // Facebook Ads click ID
  /[?&]msclkid=/i,         // Microsoft/Bing Ads click ID
  /\/aclk\b/i,             // Google Ads click redirect path
  /\/pagead\//i,            // Google display ads
  /bing\.com\/ck\/a\b/i,   // Bing Ads click redirect
  /yahoo\.com\/rd\//i,     // Yahoo ads redirect
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
];

function looksLikeAd(url) {
  for (const re of AD_URL_PATTERNS) {
    if (re.test(url)) return true;
  }
  return false;
}

/**
 * Détecte si un body HTML correspond à un challenge anti-bot transverse.
 */
function looksBlocked(body) {
  if (typeof body !== 'string' || body.length === 0) return false;
  const lower = body.toLowerCase();
  for (const marker of BLOCKED_MARKERS) {
    if (lower.includes(marker)) return true;
  }
  return false;
}

/**
 * Extrait les résultats d'un body HTML en filtrant les hosts internes au
 * moteur (`engineHosts`) et en dédupant. Retourne un array
 * `[{ url, title, rank }]` borné à `maxResults`.
 *
 * Le filtre `excludeHostSuffixes` accepte des hosts complets ou des
 * suffixes (ex: 'mojeek.com' filtre aussi 'www.mojeek.com').
 *
 * @param {string} body
 * @param {Object} opts
 * @param {string[]} opts.excludeHostSuffixes  hosts internes du moteur
 * @param {number}   opts.maxResults
 * @returns {Array<{url:string, title:string, rank:number}>}
 */
function extractResults(body, { excludeHostSuffixes = [], maxResults = 10 } = {}) {
  if (typeof body !== 'string' || body.length === 0) return [];

  const results = [];
  const seenUrls = new Set();
  const exclude = excludeHostSuffixes.map((h) => h.toLowerCase());

  let m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(body)) !== null) {
    if (results.length >= maxResults) break;
    const rawHref = m[1];
    const inner = m[2];
    if (!rawHref) continue;

    let parsed;
    try {
      parsed = new URL(rawHref);
    } catch {
      continue;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) continue;
    if (isInternalHost(host, exclude)) continue;
    if (looksLikeAd(rawHref)) continue;

    const normalized = normalize(rawHref);
    if (!normalized) continue;
    if (seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);

    const title = decodeEntities(stripTags(inner)).trim();
    results.push({
      url: normalized,
      title,
      rank: results.length + 1,
    });
  }

  return results;
}

function isInternalHost(host, excludeSuffixes) {
  for (const suffix of excludeSuffixes) {
    if (host === suffix) return true;
    if (host.endsWith(`.${suffix}`)) return true;
  }
  return false;
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
  looksBlocked,
  extractResults,
  // Exposés pour tests :
  _internals: {
    BLOCKED_MARKERS,
    AD_URL_PATTERNS,
    isInternalHost,
    looksLikeAd,
    stripTags,
    decodeEntities,
  },
};
