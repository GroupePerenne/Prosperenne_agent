'use strict';

/**
 * Backend Playwright Google — scraping Google Search via Chromium headless local.
 *
 * Conçu pour usage AirWorker LOCAL (Mac dédié) où l'IP résidentielle FAI est
 * traitée comme un navigateur normal par Google. À NE PAS UTILISER en FA Azure
 * (Linux Consumption ne supporte pas les browsers headless + IP datacenter
 * banni rapidement).
 *
 * Avantages vs API payantes (Brave Pro / Google CSE / Bing) :
 *   - 0€ permanent (pas de cap mensuel)
 *   - Index Google complet (pas un sous-ensemble comme Brave)
 *   - IP résidentielle = pas de ban si throttle correct
 *
 * Inconvénients :
 *   - Latence ~2-5s par query (browser launch + nav + parse)
 *   - Risque CAPTCHA si flood (à gérer via throttle + détection)
 *   - Dépendance binary Chromium ~150 MB
 *
 * S9 (8 mai 2026) — backend ajouté en remplacement Brave (cap atteint) +
 * DDG/Mojeek/Ecosia (bannis). Mandat Paul : "pur code local, pas d'appel à
 * fonctions serveur ou autre".
 *
 * Architecture :
 *   - Browser context global (lazy init) réutilisé entre queries pour éviter
 *     le coût de relance Chromium à chaque appel
 *   - Détection CAPTCHA via URL redirect /sorry/ + selectors body
 *   - Parse résultats via sélecteurs robustes : div.g h3 → ancestor a
 *   - Throttle externe imposé par le caller (pas dans ce module)
 */

const { SearchBlockedError, SearchTransientError } = require('./_searchErrors');
const { normalize } = require('../../utils/urlNormalizer');
const { isAggregator } = require('../../aggregators');

const BACKEND_ID = 'playwright_google';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_URL = 'https://www.google.com/search';

const REALISTIC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Browser global lazy init. Réutilisé entre queries au sein du même process
// pour économiser le coût de relance Chromium (~2s par query sinon).
let _browser = null;
let _context = null;

async function getBrowserContext(opts = {}) {
  if (_context) return _context;
  const { chromium } = require('playwright');
  _browser = await chromium.launch({
    headless: opts.headless !== false,
    args: [
      // Réduit la détection automation
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  _context = await _browser.newContext({
    userAgent: REALISTIC_UA,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    viewport: { width: 1280, height: 800 },
    // Pas de proxy : IP résidentielle de la machine hôte
  });
  return _context;
}

/**
 * Ferme le browser global. À appeler en fin de batch ou de process pour
 * libérer les ressources Chromium.
 */
async function closeBrowser() {
  try {
    if (_context) await _context.close();
  } catch { /* ignore */ }
  try {
    if (_browser) await _browser.close();
  } catch { /* ignore */ }
  _context = null;
  _browser = null;
}

/**
 * Lance une recherche Google via Chromium headless.
 *
 * @param {string} query
 * @param {Object} [opts]
 * @param {number}  [opts.timeoutMs]    Timeout navigation (défaut 15s)
 * @param {number}  [opts.maxResults]   Cap résultats parsés (défaut 10)
 * @param {boolean} [opts.headless]     Override headless mode (défaut true)
 * @returns {Promise<Array<{url, title, rank}>>}
 */
async function search(query, opts = {}) {
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxResults = Number.isFinite(opts.maxResults) ? opts.maxResults : DEFAULT_MAX_RESULTS;

  let context;
  try {
    context = await getBrowserContext(opts);
  } catch (err) {
    throw new SearchTransientError(`playwright launch failed: ${err && err.message}`);
  }

  const page = await context.newPage();
  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query.trim())}&hl=fr&gl=fr&num=${maxResults}`;

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
    } catch (err) {
      const isTimeout = err && /timeout|timed out/i.test(String(err.message || ''));
      throw new SearchTransientError(
        isTimeout ? 'google nav timeout' : `google nav error: ${err && err.message}`,
      );
    }

    // Détection CAPTCHA / soft-ban Google
    const finalUrl = page.url();
    if (/\/sorry\//.test(finalUrl) || /consent\.google/.test(finalUrl)) {
      throw new SearchBlockedError('captcha_or_consent', response ? response.status() : null);
    }

    // Détection consent banner européen (Google EU) - on click "Tout accepter"
    // si présent pour passer la première fois. Ensuite cookie posé.
    const consentBtn = await page.$('button[aria-label*="Tout accepter" i], button:has-text("Tout accepter"), button:has-text("Accept all")');
    if (consentBtn) {
      try {
        await consentBtn.click({ timeout: 3000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      } catch { /* on continue, le parse se fera quand même */ }
    }

    // Détection "unusual traffic" via texte body
    const bodyText = await page.evaluate(() => document.body && document.body.innerText || '');
    if (/unusual traffic|not a robot|trafic inhabituel/i.test(bodyText.slice(0, 2000))) {
      throw new SearchBlockedError('unusual_traffic_warning', null);
    }

    // Parse résultats : sélecteur moderne Google
    // Stratégie robuste : tous les liens dans des conteneurs div.g ou div[data-hveid]
    // qui ne sont PAS les liens internes Google (/url?q=, /search?, etc.)
    const rawResults = await page.evaluate((cap) => {
      const out = [];
      const seen = new Set();
      // Sélecteur principal : conteneurs résultats organiques
      const containers = document.querySelectorAll('div.g, div[data-hveid][data-ved], div[jscontroller]');
      for (const container of containers) {
        if (out.length >= cap) break;
        const h3 = container.querySelector('h3');
        const link = container.querySelector('a[href]');
        if (!h3 || !link) continue;
        const href = link.getAttribute('href') || '';
        // Skip liens internes Google
        if (href.startsWith('/search') || href.startsWith('/url?')) continue;
        if (!href.startsWith('http')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({
          url: href,
          title: h3.innerText || '',
        });
      }
      return out;
    }, maxResults);

    // Normalisation URL + filtrage agrégateurs.
    //
    // S11 (8 mai 2026) — précision Paul : un agrégateur (pages-jaunes,
    // odella, prosmaison, datalegal, e-pro, rubypayeur, mappy, etc.) ne doit
    // JAMAIS être retourné comme résultat final, car cela ferait poser un
    // companyDomain pollué (le caller utilise le 1er résultat). Solution
    // V0 : skip pur de tous les agrégateurs des résultats retournés. La
    // cascade Google explore alors les résultats suivants. Si tous les
    // résultats top-N sont agrégateurs, on retourne [] et le caller traite
    // le lead comme "no domain officiel trouvé".
    //
    // V1 futur (non implémenté) : visiter la page agrégateur la mieux
    // classée pour extraire le vrai site web mentionné dans la fiche
    // entreprise. Plus complexe (parsing HTML + extraction outbound URLs)
    // mais récupèrerait des cas où Google ne retourne pas le site officiel
    // dans les top résultats.
    const out = [];
    const seen = new Set();
    let skippedAggregators = 0;
    for (const r of rawResults) {
      if (out.length >= maxResults) break;
      const normalized = normalize(r.url);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (isAggregator(normalized)) {
        skippedAggregators++;
        continue;
      }
      out.push({
        url: normalized,
        title: r.title || '',
        rank: out.length + 1,
      });
    }
    // Trace pour audit/debug — les agrégateurs filtrés sont attachés au
    // résultat global pour que le caller puisse les inspecter en V1.
    if (out.length > 0 && skippedAggregators > 0) {
      // Non standard sur l'objet array, mais utile en debug AirWorker.
      out.skippedAggregators = skippedAggregators;
    }
    return out;
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  search,
  closeBrowser,
  SearchBlockedError,
  SearchTransientError,
  BACKEND_ID,
  _internals: {
    SEARCH_URL,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RESULTS,
    REALISTIC_UA,
  },
};
