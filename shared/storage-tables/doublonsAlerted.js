'use strict';

/**
 * Idempotence des alertes anti-doublons (cf. shared/sent-items-monitor.js).
 *
 * Contexte (chantier post-incident 11 mai 2026) :
 *   Le cron sentItemsMonitor tourne toutes les heures et scan Sent Items des
 *   3 boîtes david@/martin@/mila@. Si on alertait l'admin à chaque tick sur
 *   le même incident, on spammerait 24× par jour pour un seul vrai doublon.
 *
 *   Cette table garde une trace des groupes déjà alertés. Une nouvelle alerte
 *   n'est envoyée que si :
 *     (a) le groupHash n'a jamais été alerté, OU
 *     (b) la dernière alerte date de > ALERT_COOLDOWN_MS (défaut 24h), OU
 *     (c) le count a strictement augmenté depuis la dernière alerte
 *         (= un nouvel envoi suspect a été ajouté au groupe)
 *
 * Schéma :
 *   PartitionKey : 'alert'
 *   RowKey       : groupHash (24 chars hex stable, cf. sent-items-monitor)
 *   firstAlertedAt, lastAlertedAt, lastCount, lastSeverity
 *   mailbox, recipient, normalizedSubject (denormalisé pour debug)
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.DOUBLONS_ALERTED_TABLE || 'DoublonsAlerted';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 24 * 3600 * 1000);

/**
 * Détermine s'il faut alerter sur ce groupHash. Si oui, écrit/met à jour
 * l'entrée et retourne true.
 *
 * @param {object} args
 * @param {string} args.groupHash
 * @param {number} args.count
 * @param {string} args.severity
 * @param {string} [args.mailbox]
 * @param {string} [args.recipient]
 * @param {string} [args.normalizedSubject]
 * @param {Date} [args.now]
 * @returns {Promise<{shouldAlert: boolean, reason: string}>}
 */
async function checkAndMarkAlerted({ groupHash, count, severity, mailbox, recipient, normalizedSubject, now = new Date() } = {}) {
  if (!groupHash) return { shouldAlert: false, reason: 'no_group_hash' };
  const client = getTableClient(TABLE_NAME);
  if (!client) {
    // Best effort : si pas de storage, on alerte quand même (préfère un faux
    // positif à un silence sur un vrai doublon).
    return { shouldAlert: true, reason: 'no_storage_fallback' };
  }
  await ensureTable(client, TABLE_NAME);

  const nowIso = now.toISOString();
  let existing = null;
  try {
    existing = await client.getEntity('alert', groupHash);
  } catch (err) {
    if (!(err && err.statusCode === 404)) {
      // Erreur transitoire → alerter par sécurité
      return { shouldAlert: true, reason: 'storage_error_fallback', error: err.message };
    }
  }

  const denormalized = {
    mailbox: String(mailbox || ''),
    recipient: String(recipient || ''),
    normalizedSubject: String(normalizedSubject || '').slice(0, 250),
    lastCount: count,
    lastSeverity: String(severity || ''),
    lastAlertedAt: nowIso,
  };

  if (!existing) {
    // Première alerte sur ce groupe
    try {
      await client.createEntity({
        partitionKey: 'alert',
        rowKey: groupHash,
        firstAlertedAt: nowIso,
        ...denormalized,
      });
      return { shouldAlert: true, reason: 'first_time' };
    } catch (err) {
      // race : un autre cron a créé entre-temps → on n'alerte pas (déjà fait)
      return { shouldAlert: false, reason: 'race_already_created' };
    }
  }

  // Already alerted — check cooldown OU augmentation count
  const lastAlertedMs = Date.parse(existing.lastAlertedAt || '');
  const ageMs = now.getTime() - lastAlertedMs;
  const previousCount = Number(existing.lastCount || 0);
  const countIncreased = count > previousCount;

  const shouldAlert = ageMs > ALERT_COOLDOWN_MS || countIncreased;

  if (shouldAlert) {
    try {
      await client.updateEntity({
        partitionKey: 'alert',
        rowKey: groupHash,
        ...denormalized,
      }, 'Merge');
    } catch {
      // Best effort
    }
    return { shouldAlert: true, reason: countIncreased ? 'count_increased' : 'cooldown_expired' };
  }

  return { shouldAlert: false, reason: 'within_cooldown' };
}

module.exports = {
  checkAndMarkAlerted,
  _TABLE_NAME: TABLE_NAME,
  _ALERT_COOLDOWN_MS: ALERT_COOLDOWN_MS,
};
