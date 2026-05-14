'use strict';

/**
 * Doctrine cross-sell Prospérenne / Pérenne (plan v3.1 Pilier 6, tranchée
 * Paul 13 mai 2026 PM).
 *
 * Contexte : Prospérenne peut prospecter des clients OSEYS / Pérenne legacy,
 * MAIS la contrainte "prospecteur unique par prospect" tient :
 *   - Si une personne a un deal ouvert avec Martin → on assigne Mila
 *   - Si une personne a un deal ouvert avec Mila → on assigne Martin
 *   - Si les deux sont déjà actifs → SKIP (prospect saturé, on ne le
 *     re-démarche pas tant qu'au moins un des deux n'est pas fermé)
 *
 * Justification business : si Martin a un fil de prospection en cours sur
 * un prospect, ouvrir simultanément Mila dessus créerait une double sollicitation
 * confusante côté prospect (deux interlocuteurs distincts du "réseau" qui
 * lui écrivent en parallèle). Mauvaise expérience + risque réputation.
 *
 * Architecture H1 minimal viable : règle code simple, pas de table multi-
 * tenant `ProspectAgentAssignments`. La table scalable sera ajoutée H3
 * quand on aura 3+ tenants réels (Prospérenne + Pérenne + autre futur).
 * Pour H1, 2 agents (Martin, Mila), la règle simple suffit.
 *
 * Cohérence avec le custom field Pipedrive existant `agent_sender` qui
 * stocke 'martin' (option 378) ou 'mila' (option 379) sur chaque deal.
 *
 * Non-objectif : ne gère pas les opt_out (qui sont sticky inter-agent via
 * le champ opt_out_until). Le caller doit avoir déjà filtré les opt-out.
 */

const AGENTS = Object.freeze(['martin', 'mila']);

/**
 * Décide l'agent à attribuer pour un nouveau cycle de prospection sur un
 * prospect donné, à partir de la liste des agents actifs sur ses deals
 * ouverts.
 *
 * @param {Object} args
 * @param {'martin'|'mila'} args.candidateAgent
 *   Agent suggéré par le brief consultant (alternance i%2 ou choix explicite).
 * @param {Array<'martin'|'mila'>} args.activeAgents
 *   Liste des agents ayant déjà un deal ouvert sur ce prospect. Dédup côté
 *   appelant. Peut être vide (= prospect neuf, candidate utilisé tel quel).
 * @returns {{ agent: 'martin'|'mila'|null, skip: boolean, reason: string }}
 */
function decideAgent({ candidateAgent, activeAgents = [] }) {
  if (!AGENTS.includes(candidateAgent)) {
    return { agent: null, skip: true, reason: 'invalid_candidate_agent' };
  }

  const active = new Set(activeAgents.filter((a) => AGENTS.includes(a)));

  if (active.size === 0) {
    return { agent: candidateAgent, skip: false, reason: 'no_prior_activity' };
  }

  if (active.size >= 2) {
    // Martin ET Mila actifs sur le prospect → SKIP, on ne re-démarche pas
    return { agent: null, skip: true, reason: 'both_agents_already_active' };
  }

  // Exactement 1 agent actif → on force l'AUTRE (re-pioche cross-sell)
  const activeOne = Array.from(active)[0];
  const otherAgent = activeOne === 'martin' ? 'mila' : 'martin';
  if (activeOne === candidateAgent) {
    return {
      agent: otherAgent,
      skip: false,
      reason: `cross_sell_repick:${activeOne}_already_active_force_${otherAgent}`,
    };
  }
  // candidateAgent diffère déjà de activeOne → cohérent doctrine, on retourne candidateAgent
  return {
    agent: candidateAgent,
    skip: false,
    reason: `candidate_distinct_from_active:${activeOne}_active_use_${candidateAgent}`,
  };
}

/**
 * Helper : extrait la liste d'agents actifs depuis les deals Pipedrive
 * ouverts du prospect. Lit le custom field `agent_sender` (option_id mapping).
 *
 * @param {Array<Object>} openDeals deals Pipedrive (forme retournée par
 *   pipedrive.findOpenDealsForPersonInOurPipe — chaque deal contient
 *   le custom field agent_sender sous la forme d'un option_id numérique
 *   stocké sous la clé dynamique PIPEDRIVE_FIELD_AGENT_SENDER).
 * @param {Object} [opts]
 * @param {string} [opts.agentSenderFieldKey] Override pour test (sinon lit env).
 * @param {Object} [opts.optionIdToAgent] Override mapping option_id → agent.
 *   Défaut : { 378: 'martin', 379: 'mila' } (cohérent shared/pipedrive.js).
 * @returns {Array<'martin'|'mila'>}
 */
function extractActiveAgents(openDeals, opts = {}) {
  const fieldKey = opts.agentSenderFieldKey || process.env.PIPEDRIVE_FIELD_AGENT_SENDER;
  const map = opts.optionIdToAgent || { 378: 'martin', 379: 'mila' };
  if (!Array.isArray(openDeals) || openDeals.length === 0 || !fieldKey) return [];
  const out = new Set();
  for (const deal of openDeals) {
    const value = deal && deal[fieldKey];
    const agent = map[value];
    if (agent) out.add(agent);
  }
  return Array.from(out);
}

module.exports = {
  decideAgent,
  extractActiveAgents,
  AGENTS,
};
