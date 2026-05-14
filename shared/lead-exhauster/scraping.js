'use strict';

/**
 * Scraping léger site entreprise pour extraction d'emails et identification
 * de décideurs. Cible les pages conventionnelles FR où un site corporate
 * expose nom, rôle et email : /contact, /equipe, /a-propos, /mentions-legales,
 * /about, /team, et la page d'accueil en dernier recours.
 *
 * Portée V1 (Jalon 2) :
 *   - Fetch GET uniquement, User-Agent identifiable (PereneoBot)
 *   - Timeout par page + timeout global
 *   - Extraction emails via regex conservative
 *   - Filtrage junk (contact@, info@, admin@…)
 *   - Scoring contextuel : local-part matche nom/prénom + proximité nom/email
 *     dans le HTML (fenêtre glissante)
 *   - Extraction très basique de blocs "équipe" (nom + rôle) pour
 *     resolveDecisionMaker
 *
 * Hors scope V1 :
 *   - JS rendering (pas de Puppeteer ou équivalent — V1 sans DOM)
 *   - Pagination profonde
 *   - Parsing sémantique structuré (Schema.org Person)
 *   - Retry différé sur 429 (on saute la page et on log)
 *
 * Philosophie respect ToS : un site accessible publiquement sans login
 * autorise en général la lecture GET. On ne déclenche jamais plus de
 * ~8 requêtes vers un même domaine par run, et on respecte robots.txt
 * sur bonnes volonté (lecture robots.txt V2).
 */

const { normalizeNamePart, normalizeDomain } = require('./patterns');

const DEFAULT_PAGE_TIMEOUT_MS = 8000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 20000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; PereneoBot/1.0; +https://perennereseau.fr)';

// Pages visées par ordre de probabilité d'y trouver des décideurs/emails.
// La page d'accueil en dernier recours (signal plus dilué).
//
// S6 (8 mai 2026) — réduction 9 → 6 pages pour FA Azure runtime (latence ↓
// ~24s pire-cas sur globalTimeout 20s). Mode FAST par défaut.
const TARGET_PATHS_FAST = Object.freeze([
  '/contact',
  '/equipe',
  '/a-propos',
  '/team',
  '/about',
  '/',
]);

// S10 (8 mai 2026) — mode EXHAUSTIVE pour AirWorker local : les mentions
// légales et CGV sont des **mines d'or** pour TPE FR (email gérant
// légalement obligatoire en mentions légales). En mode local, pas de
// contrainte timeout FA 230s, on peut prendre le temps. Ajout de pages
// FR-spécifiques.
const TARGET_PATHS_EXHAUSTIVE = Object.freeze([
  '/contact',
  '/contactez-nous',
  '/equipe',
  '/notre-equipe',
  '/a-propos',
  '/qui-sommes-nous',
  '/team',
  '/about',
  '/mentions-legales',
  '/mentions',
  '/legal',
  '/cgv',
  '/cgu',
  '/conditions-generales',
  '/',
]);

// Backward compat : TARGET_PATHS reste exposé en mode FAST (consommateurs FA).
const TARGET_PATHS = TARGET_PATHS_FAST;

// Local-parts "catch-all" qui ne portent pas d'identité individuelle.
// Exception : on les remonte quand même avec confidence basse (0.40)
// pour que l'orchestrateur les utilise en dernier recours si rien d'autre.
const JUNK_LOCAL_PARTS = new Set([
  'contact', 'info', 'infos', 'admin', 'noreply', 'no-reply', 'hello',
  'bonjour', 'mail', 'webmaster', 'postmaster', 'support', 'abuse',
  'root', 'press', 'presse', 'marketing', 'commercial', 'sales',
  'rh', 'hr', 'hello', 'team', 'equipe',
]);

// Regex conservative : évite de capturer des chaînes comme "@media"
// dans du CSS ou "@2x" dans des noms d'image.
const EMAIL_REGEX = /\b[A-Za-z0-9]([A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?\.[A-Za-z]{2,}\b/g;

// Mots-clés indiquant un rôle de direction/management. Utilisés pour scorer
// les profils scrapés dans resolveDecisionMaker + donner un léger boost
// de confiance aux emails trouvés à proximité.
const ROLE_KEYWORDS = Object.freeze({
  // Priorité 1 — cibles commerciales directes
  high: [
    'président', 'presidente', 'directeur général', 'directrice générale',
    'directeur general', 'dg ', 'p.d.g', 'pdg', 'ceo', 'fondateur',
    'fondatrice', 'founder', 'co-founder', 'cofondateur',
    'directeur commercial', 'directrice commerciale', 'chief revenue',
    'head of sales', 'sales director', 'vp sales',
    'gérant', 'gerante', 'gerant', 'managing director', 'associé',
  ],
  // Priorité 2 — décideurs fonctionnels pertinents PME
  mid: [
    'directeur', 'directrice', 'director', 'head of', 'responsable',
    'daf', 'dsi', 'drh', 'cto', 'coo', 'cfo', 'cmo', 'chro',
    'directeur marketing', 'directrice marketing',
    'directeur des opérations', 'directeur technique',
  ],
  // Priorité 3 — opérationnels, faible pertinence commerciale
  low: [
    'consultant', 'commercial', 'chargé', 'charge ', 'chargée',
    'account', 'business developer', 'bde', 'sdr',
  ],
});

// ─── Fetch ───────────────────────────────────────────────────────────────

/**
 * Fetch GET minimaliste avec timeout. Retourne { ok, status, text, error }.
 * Best effort : aucune exception ne sort.
 */
async function fetchPage(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) return { ok: false, error: new Error('fetch_missing') };

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_PAGE_TIMEOUT_MS;
  const ua = opts.userAgent || DEFAULT_USER_AGENT;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
      },
      signal: controller ? controller.signal : undefined,
      redirect: 'follow',
    });
    if (timer) clearTimeout(timer);
    if (!res || !res.ok) return { ok: false, status: res && res.status };
    const contentType = (res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : '') || '';
    if (!/text\/html|application\/xhtml/.test(contentType)) {
      return { ok: false, error: new Error('not_html'), status: res.status };
    }
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: err };
  }
}

// ─── Extraction emails ───────────────────────────────────────────────────

/**
 * Décode un email obfusqué par Cloudflare Email Protection.
 * Cloudflare encode l'email dans l'attribut data-cfemail avec un XOR :
 *   data-cfemail="RRXXXX..." — premier octet = clé XOR, reste = payload.
 * Retourne null si l'attribut est absent ou malformé.
 */
function decodeCloudflareEmail(cfemail) {
  if (!cfemail || typeof cfemail !== 'string') return null;
  const hex = cfemail.replace(/\s/g, '');
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let email = '';
    for (let i = 2; i < hex.length; i += 2) {
      email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    // Validation minimale : doit ressembler à un email
    if (!email.includes('@') || !email.includes('.')) return null;
    return email.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extrait les emails depuis les blocs JSON-LD (Schema.org @type Person,
 * Organization, LocalBusiness). Couvre les CMS modernes (Wix, Squarespace,
 * WordPress Yoast) qui génèrent du JSON-LD avec un champ "email".
 */
function extractEmailsFromJsonLd(html) {
  if (!html) return [];
  const out = [];
  const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = JSONLD_RE.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      collectEmailsFromObj(data, out);
    } catch { /* JSON malformé — on ignore */ }
  }
  return out;
}

function collectEmailsFromObj(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach((x) => collectEmailsFromObj(x, out)); return; }
  if (obj.email && typeof obj.email === 'string') {
    const e = obj.email.toLowerCase().trim();
    if (e.includes('@')) out.push(e);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') collectEmailsFromObj(v, out);
  }
}

/**
 * Extrait tous les emails valides d'un HTML. Dédupliqués (lowercase).
 * Filtre les matches qui ressemblent à des tokens CSS / noms d'image.
 * Filtre aussi les emails dont le domaine ne matche pas `expectedDomain`
 * si fourni (évite de capturer des adresses tierces type "support@gmail.com").
 *
 * Sources combinées :
 *   1. Regex sur le texte brut (mailto:, texte visible, attributs)
 *   2. Cloudflare data-cfemail (obfuscation XOR)
 *   3. JSON-LD Schema.org (CMS modernes)
 */
function extractEmailsFromHtml(html, { expectedDomain } = {}) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  const out = [];
  const normExpected = expectedDomain ? normalizeDomain(expectedDomain) : null;

  const addEmail = (raw) => {
    if (!raw) return;
    const email = raw.toLowerCase().trim();
    if (seen.has(email)) return;
    seen.add(email);
    const local = email.split('@')[0];
    if (!local) return;
    if (/^\d+x$/.test(local)) return;
    if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(email)) return;
    if (normExpected) {
      const domain = email.split('@')[1];
      if (!domain) return;
      if (domain !== normExpected && !domain.endsWith('.' + normExpected)) return;
    }
    out.push(email);
  };

  // 1. Regex brut
  const matches = html.match(EMAIL_REGEX) || [];
  for (const raw of matches) addEmail(raw);

  // 2. Cloudflare data-cfemail
  const CF_RE = /data-cfemail="([0-9a-fA-F]+)"/g;
  let cfm;
  while ((cfm = CF_RE.exec(html)) !== null) {
    addEmail(decodeCloudflareEmail(cfm[1]));
  }

  // 3. JSON-LD
  for (const e of extractEmailsFromJsonLd(html)) addEmail(e);

  return out;
}

/**
 * Détecte si l'email est un alias générique sans signal d'identité.
 * Exposé pour tests et pour l'orchestrateur (qui peut choisir de garder
 * ou rejeter selon qu'il a d'autres candidats).
 */
function isJunkEmail(email) {
  if (!email || typeof email !== 'string') return true;
  const local = email.split('@')[0].toLowerCase();
  return JUNK_LOCAL_PARTS.has(local);
}

// ─── Scoring de contexte ─────────────────────────────────────────────────

/**
 * Calcule un score de confiance 0-1 pour un email trouvé dans un HTML,
 * en croisant avec un firstName/lastName attendu :
 *
 *   - local-part matche le prénom, nom, ou prenom.nom normalisés → +0.35
 *   - nom/prénom mentionné dans les 500 caractères autour de l'email → +0.20
 *   - junk alias (contact@, info@…) sans autre signal → 0.40 (seuil bas)
 *   - aucun lien au nom → 0.25 base
 *
 * Le score est un prior pour l'orchestrateur qui combine avec la confiance
 * du pattern si l'email vient d'une application pattern vérifiée.
 */
function scoreEmailAgainstName(email, html, { firstName, lastName } = {}) {
  if (!email) return 0;
  const first = normalizeNamePart(firstName);
  const last = normalizeNamePart(lastName);
  const local = email.split('@')[0].toLowerCase();
  const localNorm = normalizeNamePart(local);

  const junk = isJunkEmail(email);
  let score = junk ? 0.40 : 0.25;

  // local-part match nom/prénom (plusieurs formes possibles)
  if (first || last) {
    const matchForms = [];
    if (first && last) {
      matchForms.push(`${first}.${last}`, `${first}${last}`, `${first}-${last}`, `${first}_${last}`);
      matchForms.push(`${first.charAt(0)}.${last}`, `${first.charAt(0)}${last}`);
      matchForms.push(`${first}.${last.charAt(0)}`);
    }
    if (first) matchForms.push(first);
    if (last) matchForms.push(last);

    for (const form of matchForms) {
      if (localNorm === form) {
        score += 0.35;
        break;
      }
    }
  }

  // proximité nom/prénom dans le HTML à proximité de l'email
  if (html && (first || last)) {
    const idx = html.toLowerCase().indexOf(email);
    if (idx >= 0) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(html.length, idx + email.length + 500);
      const windowText = html.slice(start, end).toLowerCase();
      // on compare sur le HTML brut ; les noms y sont souvent avec accents
      // donc on teste plusieurs formes du nom
      const firstLower = String(firstName || '').toLowerCase();
      const lastLower = String(lastName || '').toLowerCase();
      const firstNorm = first;
      const lastNorm = last;
      const nameHit = (firstLower && windowText.includes(firstLower))
        || (lastLower && windowText.includes(lastLower))
        || (firstNorm && windowText.includes(firstNorm))
        || (lastNorm && windowText.includes(lastNorm));
      if (nameHit) score += 0.20;
    }
  }

  // plafonnement à 0.90 — le scraping seul ne peut pas atteindre 1.0,
  // il faut une vérification Dropcontact ou un canal externe pour ça.
  if (score > 0.90) score = 0.90;
  return score;
}

// ─── Extraction profils "équipe" ─────────────────────────────────────────

/**
 * Heuristique simple pour extraire des tuples (nom complet, rôle) d'un HTML
 * de page équipe. Ne prétend pas à l'exhaustivité : on cherche les patterns
 * `<hN>Prénom Nom</hN>` suivis (dans les 300 chars) d'un mot-clé de rôle.
 *
 * Utilisé par resolveDecisionMaker. Retourne [{ firstName, lastName, role,
 * roleKeyword, roleScore }].
 */
function extractTeamProfiles(html) {
  if (!html || typeof html !== 'string') return [];
  const profiles = [];
  const seen = new Set();

  // Pattern <h1>-<h6> OU <strong> ou <p class="name">. On reste simple et
  // privilégie les headers.
  const HEADER_RE = /<(h[1-6]|strong|b)[^>]*>([^<]{4,80})<\/\1>/gi;
  let m;
  while ((m = HEADER_RE.exec(html)) !== null) {
    const text = decodeBasicHtml(m[2]).trim();
    const nameParts = parseFullName(text);
    if (!nameParts) continue;
    const key = `${nameParts.firstName}|${nameParts.lastName}`;
    if (seen.has(key)) continue;

    // Cherche un mot-clé rôle dans les 300 chars qui suivent le header
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const roleInfo = findRoleInSnippet(tail);

    seen.add(key);
    profiles.push({
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      role: roleInfo.role,
      roleKeyword: roleInfo.keyword,
      roleScore: roleInfo.score,
    });
  }
  return profiles;
}

function decodeBasicHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è');
}

/**
 * Particules usuelles autorisées en minuscules entre deux noms propres
 * (ex. "Pierre de la Fontaine"). Toute autre partie doit démarrer par
 * une majuscule pour être considérée comme nom propre.
 */
const NAME_PARTICLES = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'd', 'von', 'van', 'el', 'al',
  'da', 'di', 'do', 'dos', 'della', 'delle', 'dello', 'di', 'san',
]);

/**
 * Mots fréquents de titres de section / menu qui ne sont JAMAIS des noms
 * propres, même si capitalisés. Filtre les faux positifs sur `extractTeamProfiles`
 * qui scanne les headers HTML.
 */
const NON_NAME_WORDS = new Set([
  'nos', 'notre', 'votre', 'mes', 'mon', 'nous',
  'services', 'service', 'offres', 'offre', 'produits', 'produit',
  'bienvenue', 'accueil', 'contact', 'contacts', 'propos',
  'equipe', 'équipe', 'presentation', 'présentation',
  'actualites', 'actualités', 'actus', 'blog', 'article', 'articles',
  'tarifs', 'prix', 'pricing', 'prices', 'about', 'team', 'home',
  'mentions', 'legales', 'légales', 'cgv', 'cgu', 'politique',
  'qui', 'sommes', 'voici', 'bonjour', 'retrouvez', 'découvrez',
  'meet', 'our', 'welcome', 'pourquoi', 'comment',
]);

/**
 * Parse un texte libre en { firstName, lastName }. Accepte "Prénom Nom"
 * et "Prénom Nom Nom2" (nom composé) avec particules minuscules tolérées
 * (de, la, du, von…). Rejette les titres de section, phrases, URLs.
 */
function parseFullName(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (cleaned.length > 60 || cleaned.length < 4) return null;
  // rejette si contient caractères non-typiques de nom
  if (/[!?,:;@/\\|]/.test(cleaned)) return null;
  // rejette si ressemble à une URL
  if (/https?:|www\./i.test(cleaned)) return null;
  // rejette si contient un chiffre
  if (/\d/.test(cleaned)) return null;
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return null;

  // Chaque mot doit être soit une particule minuscule connue, soit
  // commencer par une majuscule. Et aucune partie ne doit être un mot
  // de menu/section (blocklist NON_NAME_WORDS).
  for (const w of words) {
    const wLower = w.toLowerCase();
    if (NON_NAME_WORDS.has(wLower)) return null;
    if (NAME_PARTICLES.has(wLower)) continue;
    if (!/^[A-ZÀ-Ö]/.test(w)) return null;
  }
  // Le premier mot doit être capitalisé (pas une particule)
  if (NAME_PARTICLES.has(words[0].toLowerCase())) return null;
  // Au moins un autre mot capitalisé (sinon "Jean de" passe)
  const hasSecondCap = words.slice(1).some((w) => /^[A-ZÀ-Ö]/.test(w));
  if (!hasSecondCap) return null;

  const firstName = words[0];
  const lastName = words.slice(1).join(' ');
  return { firstName, lastName };
}

function findRoleInSnippet(snippet) {
  if (!snippet) return { role: null, keyword: null, score: 0 };
  const lower = snippet.toLowerCase();

  for (const kw of ROLE_KEYWORDS.high) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx >= 0) {
      return { role: extractRoleContext(snippet, idx), keyword: kw, score: 0.9 };
    }
  }
  for (const kw of ROLE_KEYWORDS.mid) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx >= 0) {
      return { role: extractRoleContext(snippet, idx), keyword: kw, score: 0.6 };
    }
  }
  for (const kw of ROLE_KEYWORDS.low) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx >= 0) {
      return { role: extractRoleContext(snippet, idx), keyword: kw, score: 0.3 };
    }
  }
  return { role: null, keyword: null, score: 0 };
}

function extractRoleContext(snippet, idx) {
  // Retourne une chaîne 60-chars autour du keyword, nettoyée des balises HTML
  const start = Math.max(0, idx - 10);
  const end = Math.min(snippet.length, idx + 70);
  return snippet.slice(start, end).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Flow principal ──────────────────────────────────────────────────────

/**
 * Scrape le site d'une entreprise à la recherche d'emails et profils
 * équipe. Utilisé par resolveEmail (pour cross-checker un pattern contre
 * les emails trouvés) et resolveDecisionMaker (pour rescorer le décideur).
 *
 * Règle budget : max N pages visitées (défaut TARGET_PATHS.length), stop
 * dès que `maxEmails` emails distincts trouvés ou que le timeout global
 * est atteint.
 *
 * @param {Object} input
 * @param {string} input.domain              normalisé (sans https://)
 * @param {string} [input.firstName]         pour scoring contextuel
 * @param {string} [input.lastName]          pour scoring contextuel
 * @param {string[]} [input.paths]           surcharge TARGET_PATHS (tests)
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]
 * @param {number}   [opts.pageTimeoutMs]
 * @param {number}   [opts.globalTimeoutMs]
 * @param {number}   [opts.maxEmails]        défaut 20
 * @param {Function|Object} [opts.logger]
 * @returns {Promise<{ domain, emails, teamProfiles, pagesVisited, pagesFailed, elapsedMs }>}
 */
async function scrapeDomain(input = {}, opts = {}) {
  const started = Date.now();
  const normDomain = normalizeDomain(input.domain);
  if (!normDomain) {
    return {
      domain: null,
      emails: [],
      teamProfiles: [],
      pagesVisited: [],
      pagesFailed: [],
      elapsedMs: 0,
      signals: ['invalid_domain'],
    };
  }

  // S10 (8 mai 2026) — mode 'exhaustive' (AirWorker local) ou 'fast' (FA Azure).
  // Si opts.mode='exhaustive', utilise la liste élargie avec mentions légales,
  // CGV, etc. (mine d'or pour TPE FR où l'email gérant est légalement
  // obligatoire en mentions légales).
  let paths;
  if (Array.isArray(input.paths) && input.paths.length > 0) {
    paths = input.paths;
  } else if (opts.mode === 'exhaustive') {
    paths = TARGET_PATHS_EXHAUSTIVE;
  } else {
    paths = TARGET_PATHS_FAST;
  }
  const maxEmails = Number.isFinite(opts.maxEmails) ? opts.maxEmails : 20;
  const globalTimeout = Number.isFinite(opts.globalTimeoutMs)
    ? opts.globalTimeoutMs
    : DEFAULT_GLOBAL_TIMEOUT_MS;
  const pageTimeout = Number.isFinite(opts.pageTimeoutMs)
    ? opts.pageTimeoutMs
    : DEFAULT_PAGE_TIMEOUT_MS;

  const emails = new Map(); // email → { email, confidence, sources[], contextSnippet }
  const teamProfiles = [];
  const pagesVisited = [];
  const pagesFailed = [];

  for (const path of paths) {
    if (Date.now() - started > globalTimeout) {
      pagesFailed.push({ path, reason: 'global_timeout' });
      break;
    }
    const url = `https://${normDomain}${path}`;
    const res = await fetchPage(url, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: pageTimeout,
      userAgent: opts.userAgent,
    });
    if (!res.ok) {
      pagesFailed.push({ path, reason: res.error ? 'error' : `http_${res.status}` });
      continue;
    }
    pagesVisited.push({ path, status: res.status });

    const found = extractEmailsFromHtml(res.text, { expectedDomain: normDomain });
    for (const e of found) {
      const confidence = scoreEmailAgainstName(e, res.text, {
        firstName: input.firstName,
        lastName: input.lastName,
      });
      if (!emails.has(e)) {
        emails.set(e, {
          email: e,
          confidence,
          sources: [`scraping:${path}`],
        });
      } else {
        const prev = emails.get(e);
        prev.confidence = Math.max(prev.confidence, confidence);
        prev.sources.push(`scraping:${path}`);
      }
    }

    const profiles = extractTeamProfiles(res.text);
    for (const p of profiles) {
      teamProfiles.push({ ...p, foundOn: path });
    }

    if (emails.size >= maxEmails) break;
  }

  return {
    domain: normDomain,
    emails: [...emails.values()].sort((a, b) => b.confidence - a.confidence),
    teamProfiles,
    pagesVisited,
    pagesFailed,
    elapsedMs: Date.now() - started,
    signals: [],
  };
}

module.exports = {
  scrapeDomain,
  fetchPage,
  extractEmailsFromHtml,
  extractTeamProfiles,
  isJunkEmail,
  scoreEmailAgainstName,
  parseFullName,
  findRoleInSnippet,
  decodeCloudflareEmail,
  extractEmailsFromJsonLd,
  // exposé pour tests :
  _constants: {
    TARGET_PATHS, TARGET_PATHS_FAST, TARGET_PATHS_EXHAUSTIVE, JUNK_LOCAL_PARTS, ROLE_KEYWORDS,
    DEFAULT_USER_AGENT, DEFAULT_PAGE_TIMEOUT_MS, DEFAULT_GLOBAL_TIMEOUT_MS,
  },
};
