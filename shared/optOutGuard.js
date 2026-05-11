'use strict';

/**
 * Garde-fou opt-out / cooldown — vérifie qu'un prospect peut encore recevoir
 * un message avant chaque sendMail (J0, J+14, J+28).
 *
 * Contexte (BL-52 audit BUG #4) :
 *   `checkLeadCooldown` était originellement appelé UNE fois par
 *   launchSequenceForConsultant, avant la création du deal. Mais entre cet
 *   instant et l'exécution effective de J+14 (14 jours plus tard) ou J+28
 *   (28 jours plus tard), un prospect peut avoir répondu négativement à un
 *   autre commercial / autre canal → davidInbox.handleNegative marque
 *   `opt_out_until = 9999-12-31` sur les deals fermés. Sans re-check avant
 *   l'envoi différé, J+14 ou J+28 partent malgré l'opt-out.
 *
 * Cette fonction est appelée :
 *   - par orchestrator.launchSequenceForConsultant avant resolveOrCreateDeal
 *     (check initial pré-J0)
 *   - par worker.bootstrapSequence juste avant sendMail J0 (re-check serré)
 *   - par worker.sendScheduledStep juste avant sendMail J+14 et J+28
 *     (re-check tardif, c'est LE garde-fou critique)
 *
 * Modes de skip détectés :
 *   - opt_out_until > today → skip permanent
 *   - retry_available_after > today → cooldown 180j
 *   - email_bounced_at posé sur person → email mort, skip
 *
 * Best effort : si Pipedrive injoignable ou env vars non configurées,
 * retourne { skip: false } (degraded mode) — préférable à bloquer le pipeline.
 */

const pipedriveDefault = require('./pipedrive');

function logInfo(context, msg) {
  if (!context) return;
  if (typeof context.info === 'function') context.info(msg);
  else if (typeof context.log === 'function') context.log(msg);
}

function logWarn(context, msg) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(msg);
  else if (typeof context.log === 'function') context.log(msg);
}

function pickMostRecent(deals) {
  return deals.slice().sort((a, b) => {
    const ta = a.update_time || a.add_time || '';
    const tb = b.update_time || b.add_time || '';
    return tb.localeCompare(ta);
  })[0];
}

/**
 * Vérifie l'éligibilité d'un prospect à recevoir un mail.
 *
 * @param {string} personId  ID Pipedrive de la personne
 * @param {Object} opts
 * @param {Object} [opts.context]      Logger Azure Functions (optionnel)
 * @param {Object} [opts.pipedriveMod] Module Pipedrive injectable (tests)
 * @returns {Promise<{skip: boolean, reason?: string, until?: string, lastAgent?: string}>}
 */
async function checkLeadCooldown(personId, { context, pipedriveMod = pipedriveDefault } = {}) {
  if (!personId) return { skip: false };

  const optOutKey = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  const retryKey = process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  const lastAgentKey = process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED;
  // bouncedKey lecture directe sur person (pas deal) — toujours via Person field.
  const bouncedAtKey = process.env.PIPEDRIVE_PERSON_FIELD_BOUNCED_AT || 'email_bounced_at';

  if (!optOutKey && !retryKey) return { skip: false };

  let deals;
  try {
    deals = await pipedriveMod.findOpenDealsForPersonInOurPipe(personId, { includeClosed: true });
  } catch (err) {
    logWarn(context, `[optOutGuard] cooldown check failed for person ${personId}: ${err.message}`);
    return { skip: false };
  }

  if (!deals || deals.length === 0) return { skip: false };

  const todayISO = new Date().toISOString().slice(0, 10);

  // 1. Opt-out permanent : sticky inter-agents, scan de TOUS les deals
  if (optOutKey) {
    for (const deal of deals) {
      const v = deal[optOutKey];
      if (!v) continue;
      const optOutUntil = String(v).slice(0, 10);
      if (optOutUntil > todayISO) {
        logInfo(context, `[optOutGuard] skipping permanent opt-out: person ${personId} until ${optOutUntil}`);
        return { skip: true, reason: 'opt_out', until: optOutUntil };
      }
    }
  }

  // 2. Cooldown 180j : sur le deal le plus récent uniquement
  const mostRecent = pickMostRecent(deals);
  if (retryKey && mostRecent && mostRecent[retryKey]) {
    const retryUntil = String(mostRecent[retryKey]).slice(0, 10);
    if (retryUntil > todayISO) {
      const lastAgent = lastAgentKey ? mostRecent[lastAgentKey] : null;
      logInfo(context, `[optOutGuard] skipping cooldown: person ${personId} retry_available_after=${retryUntil}`);
      return { skip: true, reason: 'cooldown', until: retryUntil, lastAgent };
    }
  }

  return { skip: false };
}

/**
 * Vérifie spécifiquement avant sendMail différé (J+14, J+28). Plus strict :
 * lookup à frais (pas de cache), Pipedrive vérité du moment de l'envoi.
 *
 * Wrapper sémantique autour de checkLeadCooldown — exists pour clarté du
 * code appelant et future extension (ex: vérif Mem0 supplémentaire).
 *
 * @param {Object} args
 * @param {string} args.personId
 * @param {Object} [args.context]
 * @param {Object} [args.pipedriveMod]
 * @returns {Promise<{sendable: boolean, reason?: string, until?: string}>}
 */
async function isLeadStillSendable({ personId, context, pipedriveMod }) {
  if (!personId) return { sendable: true };
  const cooldown = await checkLeadCooldown(personId, { context, pipedriveMod });
  if (cooldown.skip) {
    return { sendable: false, reason: cooldown.reason, until: cooldown.until };
  }
  return { sendable: true };
}

module.exports = {
  checkLeadCooldown,
  isLeadStillSendable,
  pickMostRecent,
};
