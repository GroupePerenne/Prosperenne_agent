'use strict';

/**
 * Récap quotidien envoyé à chaque consultant pilote OSEYS — module pur.
 *
 * Contexte (recadrage Paul 12 mai 2026 PM) :
 *   La version précédente du dailyReport faisait générer du texte par
 *   Claude avec instruction "1-2 propositions d actions concrètes pour
 *   aujourd hui" + tutoiement. Posture stagiaire paniqué qui propose des
 *   choses à faire même quand il n y a rien à dire.
 *
 *   Paul a tranché : "On n a pas à subir les dailyReport, on les ajuste
 *   avec le ton souhaité. Factuel sur les chiffres (tableau dans l esprit
 *   de celui du COMEX, seulement avec leurs chiffres), posture de
 *   responsable, pas de stagiaire paniqué."
 *
 *   Refonte : template HTML structuré (pas de Claude pour générer du texte),
 *   tableau hier + cumul semaine pour CE consultant uniquement, vouvoiement
 *   par défaut (sauf brief tutoiement:true), pas de proposition d action
 *   ajoutée artificiellement.
 *
 * Module pur, sans dépendance Azure ou Pipedrive. Le caller (dailyReport.js)
 * fournit les entries dailyMetrics déjà filtrées au consultant.
 */

const { aggregate7Days, aggregateSingleDay, computeRates } = require('./comex-digest');

/**
 * Génère le HTML d un récap consultant.
 *
 * @param {object} args
 * @param {string} args.consultantPrenom - "Morgane", "Johnny", "Elie"
 * @param {string} args.consultantEmail
 * @param {Array}  args.entries - sortie Storage Table dailyMetrics filtrées au consultant
 * @param {string} args.dateRefIso - YYYY-MM-DD (généralement hier)
 * @param {boolean} [args.tutoiement=false] - brief consultant `tutoiement`
 * @param {string[]} [args.alerts=[]] - lignes d alerte spécifiques ce consultant
 * @returns {string} HTML
 */
function formatConsultantDigestHtml({ consultantPrenom, consultantEmail, entries, dateRefIso, tutoiement = false, alerts = [] } = {}) {
  const singleDay = aggregateSingleDay(entries, dateRefIso);
  const weekly = aggregate7Days(entries, dateRefIso);
  const rates = computeRates(weekly.totals);

  const dateLabelFR = formatDateFR(dateRefIso);
  const weekStartFR = formatDateFR(weekly.dateStart);
  const greeting = tutoiement
    ? `Salut ${escape(consultantPrenom)},`
    : `Bonjour ${escape(consultantPrenom)},`;

  return `
    <div style="font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:11pt;color:#1a1714;max-width:660px">
      <p style="margin:0 0 16px;line-height:1.5">${greeting}</p>
      <p style="margin:0 0 20px;line-height:1.5;color:#555">
        Point quotidien de ${escape(consultantPrenom)} sur la prospection Prospérenne, ${escape(dateLabelFR)}. Tableaux des chiffres de la veille et cumul des 7 derniers jours.
      </p>

      ${formatDayBlock(singleDay, dateLabelFR)}
      ${formatWeekBlock(weekly, weekStartFR, dateLabelFR, rates)}
      ${formatAlertsBlock(alerts)}

      <p style="margin:24px 0 8px;color:#1a1714">— David</p>
      <p style="margin:0 0 0;color:#888;font-size:10pt;border-top:1px solid #eee;padding-top:12px">
        Récap automatique du dispositif Prospérenne. Pour le détail granulaire, ouvrez le timeline de chaque deal sur Pipedrive ou rendez-vous sur votre dashboard <a href="https://app.pereneo.eu/prosperenne" style="color:#D47646;text-decoration:none">app.pereneo.eu</a>.
      </p>
    </div>
  `;
}

function formatDayBlock(day, dateLabelFR) {
  const t = day.totals;
  if (!day.hasData || (t.total_sent === 0 && t.replies === 0 && t.rdv_set === 0)) {
    return `
      <h2 style="color:#1a1714;margin:0 0 8px;font-size:13pt">Hier (${escape(dateLabelFR)})</h2>
      <p style="margin:0 0 20px;color:#666">Aucune activité de prospection enregistrée sur la journée.</p>
    `;
  }
  return `
    <h2 style="color:#1a1714;margin:0 0 8px;font-size:13pt">Hier (${escape(dateLabelFR)})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11pt;margin-bottom:20px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:6px 10px;text-align:left">Indicateur</th>
          <th style="padding:6px 10px;text-align:right">Total</th>
          <th style="padding:6px 10px;text-align:right;color:#666">Martin / Mila</th>
        </tr>
      </thead>
      <tbody>
        ${row('Envois prospects', t.total_sent, t.martin_sent, t.mila_sent)}
        ${row('Ouvertures détectées', t.total_opens, t.martin_opens, t.mila_opens)}
        ${row('Réponses reçues', t.replies)}
        ${row('RDV fixés', t.rdv_set)}
      </tbody>
    </table>
  `;
}

function formatWeekBlock(week, weekStartFR, weekEndFR, rates) {
  const t = week.totals;
  if (!week.hasData) {
    return `
      <h2 style="color:#1a1714;margin:0 0 8px;font-size:13pt">Cumul 7 jours (${escape(weekStartFR)} → ${escape(weekEndFR)})</h2>
      <p style="margin:0 0 20px;color:#666">Aucune activité enregistrée sur la fenêtre.</p>
    `;
  }
  return `
    <h2 style="color:#1a1714;margin:0 0 8px;font-size:13pt">Cumul 7 jours (${escape(weekStartFR)} → ${escape(weekEndFR)})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11pt;margin-bottom:12px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="padding:6px 10px;text-align:left">Indicateur</th>
          <th style="padding:6px 10px;text-align:right">Total</th>
          <th style="padding:6px 10px;text-align:right;color:#666">Martin / Mila</th>
        </tr>
      </thead>
      <tbody>
        ${row('Envois prospects', t.total_sent, t.martin_sent, t.mila_sent)}
        ${row('Ouvertures détectées', t.total_opens, t.martin_opens, t.mila_opens)}
        ${row('Réponses reçues', t.replies)}
        ${row('RDV fixés', t.rdv_set)}
      </tbody>
    </table>
    <p style="margin:0 0 20px;font-size:11pt;color:#555">
      <strong>Taux observables</strong> :
      ouverture ${formatRate(rates.openRate)} · réponse ${formatRate(rates.replyRate)} · RDV/réponse ${formatRate(rates.rdvRate)}.
    </p>
  `;
}

function formatAlertsBlock(alerts) {
  if (!alerts || alerts.length === 0) return '';
  const items = alerts.map((a) => `<li style="margin:0 0 6px">${escape(a)}</li>`).join('');
  return `
    <h2 style="color:#D47646;margin:0 0 8px;font-size:13pt">À signaler</h2>
    <ul style="margin:0 0 20px;padding-left:20px;color:#1a1714">${items}</ul>
  `;
}

function row(label, total, martin, mila) {
  const right = (martin !== undefined && mila !== undefined)
    ? `${martin} / ${mila}`
    : '';
  return `
    <tr style="border-bottom:1px solid #eee">
      <td style="padding:6px 10px">${escape(label)}</td>
      <td style="padding:6px 10px;text-align:right;font-weight:600">${total}</td>
      <td style="padding:6px 10px;text-align:right;color:#666;font-size:10pt">${right}</td>
    </tr>
  `;
}

function formatRate(rate) {
  return rate === null || rate === undefined ? 'n/a' : `${rate}%`;
}

function formatDateFR(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return '';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

module.exports = {
  formatConsultantDigestHtml,
};
