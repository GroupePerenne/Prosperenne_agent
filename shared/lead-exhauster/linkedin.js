'use strict';

/**
 * LinkedIn — signal d'exploration minimaliste et conservateur.
 *
 * Portée V1 (Jalon 2) : LinkedIn a des ToS stricts et détecte agressivement
 * le scraping. On limite la surface :
 *
 *   - Si `companyLinkedInUrl` ou `profileLinkedInUrl` est fourni en input,
 *     on tente UN seul GET public (pas de login, pas d'auth)
 *   - On extrait uniquement des signaux textuels à faible risque :
 *     présence du nom recherché, mentions de rôles, slug du profil
 *   - Aucune tentative de bypass wall login : si HTML bloqué → retour null
 *   - Aucun crawl de page connexe
 *   - User-Agent identifiable
 *
 * Hors scope V1 :
 *   - API LinkedIn officielle (nécessite partnership ToS dédié)
 *   - Scraping multi-pages, profil complet, publications, activité
 *   - Extraction DISC (c'est le chantier 3 profiler, pas exhauster)
 *
 * Cette version V1 est volontairement pauvre en valeur : elle existe pour
 * que l'orchestrateur ait un 4e signal disponible en étape 3d de la spec,
 * pas pour résoudre l'email à elle seule. La vraie valeur LinkedIn est
 * dans le chantier prospect-profiler.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §3.3 étape 3d + ARCHITECTURE §7.13 "LinkedIn
 * profil public (lecture, pas scraping massif — ToS propre)".
 */

const { normalizeNamePart } = require('./patterns');

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; PereneoBot/1.0; +https://perennereseau.fr)';

/**
 * Tente de récupérer un signal LinkedIn pour un décideur.
 *
 * @param {Object} input
 * @param {string} [input.companyLinkedInUrl]
 * @param {string} [input.profileLinkedInUrl]
 * @param {string} [input.firstName]
 * @param {string} [input.lastName]
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<{ matched:boolean, signals:string[], profileSlug:string|null, roleHint:string|null, elapsedMs:number }>}
 */
async function probeLinkedIn(input = {}, opts = {}) {
  const started = Date.now();
  const out = {
    matched: false,
    signals: [],
    profileSlug: null,
    roleHint: null,
    elapsedMs: 0,
  };

  const url = input.profileLinkedInUrl || input.companyLinkedInUrl;
  if (!url || !isLinkedInUrl(url)) {
    out.signals.push('no_linkedin_url');
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const slug = extractProfileSlug(url);
  if (slug) out.profileSlug = slug;

  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    out.signals.push('fetch_missing');
    out.elapsedMs = Date.now() - started;
    return out;
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': opts.userAgent || DEFAULT_USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
      signal: controller ? controller.signal : undefined,
      redirect: 'follow',
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    out.signals.push('network_error');
    out.elapsedMs = Date.now() - started;
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || !res.ok) {
    // LinkedIn bloque souvent 999 (non-standard). On ne retry pas, on log.
    out.signals.push(`http_${res ? res.status : 'no_response'}`);
    out.elapsedMs = Date.now() - started;
    return out;
  }

  let html = '';
  try {
    html = await res.text();
  } catch {
    out.signals.push('text_read_error');
    out.elapsedMs = Date.now() - started;
    return out;
  }

  // Wall login LinkedIn : détection basique par phrase stable
  const isWall = /authwall|sign in to linkedin|join linkedin|connect with/i.test(html);
  if (isWall) out.signals.push('auth_wall_detected');

  // Match nom recherché
  const first = normalizeNamePart(input.firstName);
  const last = normalizeNamePart(input.lastName);
  const lower = html.toLowerCase();
  const firstHit = first && (lower.includes(first) || lower.includes((input.firstName || '').toLowerCase()));
  const lastHit = last && (lower.includes(last) || lower.includes((input.lastName || '').toLowerCase()));
  if (firstHit && lastHit) {
    out.matched = true;
    out.signals.push('name_match_full');
  } else if (lastHit) {
    out.signals.push('name_match_last_only');
  }

  // Indices de rôle : scan très grossier sur les mots-clés direction
  const roleHints = ['ceo', 'founder', 'co-founder', 'cofondateur', 'président', 'directeur général', 'gérant', 'managing director'];
  for (const kw of roleHints) {
    if (lower.includes(kw)) {
      out.roleHint = kw;
      out.signals.push(`role_hint_${kw.replace(/\s/g, '_')}`);
      break;
    }
  }

  out.elapsedMs = Date.now() - started;
  return out;
}

/**
 * Valide qu'une URL est bien un sous-domaine linkedin.com.
 */
function isLinkedInUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase();
    return host === 'linkedin.com'
      || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

/**
 * Extrait le slug de profil `/in/<slug>/` d'une URL LinkedIn.
 * Retourne null si absent.
 */
function extractProfileSlug(url) {
  if (!isLinkedInUrl(url)) return null;
  try {
    const parsed = new URL(url);
    const m = parsed.pathname.match(/\/in\/([^/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  probeLinkedIn,
  isLinkedInUrl,
  extractProfileSlug,
  _constants: { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT },
};
