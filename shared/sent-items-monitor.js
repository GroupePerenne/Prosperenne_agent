'use strict';

/**
 * Monitoring anti-doublons des envois depuis les 3 boîtes david@/martin@/mila@.
 *
 * Contexte (incident 11 mai 2026, 12 doublons à Johnny détectés 11 jours après) :
 *   Le pilote OSEYS opère 3 boîtes mail qui envoient automatiquement à des
 *   consultants et prospects. Aucun garde-fou ne détecte un envoi anormal en
 *   doublon avant qu'un humain le constate par hasard. C'est ce qui s'est
 *   passé pour Johnny (12 mails identiques en une matinée, vus 11 jours après).
 *
 * Approche :
 *   Function timer (cron 1h) scan les Sent Items des 3 boîtes via Graph,
 *   groupe les envois par (mailbox, destinataire, subject normalisé), et
 *   alerte ADMIN_EMAIL si un groupe dépasse un seuil (≥2 mails / 24h ou
 *   ≥4 mails / 7 jours). Idempotence via Storage Table DoublonsAlerted.
 *
 * Module pur (sans dépendance Graph ou Azure) — la logique de détection
 * est testable. Le cron handler vit dans src/functions/sentItemsMonitor.js.
 */

const crypto = require('node:crypto');

const THRESHOLD_24H = Number(process.env.MONITOR_THRESHOLD_24H || 2);
const THRESHOLD_7D = Number(process.env.MONITOR_THRESHOLD_7D || 4);

/**
 * Normalise un subject pour grouper les variations légitimes ensemble :
 *   - lowercase + trim
 *   - retire les préfixes Re:, RE:, Fwd:, TR:, etc. (multiples possibles)
 *   - retire les segments de date "DD/MM/YYYY" (digest quotidien daté)
 *   - retire les hash de tracking type "| ABC123XYZ" en fin de subject
 *   - collapse spaces
 */
function normalizeSubject(subject) {
  if (!subject) return '';
  let s = String(subject).toLowerCase().trim();
  // Retire préfixes empilés "re: re: fwd: ..."
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/^(re|fwd|fw|tr|rep)[\s:.\-]+/i, '').trim();
    if (s === before) break;
  }
  // Retire segments date "— 04/05/2026" ou "- 04/05/2026" ou "04-05-2026"
  s = s.replace(/[—\-–]\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/g, '');
  // Retire hash trailing "| ABC123 XYZ456" (spam IDs)
  s = s.replace(/\s*\|\s*[a-z0-9]+(\s+[a-z0-9]+)*\s*$/i, '');
  // Collapse spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Calcule une clé de groupage stable (mailbox, recipient, subject normalisé).
 * Le hash sert aussi de RowKey idempotence dans DoublonsAlerted.
 */
function makeGroupKey({ mailbox, recipient, subject }) {
  const norm = normalizeSubject(subject);
  const rec = String(recipient || '').toLowerCase().trim();
  const mb = String(mailbox || '').toLowerCase().trim();
  return { mailbox: mb, recipient: rec, normalizedSubject: norm, hash: hashStable(`${mb}|${rec}|${norm}`) };
}

function hashStable(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 24);
}

/**
 * Groupe une liste de messages par (mailbox, recipient, subject normalisé).
 *
 * @param {Array<{mailbox, recipient, subject, sentDateTime, messageId?}>} messages
 * @returns {Map<string, {key, messages, count}>}
 */
function groupBySimilarity(messages) {
  const groups = new Map();
  for (const m of messages) {
    const key = makeGroupKey({ mailbox: m.mailbox, recipient: m.recipient, subject: m.subject });
    const existing = groups.get(key.hash);
    if (existing) {
      existing.messages.push(m);
      existing.count++;
    } else {
      groups.set(key.hash, { key, messages: [m], count: 1 });
    }
  }
  return groups;
}

/**
 * Détecte les groupes qui dépassent les seuils. Retourne un tableau de groupes
 * suspects avec leur niveau d'alerte.
 *
 * @param {Map} groups - sortie de groupBySimilarity
 * @param {Date} [now]
 * @returns {Array<{key, count, severity: 'WARN'|'ALERT', windowHours, messages}>}
 */
function detectSuspectGroups(groups, now = new Date()) {
  const suspects = [];
  const nowMs = now.getTime();
  const ms24h = 24 * 3600_000;
  const ms7d = 7 * 24 * 3600_000;

  for (const group of groups.values()) {
    const sentTimes = group.messages.map((m) => new Date(m.sentDateTime).getTime()).sort();
    const inLast24h = sentTimes.filter((t) => nowMs - t <= ms24h).length;
    const inLast7d = sentTimes.filter((t) => nowMs - t <= ms7d).length;

    if (inLast24h >= THRESHOLD_24H) {
      suspects.push({ key: group.key, count: inLast24h, severity: 'ALERT', windowHours: 24, messages: group.messages });
    } else if (inLast7d >= THRESHOLD_7D) {
      suspects.push({ key: group.key, count: inLast7d, severity: 'WARN', windowHours: 7 * 24, messages: group.messages });
    }
  }
  return suspects;
}

/**
 * Génère le HTML d'alerte ADMIN_EMAIL pour un ensemble de groupes suspects.
 */
function formatAlertHtml(suspects) {
  const rows = suspects.map((s) => {
    const ts = s.messages.map((m) => m.sentDateTime).sort().reverse().slice(0, 5);
    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${escape(s.key.mailbox)}</strong> → ${escape(s.key.recipient)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee">${escape(s.key.normalizedSubject || '(empty subject)')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center"><span style="background:${s.severity === 'ALERT' ? '#D47646' : '#F39561'};color:white;padding:2px 8px;border-radius:6px;font-size:12px">${s.count}× / ${s.windowHours === 24 ? '24h' : '7j'}</span></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:11px;color:#666">${ts.map((t) => escape(t)).join('<br>')}</td>
      </tr>
    `;
  }).join('');

  return `
    <div style="font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:12pt;color:#1a1714">
      <h2 style="color:#D47646;margin:0 0 8px">Monitoring anti-doublons — alertes</h2>
      <p style="margin:0 0 16px;color:#555">${suspects.length} groupe(s) d'envois suspects détecté(s) sur les 3 boîtes david@/martin@/mila@. Seuils : ≥${THRESHOLD_24H} mails/24h (ALERT) ou ≥${THRESHOLD_7D} mails/7j (WARN).</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:8px;text-align:left">Boîte → destinataire</th>
            <th style="padding:8px;text-align:left">Sujet normalisé</th>
            <th style="padding:8px;text-align:center">Volume</th>
            <th style="padding:8px;text-align:left">Derniers envois (UTC)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#888;font-size:11px">Si la cadence est légitime (ex : digest quotidien), ajuster le seuil via MONITOR_THRESHOLD_24H / MONITOR_THRESHOLD_7D ou améliorer normalizeSubject() pour distinguer les variantes.</p>
    </div>
  `;
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = {
  normalizeSubject,
  makeGroupKey,
  hashStable,
  groupBySimilarity,
  detectSuspectGroups,
  formatAlertHtml,
  _THRESHOLD_24H: THRESHOLD_24H,
  _THRESHOLD_7D: THRESHOLD_7D,
};
