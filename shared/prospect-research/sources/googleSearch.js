'use strict';

/**
 * Source : recherche de signaux d'actualité (recrutement, levée, press).
 *
 * V0 — STUB : retourne toujours [] pour éviter de violer les ToS Google et
 * de dépendre d'un provider SERP non arbitré.
 *
 * Décision produit (Paul, 2026-04-23) : placeholder V0, arbitrage provider
 * V1 (Bing Web Search API / Google CSE / SerpAPI / Brave) avant pilote
 * commercial Prospérenne. Interface figée et stable — swap du provider se
 * fera sous `sources/` sans changer le contrat externe.
 *
 * Le profiler V0 reste exploitable sans signaux externes : site entreprise
 * + API Gouv + LinkedIn (Jalon 2) suffisent pour produire une accroche
 * pertinente. Quand un provider sera branché, aucune modif downstream
 * requise — `companyProfile.js` consomme déjà la shape retournée.
 *
 * Shape de retour stable :
 *   {
 *     query: string,               // la requête effectuée
 *     provider: 'stub' | 'bing' | 'google_cse' | 'serpapi' | 'brave',
 *     results: Array<{
 *       title: string,
 *       snippet: string,
 *       url: string,
 *       date?: string,             // ISO si disponible
 *       source?: string,           // nom de domaine source
 *       signalType?: 'hiring' | 'fundraising' | 'press' | 'product_launch' | 'other',
 *     }>,
 *     elapsedMs: number,
 *     note?: string                // info humaine (raisons de stub, erreur, etc.)
 *   }
 */

const STUB_NOTE =
  'stub V0 — arbitrage provider V1 en attente (cf. CLAUDE_PROFILER §7 et SPEC §4.1)';

/**
 * Recherche de signaux récents pour une entreprise.
 *
 * @param {string} companyName
 * @param {object} [opts]
 * @param {string[]} [opts.queryHints]  Suffixes de requêtes à tester (non utilisés en stub)
 * @param {number}   [opts.maxResults]  Nombre max de résultats (non utilisé en stub)
 * @param {string}   [opts.provider]    Provider forcé (par défaut lu depuis env PROFILER_SERP_PROVIDER)
 * @returns {Promise<{query: string, provider: string, results: any[], elapsedMs: number, note?: string}>}
 */
async function searchRecentSignals(companyName, opts = {}) {
  const started = Date.now();
  const cleaned = String(companyName || '').trim();
  const query = cleaned ? buildQuery(cleaned, opts.queryHints) : '';
  const provider = opts.provider || process.env.PROFILER_SERP_PROVIDER || 'stub';

  // V0 : quelle que soit la valeur de provider, on renvoie le stub tant que
  // les adapters concrets ne sont pas implémentés. Le champ provider dans
  // le retour reflète l'intention, pas l'exécution réelle — utile pour logs.
  return {
    query,
    provider,
    results: [],
    elapsedMs: Date.now() - started,
    note: STUB_NOTE,
  };
}

function buildQuery(companyName, hints) {
  // On prépare la forme de la requête même si elle n'est pas exécutée, pour
  // que les logs/tests voient ce qui serait envoyé à un provider réel.
  const baseHints = Array.isArray(hints) && hints.length
    ? hints
    : ['levée', 'recrutement', 'nouveauté 2026'];
  return `"${companyName}" ${baseHints.join(' OR ')}`;
}

module.exports = {
  searchRecentSignals,
  _buildQuery: buildQuery,
  STUB_NOTE,
};
