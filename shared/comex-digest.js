'use strict';

/**
 * Récap COMEX hebdo + journée précédente — module pur.
 *
 * Contexte (chantier "sortir de l'aveuglement par la mesure", 12 mai 2026) :
 *   Le COMEX (Paul, Constantin, Olivier) opère un pilote Pérenne avec 3
 *   consultants actifs sans tableau de bord observable. Ce module construit
 *   un récap quotidien à direction@perennereseau.fr qui permet de répondre en
 *   2 minutes "combien de mails / réponses / qualifications par consultant".
 *
 *   Source : Azure Storage Table dailyMetrics alimentée par dailyDigest
 *   chaque nuit (cron 00h). Architecture inchangée, on lit ce qui existe.
 *
 * Module pur (sans dépendance Azure ou réseau) — la logique d'agrégation
 * est testable. Le cron handler vit dans src/functions/comexDigest.js.
 */

/**
 * Agrège un tableau d'entries dailyMetrics sur les 7 derniers jours.
 *
 * @param {Array<Object>} entries - entrées dailyMetrics (date, consultant,
 *   martin_sent, mila_sent, martin_opens, mila_opens, replies, rdv_set)
 * @param {string} dateRefIso - date de référence (ex: yesterday ISO)
 * @returns {Object} { perConsultant: Map<consultant, totals>, totals: {...},
 *   numDays, dateStart, dateEnd, hasData }
 */
function aggregate7Days(entries, dateRefIso) {
  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  const startMs = refMs - 6 * 24 * 3600_000; // J-6 inclus → 7 jours total
  const dateStart = new Date(startMs).toISOString().slice(0, 10);
  const dateEnd = dateRefIso;

  const inWindow = (entries || []).filter((e) => {
    if (!e || !e.date) return false;
    const t = Date.parse(`${e.date}T00:00:00Z`);
    return t >= startMs && t <= refMs;
  });

  const perConsultant = new Map();
  const totals = newTotals();

  for (const e of inWindow) {
    const c = String(e.consultant || 'inconnu').toLowerCase();
    if (!perConsultant.has(c)) perConsultant.set(c, newTotals());
    accumulate(perConsultant.get(c), e);
    accumulate(totals, e);
  }

  return {
    perConsultant,
    totals,
    numDays: 7,
    dateStart,
    dateEnd,
    hasData: inWindow.length > 0,
    entriesCount: inWindow.length,
  };
}

/**
 * Filtre les entries pour ne garder que la date `dateIso` exactement.
 * Retourne un objet par consultant + totaux journée.
 */
function aggregateSingleDay(entries, dateIso) {
  const dayEntries = (entries || []).filter((e) => e && e.date === dateIso);
  const perConsultant = new Map();
  const totals = newTotals();
  for (const e of dayEntries) {
    const c = String(e.consultant || 'inconnu').toLowerCase();
    if (!perConsultant.has(c)) perConsultant.set(c, newTotals());
    accumulate(perConsultant.get(c), e);
    accumulate(totals, e);
  }
  return {
    perConsultant,
    totals,
    date: dateIso,
    hasData: dayEntries.length > 0,
  };
}

function newTotals() {
  return {
    martin_sent: 0, mila_sent: 0, total_sent: 0,
    martin_opens: 0, mila_opens: 0, total_opens: 0,
    replies: 0, rdv_set: 0,
  };
}

function accumulate(target, entry) {
  target.martin_sent += Number(entry.martin_sent || 0);
  target.mila_sent += Number(entry.mila_sent || 0);
  target.martin_opens += Number(entry.martin_opens || 0);
  target.mila_opens += Number(entry.mila_opens || 0);
  target.replies += Number(entry.replies || 0);
  target.rdv_set += Number(entry.rdv_set || 0);
  target.total_sent = target.martin_sent + target.mila_sent;
  target.total_opens = target.martin_opens + target.mila_opens;
}

/**
 * Calcule les taux de conversion observables.
 * Retourne des nombres entiers (pourcentages) pour éviter le bruit décimal.
 */
function computeRates(totals) {
  const openRate = totals.total_sent > 0 ? Math.round((totals.total_opens / totals.total_sent) * 100) : null;
  const replyRate = totals.total_sent > 0 ? Math.round((totals.replies / totals.total_sent) * 100) : null;
  const rdvRate = totals.replies > 0 ? Math.round((totals.rdv_set / totals.replies) * 100) : null;
  // Ratio Martin/Mila (utile pour détecter une dérive A/B vers un agent)
  const martinShare = totals.total_sent > 0 ? Math.round((totals.martin_sent / totals.total_sent) * 100) : null;
  return { openRate, replyRate, rdvRate, martinShare };
}

/**
 * Génère le HTML du récap COMEX.
 *
 * Structure :
 *   - Bloc "Hier" : journée précédente, par consultant, métriques + taux
 *   - Bloc "Semaine (J-6 → J0)" : cumul 7j, par consultant, métriques + taux
 *   - Bloc "Alertes" : éléments à signaler (sentItemsMonitor doublons, etc.)
 *
 * @param {Object} args
 * @param {Object} args.singleDay - sortie de aggregateSingleDay
 * @param {Object} args.weekly - sortie de aggregate7Days
 * @param {string} args.dateLabel - "DD/MM/YYYY" pour titre
 * @param {string[]} [args.alerts] - lignes d'alerte (ex: "doublons détectés")
 * @returns {string} HTML
 */
function formatComexDigestHtml({ singleDay, weekly, dateLabel, alerts = [] } = {}) {
  return `
    <div style="font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:11pt;color:#1a1714;max-width:700px">
      <h1 style="color:#D47646;margin:0 0 8px;font-size:18pt">Récap COMEX — ${escape(dateLabel)}</h1>
      <p style="margin:0 0 20px;color:#666;font-size:11pt">État du pilote Pérenne : journée précédente + cumul 7 jours. Lecture cible 2 min.</p>

      ${formatDayBlock(singleDay)}
      ${formatWeekBlock(weekly)}
      ${formatAlertsBlock(alerts)}

      <p style="margin:24px 0 0;color:#888;font-size:10pt;border-top:1px solid #eee;padding-top:12px">
        Source : Azure Storage Table <code>dailyMetrics</code> alimentée par le timer <code>dailyDigest</code> chaque nuit 00h.
        Pour un détail granulaire, voir Pipedrive ou Application Insights.
      </p>
    </div>
  `;
}

function formatDayBlock(day) {
  if (!day.hasData) {
    return `
      <h2 style="color:#1a1714;margin:0 0 8px;font-size:14pt">Hier (${escape(day.date)})</h2>
      <p style="margin:0 0 20px;color:#666;font-style:italic">Aucune activité enregistrée pour cette date dans dailyMetrics. Soit pas de pilote actif, soit le cron dailyDigest n'a pas (encore) écrit.</p>
    `;
  }
  const totalsRow = formatTotalsRow(day.totals, 'Total');
  const consultantRows = Array.from(day.perConsultant.entries())
    .map(([c, t]) => formatTotalsRow(t, capitalize(c)))
    .join('');
  return `
    <h2 style="color:#1a1714;margin:0 0 8px;font-size:14pt">Hier (${escape(day.date)})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11pt;margin-bottom:20px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:6px 10px;text-align:left">Consultant</th>
          <th style="padding:6px 10px;text-align:right">Envois</th>
          <th style="padding:6px 10px;text-align:right">Ouv.</th>
          <th style="padding:6px 10px;text-align:right">Rép.</th>
          <th style="padding:6px 10px;text-align:right">RDV</th>
          <th style="padding:6px 10px;text-align:right">Martin / Mila</th>
        </tr>
      </thead>
      <tbody>${consultantRows}${totalsRow}</tbody>
    </table>
  `;
}

function formatWeekBlock(week) {
  if (!week.hasData) {
    return `
      <h2 style="color:#1a1714;margin:0 0 8px;font-size:14pt">Semaine (${escape(week.dateStart)} → ${escape(week.dateEnd)})</h2>
      <p style="margin:0 0 20px;color:#666;font-style:italic">Aucune donnée sur cette fenêtre 7 jours.</p>
    `;
  }
  const totalsRow = formatTotalsRow(week.totals, 'Total semaine', /*bold*/ true);
  const consultantRows = Array.from(week.perConsultant.entries())
    .map(([c, t]) => formatTotalsRow(t, capitalize(c)))
    .join('');
  const rates = computeRates(week.totals);
  return `
    <h2 style="color:#1a1714;margin:0 0 8px;font-size:14pt">Semaine (${escape(week.dateStart)} → ${escape(week.dateEnd)})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11pt;margin-bottom:12px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:6px 10px;text-align:left">Consultant</th>
          <th style="padding:6px 10px;text-align:right">Envois</th>
          <th style="padding:6px 10px;text-align:right">Ouv.</th>
          <th style="padding:6px 10px;text-align:right">Rép.</th>
          <th style="padding:6px 10px;text-align:right">RDV</th>
          <th style="padding:6px 10px;text-align:right">Martin / Mila</th>
        </tr>
      </thead>
      <tbody>${consultantRows}${totalsRow}</tbody>
    </table>
    <p style="margin:0 0 20px;font-size:11pt;color:#555">
      <strong>Taux observables</strong> :
      ouverture <strong>${formatRate(rates.openRate)}</strong> ·
      réponse <strong>${formatRate(rates.replyRate)}</strong> ·
      RDV/réponse <strong>${formatRate(rates.rdvRate)}</strong> ·
      part Martin <strong>${formatRate(rates.martinShare)}</strong> (vs Mila ${formatRate(rates.martinShare === null ? null : 100 - rates.martinShare)})
    </p>
  `;
}

function formatTotalsRow(t, label, bold = false) {
  const weight = bold ? '600' : '400';
  return `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:6px 10px;font-weight:${weight}">${escape(label)}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:${weight}">${t.total_sent}</td>
      <td style="padding:6px 10px;text-align:right">${t.total_opens}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:${weight}">${t.replies}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:${weight}">${t.rdv_set}</td>
      <td style="padding:6px 10px;text-align:right;color:#666;font-size:10pt">${t.martin_sent} / ${t.mila_sent}</td>
    </tr>
  `;
}

function formatAlertsBlock(alerts) {
  if (!alerts || alerts.length === 0) {
    return `
      <h2 style="color:#1a1714;margin:0 0 8px;font-size:14pt">Alertes</h2>
      <p style="margin:0 0 12px;color:#888;font-style:italic">Aucune alerte sur la fenêtre.</p>
    `;
  }
  const items = alerts.map((a) => `<li style="margin:0 0 6px">${escape(a)}</li>`).join('');
  return `
    <h2 style="color:#D47646;margin:0 0 8px;font-size:14pt">Alertes</h2>
    <ul style="margin:0 0 20px;padding-left:20px;color:#1a1714">${items}</ul>
  `;
}

function formatRate(rate) {
  return rate === null || rate === undefined ? 'n/a' : `${rate}%`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = {
  aggregate7Days,
  aggregateSingleDay,
  computeRates,
  formatComexDigestHtml,
  // Pour tests :
  _newTotals: newTotals,
};
