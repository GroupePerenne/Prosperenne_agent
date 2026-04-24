'use strict';

/**
 * Source : API Recherche d'entreprises (recherche-entreprises.api.gouv.fr).
 *
 * Gratuit, sans auth, rate limit 7 req/s (doc officielle). Retourne la fiche
 * identité officielle pour un SIREN : raison sociale, activité principale,
 * adresse siège, dirigeants, effectif.
 *
 * Endpoint : GET /search?q={siren}&page=1&per_page=1
 *
 * Contrat interne (shape normalisée consommée par companyProfile.js) :
 *   {
 *     siren: string,
 *     nomEntreprise: string | null,
 *     activiteDeclaree: string | null,     // libellé NAF / activité principale
 *     codeNaf: string | null,
 *     trancheEffectif: string | null,       // code INSEE
 *     adresseSiege: string | null,
 *     commune: string | null,
 *     dateCreation: string | null,          // YYYY-MM-DD
 *     estActive: boolean | null,
 *     raw: object | null                    // payload brut, pour diagnostic
 *   }
 *
 * Dégradation gracieuse : toute erreur (réseau, 404, timeout, parse) →
 * retourne null sans throw. Le caller skippe cet axe.
 */

const DEFAULT_ENDPOINT = 'https://recherche-entreprises.api.gouv.fr/search';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {string} siren
 * @param {object} [opts]
 * @param {string}    [opts.endpoint]    Override URL (tests)
 * @param {number}    [opts.timeoutMs]   Timeout HTTP (défaut 8000)
 * @param {Function}  [opts.fetchImpl]   Injectable (tests)
 * @returns {Promise<object|null>} fiche normalisée ou null
 */
async function fetchCompanyFromApiGouv(siren, opts = {}) {
  const cleanSiren = sanitizeSiren(siren);
  if (!cleanSiren) return null;

  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;

  const url = `${endpoint}?q=${encodeURIComponent(cleanSiren)}&page=1&per_page=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res || !res.ok) return null;
    const data = await res.json();
    return normalize(cleanSiren, data);
  } catch {
    // timeout, réseau, parse : dégradation silencieuse
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeSiren(siren) {
  const s = String(siren || '').replace(/\s+/g, '');
  return /^\d{9}$/.test(s) ? s : null;
}

/**
 * Normalise le payload API → shape interne. Résilient aux champs manquants.
 * On pioche le premier résultat dont le siren correspond (l'API peut renvoyer
 * plusieurs résultats si le siren est inclus dans d'autres identifiants).
 */
function normalize(siren, data) {
  if (!data || !Array.isArray(data.results) || data.results.length === 0) return null;

  const match =
    data.results.find((r) => String(r.siren) === siren) || data.results[0];

  if (!match) return null;

  const siege = match.siege || {};
  const complements = match.complements || {};

  const adresseSiege =
    (siege.adresse && String(siege.adresse)) ||
    [siege.numero_voie, siege.type_voie, siege.libelle_voie]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    null;

  return {
    siren,
    nomEntreprise: match.nom_complet || match.nom_raison_sociale || null,
    activiteDeclaree:
      match.activite_principale_libelle ||
      siege.activite_principale_libelle ||
      null,
    codeNaf: match.activite_principale || siege.activite_principale || null,
    trancheEffectif:
      match.tranche_effectif_salarie ||
      siege.tranche_effectif_salarie ||
      null,
    adresseSiege: adresseSiege || null,
    commune: siege.libelle_commune || siege.commune || null,
    dateCreation: match.date_creation || null,
    estActive:
      typeof match.etat_administratif === 'string'
        ? match.etat_administratif.toUpperCase() === 'A'
        : null,
    // Drapeaux complémentaires utiles downstream (sourçable public)
    estESS: complements.est_ess === true ? true : null,
    estQualiopi: complements.est_qualiopi === true ? true : null,
    // Raw garde la trace pour diagnostic — on ne remonte que match, pas data.
    raw: match,
  };
}

module.exports = {
  fetchCompanyFromApiGouv,
  sanitizeSiren,
  _normalize: normalize, // exposé pour tests
  DEFAULT_ENDPOINT,
};
