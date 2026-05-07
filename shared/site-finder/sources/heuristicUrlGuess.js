'use strict';

/**
 * Source T1bis (heuristique URL guess) — site-finder.
 *
 * Pourquoi cette source : pour la cible Pereneo (PME 5-75 salariés FR), une
 * grande partie des entreprises a un site dont le domaine suit un pattern
 * trivial dérivé du nom (slug + .fr / .com). T1 apiGouv ne peuple pas
 * `site_internet` pour la plupart de ces SIREN. Plutôt que d'attendre une
 * recherche web (T2), on tente directement les URLs probables et on délègue
 * au `siteValidator` aval pour la preuve SIREN dans les mentions légales.
 *
 * Stratégie de slugs (par ordre de priorité, max 12 candidates générés) :
 *   1. slug long avec tirets (mots multiples joints par tiret)
 *   2. slug long sans tirets (concaténation)
 *   3. slug 2 premiers mots avec tiret
 *   4. slug court (premier mot seul, si ≥ 3 chars)
 *
 * Pour chaque slug, on teste .fr, .com, .eu dans cet ordre (cible FR,
 * ouverture vers TLDs alternatifs couramment utilisés par les PME).
 * Limite globale 12 URLs (vs 8 avant Option D).
 * Probe HTTP léger : GET avec headers navigateur réalistes, timeout 3s,
 * concurrence 4. Filtre les domaines parking (Content-Length insuffisant ou
 * marqueurs textuels typiques).
 *
 * Le validator final (`siteValidator`) reste responsable de la confidence
 * basée sur la preuve SIREN. Cette source ne prétend pas qu'un domaine
 * trouvé est forcément le bon — juste qu'il existe et héberge du HTML.
 *
 * Anti-bot : pool de User-Agents Chrome/Firefox/Safari récents en rotation,
 * headers complets type navigateur, pas de jitter agressif (3s timeout
 * + concurrence 4 reste gentil pour 8 candidats).
 */

const { normalize } = require('../utils/urlNormalizer');

const FETCH_TIMEOUT_MS = 3000;
const MAX_CANDIDATES = 12;
const CONCURRENCY = 4;
// TLDs testés par ordre de priorité pour la cible PME FR.
const TLDS = ['.fr', '.com', '.eu'];
const SOURCE_ID = 'heuristic_url_guess';
const INITIAL_CONFIDENCE = 0.70;

// Suffixes juridiques et qualificatifs à retirer EN QUEUE du nom pour générer
// le slug. Un seul passage en queue (on ne désempile pas plusieurs niveaux).
// Liste fermée FR — pas d'extrapolation R-J6.
const LEGAL_SUFFIXES = [
  'sas',
  'sarl',
  'sa',
  'eurl',
  'sasu',
  'snc',
  'scop',
  'sci',
  'scs',
  'gie',
  'gip',
  'societe',
  'ste',
  'cie',
  'compagnie',
  'groupe',
  'group',
  'holding',
  'france',
  'french',
  // Qualificatifs familiaux fréquents en queue de nom commercial PME
  'et-fils',
  'et-associes',
  'et-cie',
  'et-freres',
  'associes',
  'freres',
  'fils',
];

// Articles et particules à retirer EN TÊTE du nom si le reste fait ≥ 3 chars.
// On ne touche PAS au corps du nom : "Les Éditions du Nord" → 'editions-du-nord',
// pas 'nord'. La logique stop-words dans buildSlugs s'occupe des particules internes.
const BEGIN_ARTICLES = new Set(['le', 'la', 'les', 'l']);

// Mots vides retirés de la slugification (bruit qui dégrade les URLs candidates)
const STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'et', 'a', 'au', 'aux',
  'un', 'une', 'en', 'sur', 'pour',
]);

// Pool User-Agents réalistes (versions stables ~mi-2026). Sélection
// aléatoire à chaque probe pour réduire la signature de masse.
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

// Marqueurs textuels qui révèlent un domaine parking / squatter / saisie
// (pas de contenu propre à l'entreprise). Liste conservatrice — on ne veut
// pas filtrer un vrai site qui mentionne ces mots dans un autre contexte,
// donc on cherche les marqueurs **dominants** (titre court contenant le
// terme + body court).
const PARKING_MARKERS = [
  'domain for sale',
  'this domain is for sale',
  'buy this domain',
  'parked free',
  'parking page',
  'achetez ce domaine',
  'ce nom de domaine est à vendre',
  'enregistrez votre domaine',
  'sedo.com',
  'godaddy.com/domainsearch',
];

// Taille body minimale pour considérer le site comme "vrai" (parking pages
// sont quasi toujours < 5kB, les vrais sites PME démarrent à 30kB+).
const MIN_BODY_BYTES = 2000;

/**
 * Pick aléatoire dans le pool d'UA. Injectable pour tests via opts.userAgent.
 */
function pickUserAgent(opts) {
  if (opts && typeof opts.userAgent === 'string' && opts.userAgent.length > 0) {
    return opts.userAgent;
  }
  if (opts && typeof opts.randomImpl === 'function') {
    const idx = Math.floor(opts.randomImpl() * USER_AGENTS.length);
    return USER_AGENTS[idx];
  }
  const idx = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[idx];
}

/**
 * Headers type navigateur cohérents — Cloudflare et autres WAF font du
 * fingerprinting headers, donc envoyer un set incomplet (ex: User-Agent seul)
 * est un signal robot fort.
 */
function buildHeaders(userAgent) {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * Convertit un nom d'entreprise en candidates slugs, ordonnés du plus
 * spécifique au plus générique.
 *
 * Ex : "ACME PLOMBERIE SAS" → ['acme-plomberie', 'acmeplomberie', 'acme-plomberie', 'acme']
 * Ex : "Société Générale"   → ['societe-generale', 'societegenerale']
 * Ex : "La Belle Menuiserie SARL" → ['belle-menuiserie', 'bellemenuiserie', 'belle']
 *      + variante sans retrait article : ['belle-menuiserie-sarl'→élagué, etc.]
 */
function buildSlugs(companyName) {
  if (!companyName || typeof companyName !== 'string') return [];
  const cleaned = companyName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents combinants
    .toLowerCase()
    .replace(/[()[\]{}'"&]/g, ' ') // ponctuation
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];

  let words = cleaned.split(/[\s-]+/).filter(Boolean);

  // Retire les suffixes juridiques en queue (un seul passage).
  // On normalise les tirets dans les suffixes composés pour matcher : "et fils"
  // est normalisé plus bas, mais on checke aussi la forme jointe "et-fils".
  while (words.length > 1) {
    const tail = words[words.length - 1];
    // Suffixe simple (un mot)
    if (LEGAL_SUFFIXES.includes(tail)) { words.pop(); continue; }
    // Suffixe composé (deux derniers mots joints par tiret, ex: "et fils")
    if (words.length > 2) {
      const twoLast = `${words[words.length - 2]}-${tail}`;
      if (LEGAL_SUFFIXES.includes(twoLast)) { words.pop(); words.pop(); continue; }
    }
    break;
  }

  // Retire stop-words seulement si on reste avec ≥ 2 mots significatifs.
  if (words.length > 2) {
    const filtered = words.filter((w) => !STOP_WORDS.has(w));
    if (filtered.length >= 1) words = filtered;
  }
  if (words.length === 0) return [];

  const slugs = [];
  const seen = new Set();
  const push = (s) => {
    if (!s || s.length < 3 || s.length > 40) return;
    if (seen.has(s)) return;
    seen.add(s);
    slugs.push(s);
  };

  // Génère les slugs depuis la liste de mots complète
  const addVariants = (ws) => {
    // 1. slug long avec tirets
    push(ws.join('-'));
    // 2. slug long sans tirets (concaténation)
    if (ws.length > 1) push(ws.join(''));
    // 3. slug 2 premiers mots
    if (ws.length >= 2) push(ws.slice(0, 2).join('-'));
    // 4. slug premier mot seul, si ≥ 3 chars et plusieurs mots dans le nom
    if (ws[0] && ws[0].length >= 3 && ws.length > 1) push(ws[0]);
  };

  addVariants(words);

  // Variante sans article initial : si le premier mot est un article (le, la,
  // les, l), on génère les slugs depuis le deuxième mot. Cible les PME dont
  // le domaine omet l'article (ex: "La Belle Menuiserie" → bellemenuiserie.fr).
  if (words.length >= 2 && BEGIN_ARTICLES.has(words[0])) {
    addVariants(words.slice(1));
  }

  return slugs;
}

/**
 * Pour chaque slug, génère les URL candidates (.fr, .com, .eu dans l'ordre).
 * Limite à MAX_CANDIDATES total. .fr prioritaire car cible 100% française.
 */
function buildCandidateUrls(slugs) {
  const urls = [];
  for (const slug of slugs) {
    for (const tld of TLDS) {
      if (urls.length >= MAX_CANDIDATES) break;
      urls.push(`https://${slug}${tld}`);
    }
    if (urls.length >= MAX_CANDIDATES) break;
  }
  return urls;
}

/**
 * Détecte les pages parking par analyse texte rapide.
 */
function looksLikeParking(text, contentLength) {
  if (typeof contentLength === 'number' && contentLength > 0 && contentLength < MIN_BODY_BYTES) {
    return true;
  }
  if (typeof text !== 'string' || !text) return false;
  if (text.length < MIN_BODY_BYTES) {
    const lower = text.toLowerCase();
    for (const marker of PARKING_MARKERS) {
      if (lower.includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Probe une URL : GET avec headers navigateur, timeout 3s. Retourne
 * `{ ok, status, contentLength, parking }` ou `null` si erreur réseau.
 *
 * On lit le début du body (max 8kB) pour la détection parking — pas la peine
 * de télécharger 200kB pour ça.
 */
async function probeCandidate(url, fetchImpl, opts = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const userAgent = pickUserAgent(opts);
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
      headers: buildHeaders(userAgent),
    });
    if (timer) clearTimeout(timer);
    if (!res || !res.ok) return null;

    const ct = String(res.headers && res.headers.get && res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('html')) return null;

    const cl = res.headers && res.headers.get && res.headers.get('content-length');
    const contentLength = cl ? Number(cl) : null;

    let bodySnippet = '';
    if (typeof res.text === 'function') {
      try {
        bodySnippet = (await res.text()).slice(0, 8192);
      } catch {
        bodySnippet = '';
      }
    }

    if (looksLikeParking(bodySnippet, contentLength)) return null;

    return {
      ok: true,
      status: res.status,
      contentLength,
    };
  } catch {
    if (timer) clearTimeout(timer);
    return null;
  }
}

/**
 * Source publique : génère les candidats URL plausibles par slugification du
 * nom et filtre par probe HTTP. Le validator aval fera la preuve SIREN.
 *
 * @param {Object} input
 * @param {string} input.siren                  9 chiffres requis
 * @param {string} input.companyName             Raison sociale, requise
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl]           Injection tests
 * @param {string}   [opts.userAgent]           Force un UA (tests)
 * @param {Function} [opts.randomImpl]          PRNG injectable (tests)
 * @returns {Promise<Array<{url, source, initialConfidence, signals}>>}
 */
async function findCandidatesViaHeuristic(input = {}, opts = {}) {
  if (!input.companyName || !/^\d{9}$/.test(String(input.siren || ''))) {
    return [];
  }
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) return [];

  const slugs = buildSlugs(input.companyName);
  if (slugs.length === 0) return [];

  const urls = buildCandidateUrls(slugs);
  if (urls.length === 0) return [];

  const reachable = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const slice = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (url) => ({
        url,
        probe: await probeCandidate(url, fetchImpl, opts),
      })),
    );
    for (const r of results) {
      if (r.probe && r.probe.ok) reachable.push(r.url);
    }
  }

  if (reachable.length === 0) return [];

  return reachable.map((url) => {
    const normalized = normalize(url);
    return {
      url: normalized,
      source: SOURCE_ID,
      initialConfidence: INITIAL_CONFIDENCE,
      signals: [`heuristic_slug:${input.companyName.slice(0, 40)}`],
    };
  }).filter((c) => c.url); // dépose les URLs non normalisables
}

module.exports = {
  findCandidatesViaHeuristic,
  // Exposés pour tests :
  buildSlugs,
  buildCandidateUrls,
  _internals: {
    USER_AGENTS,
    LEGAL_SUFFIXES,
    STOP_WORDS,
    BEGIN_ARTICLES,
    TLDS,
    MAX_CANDIDATES,
    CONCURRENCY,
    FETCH_TIMEOUT_MS,
    INITIAL_CONFIDENCE,
    SOURCE_ID,
    looksLikeParking,
    pickUserAgent,
    buildHeaders,
  },
};
