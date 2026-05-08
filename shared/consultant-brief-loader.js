'use strict';

/**
 * Loader brief consultant — Storage Table consultantOnboarding source unique.
 *
 * Doctrine (Paul 8 mai 2026) : Mem0 = mémoire agentique (Charli, prospect
 * signaux, patterns). Storage Table = opérationnel (brief consultant config
 * stable). Aucun mélange : le brief NE transite PAS par Mem0.
 *
 * Remplace l'ancien rebuildConsultantFromMem0 dans leadSelectorJobQueue +
 * runLeadSelectorForConsultant. Si le brief est absent de Storage, retourne
 * null + log explicite (action onboarding requise).
 *
 * Format de retour identique à l'historique pour drop-in replacement.
 */

const { getConsultant: defaultGetConsultant } = require('./storage-tables/consultantOnboarding');
const { reviveBriefFromConsultantMemory } = require('./leadSelector');

function buildPayload(originalBrief, consultantId) {
  return {
    consultant: {
      nom: originalBrief.nom,
      email: originalBrief.email,
      offre: originalBrief.offre,
      ton: originalBrief.registre,
      tutoiement: originalBrief.vouvoiement === 'tu',
    },
    brief: { prospecteur: originalBrief.prospecteur || 'both' },
    originalBrief,
    beneficiaryId: `oseys-${String(consultantId || '').split('@')[0] || 'unknown'}`,
    source: 'storage-table',
  };
}

/**
 * @param {string} consultantId  email lowercased
 * @param {object} [context]     Azure Functions InvocationContext
 * @param {object} [deps]        { getConsultant } injection tests
 * @returns {Promise<object|null>}  null si brief absent — caller signale "consultant_brief_missing"
 */
async function loadConsultantBrief(consultantId, context, deps = {}) {
  if (!consultantId) return null;
  const _getConsultant = deps.getConsultant || defaultGetConsultant;
  const safeLog = (msg) => {
    try {
      if (context && typeof context.log === 'function') context.log(msg);
    } catch {
      /* swallow */
    }
  };

  let record;
  try {
    record = await _getConsultant(consultantId);
  } catch (err) {
    safeLog(`[consultant-brief-loader] storage-error consultantId=${consultantId} err=${err && err.message}`);
    return null;
  }

  if (!record || !record.responses || !record.responses.display_name) {
    safeLog(`[consultant-brief-loader] consultant-brief-missing consultantId=${consultantId} — onboarding required`);
    return null;
  }

  const originalBrief = reviveBriefFromConsultantMemory(record.responses);
  safeLog(`[consultant-brief-loader] storage-hit consultantId=${consultantId}`);
  return buildPayload(originalBrief, consultantId);
}

module.exports = { loadConsultantBrief, buildPayload };
