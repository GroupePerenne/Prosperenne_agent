'use strict';

/**
 * Source : fiche LinkedIn entreprise publique.
 *
 * V0 — STUB : retourne null avec note explicite, sans aucun appel réseau.
 *
 * Raison produit (Paul, 2026-04-23) : pas de scraping direct linkedin.com
 * sans provider tiers encapsulant les ToS. Arbitrage du provider V1
 * (Proxycurl / PhantomBuster / Apify / Bright Data) à trancher avant
 * pilote commercial Prospérenne. CLAUDE_PROFILER §6.5 + directive Q2.
 *
 * La V0 reste exploitable sans LinkedIn : API Gouv + site entreprise +
 * signaux stub suffisent pour produire un briefing couche A pertinent.
 * La couche B (décideur) dégrade gracieusement en l'absence de LinkedIn
 * via d'autres signaux (publications presse, mentions).
 *
 * Shape de retour stable (pour que le caller puisse s'y appuyer dès
 * maintenant, le provider réel sera injecté sans changer le contrat) :
 *
 *   {
 *     provider: 'stub' | 'proxycurl' | 'phantombuster' | 'apify' | ...,
 *     status: 'stub' | 'ok' | 'rate_limited' | 'blocked' | 'not_found' | 'error',
 *     company: null | {
 *       name: string,
 *       url: string,
 *       tagline?: string,
 *       description?: string,
 *       industry?: string,
 *       headcount?: string,
 *       headquarters?: string,
 *       website?: string,
 *       specialties?: string[],
 *       recentPosts?: Array<{ publishedAt?: string, text: string, url?: string }>,
 *       followers?: number,
 *     },
 *     elapsedMs: number,
 *     note?: string
 *   }
 */

const STUB_NOTE =
  'stub V0 — provider LinkedIn à arbitrer (Proxycurl / PhantomBuster / Apify) ' +
  'avant pilote commercial (cf. CLAUDE_PROFILER §6.5).';

/**
 * @param {string} linkedinUrl  ex. https://www.linkedin.com/company/acme/
 * @param {object} [opts]
 * @param {string} [opts.provider]  Provider forcé (défaut env PROFILER_LINKEDIN_PROVIDER ou 'stub')
 * @returns {Promise<{provider, status, company, elapsedMs, note?}>}
 */
async function fetchLinkedInCompany(linkedinUrl, opts = {}) {
  const started = Date.now();
  const url = normalizeLinkedInCompanyUrl(linkedinUrl);
  const provider = opts.provider || process.env.PROFILER_LINKEDIN_PROVIDER || 'stub';

  // V0 : aucun appel réseau, quelle que soit la valeur de provider.
  return {
    provider,
    status: 'stub',
    company: null,
    elapsedMs: Date.now() - started,
    urlRequested: url,
    note: STUB_NOTE,
  };
}

/**
 * Normalise une URL LinkedIn entreprise (trim, https, slash final retiré).
 * Retourne null si l'URL n'est pas reconnaissable comme une fiche entreprise.
 * Exposé pour tests.
 */
function normalizeLinkedInCompanyUrl(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return null;
  // Les URLs de société LinkedIn sont du type /company/<slug>/ ou /school/<slug>/
  if (!/^\/(company|school)\//i.test(parsed.pathname)) return null;
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`;
}

module.exports = {
  fetchLinkedInCompany,
  normalizeLinkedInCompanyUrl,
  STUB_NOTE,
};
