'use strict';

/**
 * Timer trigger — toutes les heures.
 *
 * Scan les Sent Items des 3 boîtes david@/martin@/mila@ sur les 7 derniers
 * jours, détecte les groupes d'envois similaires anormaux, alerte
 * ADMIN_EMAIL si seuils dépassés.
 *
 * Contexte (chantier post-incident 11 mai 2026, 12 doublons à Johnny détectés
 * 11 jours après) : objectif de détection T+30-60 min au lieu de T+11 jours.
 *
 * Idempotence via Storage Table DoublonsAlerted (cooldown 24h par groupe,
 * ré-alerte si count augmente strictement).
 *
 * Seuils env (cf. shared/sent-items-monitor.js) :
 *   MONITOR_THRESHOLD_24H (défaut 2) — ALERT si ≥ N mails même groupe en 24h
 *   MONITOR_THRESHOLD_7D  (défaut 4) — WARN  si ≥ N mails même groupe en 7j
 */

const { app } = require('@azure/functions');
const { sendMail, getToken } = require('../../shared/graph-mail');
const { makeSafeLogger } = require('../../shared/safe-log');
const {
  groupBySimilarity,
  detectSuspectGroups,
  formatAlertHtml,
} = require('../../shared/sent-items-monitor');
const { checkAndMarkAlerted } = require('../../shared/storage-tables/doublonsAlerted');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function fetchSentItems({ mailbox, token, sinceIso }) {
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/SentItems/messages?$filter=sentDateTime ge ${sinceIso}&$top=100&$orderby=sentDateTime desc&$select=id,subject,toRecipients,sentDateTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Graph Sent ${mailbox} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.value || []).map((m) => ({
    mailbox,
    messageId: m.id,
    subject: m.subject,
    recipient: m.toRecipients && m.toRecipients[0] && m.toRecipients[0].emailAddress
      ? m.toRecipients[0].emailAddress.address
      : '',
    sentDateTime: m.sentDateTime,
  }));
}

app.timer('sentItemsMonitor', {
  schedule: '0 0 */1 * * *', // toutes les heures pile
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    try {
      const mailboxes = [process.env.DAVID_EMAIL, process.env.MARTIN_EMAIL, process.env.MILA_EMAIL].filter(Boolean);
      if (mailboxes.length === 0) {
        log('[sentItemsMonitor] aucune mailbox configurée (DAVID_EMAIL/MARTIN_EMAIL/MILA_EMAIL absents)');
        return;
      }

      const adminEmail = process.env.ADMIN_EMAIL || 'direction@perennereseau.fr';
      const now = new Date();
      const since = new Date(now.getTime() - 7 * 24 * 3600_000); // 7 jours
      const sinceIso = since.toISOString();

      const token = await getToken();
      const allMessages = [];
      for (const mailbox of mailboxes) {
        try {
          const msgs = await fetchSentItems({ mailbox, token, sinceIso });
          allMessages.push(...msgs);
        } catch (err) {
          log.error(`[sentItemsMonitor] fetch ${mailbox} failed: ${err.message}`);
        }
      }

      log(`[sentItemsMonitor] ${allMessages.length} messages scannés sur 7j (${mailboxes.length} boîtes)`);
      if (allMessages.length === 0) return;

      const groups = groupBySimilarity(allMessages);
      const suspects = detectSuspectGroups(groups, now);
      log(`[sentItemsMonitor] ${groups.size} groupes uniques, ${suspects.length} suspects (≥seuils)`);

      // Filtre via idempotence Storage Table
      const toAlert = [];
      for (const s of suspects) {
        const check = await checkAndMarkAlerted({
          groupHash: s.key.hash,
          count: s.count,
          severity: s.severity,
          mailbox: s.key.mailbox,
          recipient: s.key.recipient,
          normalizedSubject: s.key.normalizedSubject,
          now,
        });
        if (check.shouldAlert) {
          toAlert.push(s);
        }
      }

      if (toAlert.length === 0) {
        log('[sentItemsMonitor] aucune nouvelle alerte à envoyer (tous les suspects sont déjà dans le cooldown)');
        return;
      }

      // Envoi unique d'alerte agrégée
      const html = formatAlertHtml(toAlert);
      await sendMail({
        from: process.env.DAVID_EMAIL,
        to: adminEmail,
        subject: `[Interne Prospérenne] ${toAlert.length} groupe(s) d'envois suspects détecté(s) — sentItemsMonitor`,
        html,
      });
      log(`[sentItemsMonitor] alerte envoyée à ${adminEmail} pour ${toAlert.length} groupe(s)`);
    } catch (err) {
      log.error(`[sentItemsMonitor] error: ${err && err.message}`);
    }
  },
});
