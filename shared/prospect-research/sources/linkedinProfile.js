'use strict';

/**
 * Source : profil LinkedIn décideur public.
 *
 * V0 — STUB : retourne null avec note explicite, sans aucun appel réseau.
 *
 * Raison produit (Paul, 2026-04-23) : pas de scraping direct linkedin.com
 * sans provider tiers encapsulant les ToS. Arbitrage du provider V1
 * à trancher avant pilote commercial Prospérenne (cf. linkedinCompany.js).
 *
 * Même argument que linkedinCompany : la V0 reste exploitable sans
 * LinkedIn profil. La couche B dégrade gracieusement :
 *  - discScore.primary = 'unknown', confidence = 0
 *  - decisionMakerProfile.tone = 'unknown'
 *  - inferredPainPoints = []
 * Le pitch downstream bascule en ton neutre (confidence < 0.4).
 *
 * Shape de retour stable :
 *   {
 *     provider: 'stub' | 'proxycurl' | 'phantombuster' | 'apify' | ...,
 *     status: 'stub' | 'ok' | 'rate_limited' | 'blocked' | 'not_found' | 'error',
 *     profile: null | {
 *       fullName: string,
 *       headline?: string,
 *       currentRole?: string,
 *       currentCompany?: string,
 *       tenure?: string,
 *       location?: string,
 *       about?: string,
 *       experiences?: Array<{ role: string, company: string, start?: string, end?: string, description?: string }>,
 *       education?: Array<{ school: string, field?: string, graduationYear?: string }>,
 *       recentPosts?: Array<{ publishedAt?: string, text: string, url?: string }>,
 *       skills?: string[],
 *     },
 *     elapsedMs: number,
 *     note?: string
 *   }
 */

const STUB_NOTE =
  'stub V0 — provider LinkedIn à arbitrer (Proxycurl / PhantomBuster / Apify) ' +
  'avant pilote commercial (cf. CLAUDE_PROFILER §6.5).';

/**
 * @param {string} linkedinUrl  ex. https://www.linkedin.com/in/prenom-nom/
 * @param {object} [opts]
 * @param {string} [opts.provider]
 * @returns {Promise<{provider, status, profile, elapsedMs, note?}>}
 */
async function fetchLinkedInProfile(linkedinUrl, opts = {}) {
  const started = Date.now();
  const url = normalizeLinkedInProfileUrl(linkedinUrl);
  const provider = opts.provider || process.env.PROFILER_LINKEDIN_PROVIDER || 'stub';

  return {
    provider,
    status: 'stub',
    profile: null,
    elapsedMs: Date.now() - started,
    urlRequested: url,
    note: STUB_NOTE,
  };
}

/**
 * Normalise une URL de profil LinkedIn (/in/<slug>/). Retourne null si
 * l'URL n'est pas reconnue comme profil membre.
 */
function normalizeLinkedInProfileUrl(url) {
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
  if (!/^\/(in|pub)\//i.test(parsed.pathname)) return null;
  return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`;
}

module.exports = {
  fetchLinkedInProfile,
  normalizeLinkedInProfileUrl,
  STUB_NOTE,
};
