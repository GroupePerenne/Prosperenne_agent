'use strict';

/**
 * AirWorker Domain Resolver — combo waterfall pour maximiser le taux de
 * domaine officiel trouvé sur sweet spot Pérenne.
 *
 * Stratégies cascadées (premier hit gagne) :
 *
 *   1. heuristicUrlGuess (rapide, ~1s) — HEAD-check de variantes URL
 *      construites à partir du nom company (slug.fr, slug.com, slug.eu, etc.).
 *      Couvre les TPE qui ont un domaine trivial dérivé du nom.
 *
 *   2. Playwright Google avec queries variantes intelligentes :
 *      - "{short_keyword}" {ville}        ← mot-clé court (sans suffixes juridiques)
 *      - {short_keyword} {ville}
 *      - "{dirigeantName}" {short_keyword}  ← dirigeant + entreprise
 *      - "{companyName}" {ville}           ← raison sociale complète
 *      - {short_keyword}
 *      Le 1er résultat non-agrégateur trouvé gagne.
 *
 *   3. Visite agrégateur + extraction outbound site officiel : si Playwright
 *      ne retourne QUE des agrégateurs (skipped > 0 et out vide), visite le
 *      1er agrégateur et parse les liens outbound pour trouver le site
 *      officiel mentionné dans la fiche entreprise.
 *
 *   4. null si rien.
 *
 * Mandat Paul 8 mai PM : "agrégateur OK pour DÉCOUVRIR, pas comme résultat".
 * → Étape 3 utilise les agrégateurs comme passerelle, pas comme résultat.
 */

const { findCandidatesViaHeuristic } = require('../shared/site-finder/sources/heuristicUrlGuess');
const playwrightGoogle = require('../shared/site-finder/sources/webSearchBackends/playwrightGoogle');
const { isAggregator, extractHost } = require('../shared/site-finder/aggregators');
const { normalize } = require('../shared/site-finder/utils/urlNormalizer');

// Suffixes juridiques à retirer pour générer le mot-clé court (extrait de
// heuristicUrlGuess.js LEGAL_SUFFIXES, simplifié pour matching mot-clé).
const LEGAL_SUFFIXES_REGEX = /\b(sas|sarl|sa|eurl|sasu|snc|scop|sci|scs|gie|gip|societe|ste|cie|compagnie|groupe|group|holding|france|french|et fils|et associes|et cie|et freres|associes|freres|fils|sasu|entreprise|etablissements|etablissement|ets)\b/gi;

function buildShortKeyword(companyName) {
  if (!companyName) return '';
  // Strip suffixes juridiques + apostrophes + ponctuation
  let s = String(companyName)
    .replace(/['']/g, ' ')
    .replace(LEGAL_SUFFIXES_REGEX, ' ')
    .replace(/[^a-zA-ZÀ-ſ\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Si ce qui reste fait < 3 chars, retourner le nom original
  if (s.length < 3) return companyName.trim();
  return s;
}

function buildSmartQueries(input) {
  const { companyName, ville, dirigeantName } = input;
  const shortKeyword = buildShortKeyword(companyName);
  const queries = [];

  // 1. Mot-clé court + ville (le plus efficace pour les noms longs RNE)
  if (shortKeyword && ville) {
    queries.push(`"${shortKeyword}" ${ville}`);
    queries.push(`${shortKeyword} ${ville}`);
  }

  // 2. Dirigeant + entreprise
  if (dirigeantName && shortKeyword) {
    queries.push(`"${dirigeantName}" ${shortKeyword}`);
  }

  // 3. Raison sociale complète + ville (fallback)
  if (companyName && ville) {
    queries.push(`"${companyName}" ${ville}`);
  }

  // 4. Mot-clé court seul (très large, derniers recours)
  if (shortKeyword && shortKeyword !== companyName) {
    queries.push(shortKeyword);
  }

  // Dédoublonnage
  return [...new Set(queries)];
}

async function resolveViaHeuristic(siren, companyName) {
  try {
    const candidates = await findCandidatesViaHeuristic({ companyName, siren });
    if (!candidates || candidates.length === 0) return null;
    // Retourne le 1er candidat (déjà passé HEAD check)
    const first = candidates[0];
    if (!first.url || isAggregator(first.url)) return null;
    return {
      siteUrl: first.url,
      source: 'heuristic_url_guess',
      proofType: 'head_check_passed',
      confidence: 0.70,
    };
  } catch {
    return null;
  }
}

async function resolveViaPlaywright(input) {
  const queries = buildSmartQueries(input);
  let firstAggregatorSeen = null;

  for (const query of queries) {
    let results;
    try {
      results = await playwrightGoogle.search(query, { maxResults: 5 });
    } catch (err) {
      continue;
    }

    // Le backend filtre déjà les agrégateurs, mais on récupère le compteur
    // skippedAggregators pour savoir si Google a renvoyé QUE des agrégateurs
    const skippedAggr = results.skippedAggregators || 0;
    const valid = (results || []).find((r) => !isAggregator(r.url));
    if (valid) {
      return {
        siteUrl: valid.url,
        source: 'playwright_google',
        proofType: 'first_non_aggregator',
        confidence: 0.85,
        query,
      };
    }

    // Note le 1er agrégateur vu pour fallback étape 3
    if (skippedAggr > 0 && !firstAggregatorSeen) {
      // Re-search sans filtre pour récupérer l'agrégateur top 1
      try {
        const rawResults = await playwrightGoogle.search(query, {
          maxResults: 3,
          // Pas de bypass filtre, mais on prend ce qu'il y a
        });
        // Le filtre est dans le backend, on ne peut pas désactiver propre.
        // Pour simplifier : on visite le premier agrégateur via une 2e
        // search variant, mais c'est compliqué. Pour V0, on skip cette
        // sous-étape ici.
      } catch { /* ignore */ }
    }
  }

  return null;
}

/**
 * Extrait le vrai site web à partir d'une page agrégateur.
 *
 * Stratégie : visite la page de l'agrégateur, parse tous les liens externes
 * (a[href^="http"]), filtre pour exclure les autres agrégateurs / réseaux
 * sociaux / liens internes, retourne le 1er candidat plausible.
 *
 * @param {string} aggregatorUrl
 * @returns {Promise<string|null>}
 */
async function extractRealSiteFromAggregator(aggregatorUrl) {
  // Pour V0 : on charge la page via fetch HTTP simple (pas Playwright pour
  // économiser ressources). Si Cloudflare ou JS-only, on échouera proprement.
  let html;
  try {
    const res = await fetch(aggregatorUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }

  // Parse les liens externes via regex (pas de DOM parser pour rester léger)
  const linkRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const seen = new Set();
  const candidates = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href || !href.startsWith('http')) continue;
    // Skip mailto, tel
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    const host = extractHost(href);
    if (!host) continue;
    // Skip agrégateurs et plateformes connues
    if (isAggregator(href)) continue;
    if (/linkedin\.com|facebook\.com|twitter\.com|instagram\.com|youtube\.com|x\.com/.test(host)) continue;
    // Skip si même domaine que la page agrégateur courante (lien interne)
    const aggrHost = extractHost(aggregatorUrl);
    if (aggrHost && host === aggrHost) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    candidates.push(href);
  }

  if (candidates.length === 0) return null;
  // Premier candidat = probable site officiel (les agrégateurs mettent le
  // lien officiel en haut de fiche typiquement)
  return candidates[0];
}

/**
 * Résolution complète du domaine via combo cascade.
 *
 * @param {Object} input
 * @param {string} input.siren
 * @param {string} input.companyName
 * @param {string} input.ville
 * @param {string} [input.dirigeantName]
 * @returns {Promise<{siteUrl, source, proofType, confidence, query?}|null>}
 */
async function resolveDomainCombo(input) {
  // V6.1 (8 mai PM) : heuristicUrlGuess DÉSACTIVÉ — il retourne le 1er
  // domaine qui passe HEAD check (ex: 'societe.eu' pour 'SOCIETE D'EXPLOITATION
  // DES ETABLISSEMENTS LEVEZIER') sans valider que c'est le BON domaine pour
  // cette entreprise. La validation SIREN dans mentions légales nécessite
  // d'embarquer le siteValidator du pipeline siteFinder, qui appelle des
  // sources potentiellement bannies (api.gouv). Pour AirWorker, on skip et
  // on s'appuie uniquement sur Playwright Google + queries variantes.
  // À réactiver si on ajoute un validator SIREN-aware basé sur le scrape.

  // Étape 1 (skipped) : heuristic guess
  // Étape 2 : Playwright Google avec queries variantes
  const playwright = await resolveViaPlaywright(input);
  if (playwright) {
    return playwright;
  }

  // Étape 3 (V1 future) : visite agrégateurs pour extraire vrai site
  return null;
}

module.exports = {
  resolveDomainCombo,
  buildSmartQueries,
  buildShortKeyword,
  resolveViaHeuristic,
  resolveViaPlaywright,
  extractRealSiteFromAggregator,
};
