'use strict';

/**
 * Domaines agrégateurs / annuaires que NOS pipelines ne doivent pas
 * confondre avec un site officiel d'entreprise.
 *
 * Pourquoi cette liste vit ici (pas en webSearch.js) :
 *   - le filtre s'applique à plusieurs étapes : webSearch (site-finder),
 *     resolveDomain (lead-exhauster), pré-passe site-finder dans enrichBatch.
 *   - la liste est extensible au fil de l'observation prod (R-J6 strict :
 *     pas d'ajout spéculatif — seulement des domaines réellement vus
 *     pollués dans le pipeline).
 *
 * Conséquence concrète : si l'on accepte un site agrégateur comme
 * `companyDomain` d'une entreprise cible, on génère des patterns
 * absurdes (`prenom.nom@rubypayeur.com`) ET on prive Dropcontact d'un
 * fallback pertinent (chercher directement via SIREN + nom). Donc on
 * filtre dur en amont et on laisse Dropcontact gérer sans domaine si
 * besoin.
 */

const AGGREGATOR_DOMAINS = new Set([
  // Annuaires entreprises FR généralistes
  'societe.com',
  'verif.com',
  'pappers.fr',
  'pagesjaunes.fr',
  'infogreffe.fr',
  'manageo.fr',
  'kompass.com',
  'fr.kompass.com',
  'europages.fr',
  'corporama.com',
  'fr.kompany.com',
  'verif-siren.com',
  'siren-info.com',
  'societe-info.com',
  // Annuaires sectoriels et financiers
  'rubypayeur.com',
  'datalegal.fr',
  'prosmaison.fr',
  'e-pro.fr',
  'batiment.e-pro.fr',
  'score3.fr',
  'b-reputation.com',
  'pages-pro.com',
  'bilansgratuits.fr',
  'xerfi.com',
  'bvdinfo.com',
  'dnb.com',
  // Données publiques + presse
  'annuaire-entreprises.data.gouv.fr',
  'data.gouv.fr',
  'insee.fr',
  'bodacc.fr',
  'annuaire-mairie.fr',
  'mairie.com',
  'entreprises.lefigaro.fr',
  'entreprises.lagazettefrance.fr',
  'lagazettefrance.fr',
  // Réseaux sociaux et wikis
  'linkedin.com',
  'fr.linkedin.com',
  'facebook.com',
  'fr-fr.facebook.com',
  'wikipedia.org',
  'fr.wikipedia.org',
  // Moteurs de recherche
  'duckduckgo.com',
  'google.com',
  'bing.com',
]);

/**
 * Extrait l'hôte d'une URL ou d'une chaîne domaine bare.
 *   "https://www.acme.fr/contact" → "acme.fr"
 *   "www.acme.fr"                 → "acme.fr"
 *   "acme.fr"                     → "acme.fr"
 *   "acme.fr/path"                → "acme.fr"
 *   ""                            → null
 *   "not a url"                   → null
 */
function extractHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  let host;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.')) return null;
  return host;
}

/**
 * Vérifie si une URL ou un domaine bare est un agrégateur connu.
 * Match exact + match suffix (sous-domaines).
 */
function isAggregator(value) {
  const host = extractHost(value);
  if (!host) return false;
  if (AGGREGATOR_DOMAINS.has(host)) return true;
  for (const aggr of AGGREGATOR_DOMAINS) {
    if (host.endsWith(`.${aggr}`)) return true;
  }
  return false;
}

module.exports = {
  AGGREGATOR_DOMAINS,
  extractHost,
  isAggregator,
};
