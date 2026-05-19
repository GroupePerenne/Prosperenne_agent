'use strict';

/**
 * Timer trigger — quotidien 9h UTC = 11h Paris CEST (= 10h Paris CET hiver).
 *
 * Surveille les deals Pipedrive pipeline 28 (Prospérenne) stage NEW (251)
 * dont l'add_time est plus ancien que DEAL_STUCK_DAYS_THRESHOLD (default 14
 * jours). Alerte direction@perennereseau.fr avec liste structurée si trouvé.
 *
 * Étape 5.3 plan branchement CTO 19/05 (cf. docs/audits/BRANCHEMENT-DAVID-
 * 2026-05-19-RICHARD-CTO.md). Mesure runtime mai 2026 cardinale : 9 deals
 * stage NEW figés sur tout le mois, 0 stage change. Ce monitor capture le
 * cas factuel pour intervention COMEX.
 *
 * Doctrine cron Linux Consumption : schedule interprété UTC (cf. CLAUDE.md
 * §3 + commit 017a27d). 9h UTC = 11h Paris CEST = juste après les J0 du
 * matin (envois 9-11h cron dailyLeadSelectorRefresh 8h UTC). Période :
 * tous les jours (samedi/dimanche inclus pour ne pas perdre 48h en
 * weekend si la pile s'accumule).
 *
 * Best effort : exception interne → log + return. Pas de retry, pas de
 * dead letter queue. Le cron tourne quotidiennement, un échec ponctuel
 * sera couvert le lendemain.
 */

const { app } = require('@azure/functions');
const pipedrive = require('../../shared/pipedrive');
const { sendMail } = require('../../shared/graph-mail');
const { makeSafeLogger } = require('../../shared/safe-log');
const { recordAction: recordDavidAction } = require('../../shared/storage-tables/davidActions');

const DEFAULT_THRESHOLD_DAYS = 14;
const DEFAULT_STAGE_NEW = 251;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'direction@perennereseau.fr';
const FROM_EMAIL = process.env.DAVID_EMAIL || 'david@perennereseau.fr';

function formatDateFR(addTime) {
  if (!addTime) return '?';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(addTime);
  if (!m) return addTime;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatStuckDealsHtml(stuck, thresholdDays) {
  const rows = stuck
    .map((d) => {
      const dealUrl = `https://oseys.pipedrive.com/deal/${d.id}`;
      return `<tr>
  <td><a href="${dealUrl}">#${d.id}</a></td>
  <td>${escapeHtml(d.org)}</td>
  <td>${escapeHtml(d.person)}</td>
  <td>${escapeHtml(d.owner)}</td>
  <td>${formatDateFR(d.addTime)}</td>
  <td style="text-align:right">${d.daysStuck} j</td>
</tr>`;
    })
    .join('');

  return `<div style="font-family:Aptos,Calibri,Arial,sans-serif;font-size:14px;color:#222">
  <p><strong>Alerte deals figés stage NEW</strong> (pipeline 28, seuil ${thresholdDays} jours).</p>
  <p>${stuck.length} deal(s) sans changement de stage depuis ≥ ${thresholdDays} jours :</p>
  <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;border-color:#ddd">
    <thead><tr style="background:#f4f4f4">
      <th>Deal</th><th>Société</th><th>Personne</th><th>Owner</th><th>Ouvert</th><th>Stuck</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:18px">
    Source : pipedrive /v1/deals filter stage_id=${DEFAULT_STAGE_NEW} pipeline=${process.env.PIPEDRIVE_PIPELINE_ID || 28}.
    Monitor quotidien <code>dealsStuckStageMonitor</code> (Étape 5.3 plan branchement).
  </p>
</div>`;
}

async function handleDealsStuckMonitor(timer, context) {
  const safeLog = makeSafeLogger(context);
  const log = safeLog.info ? safeLog.info.bind(safeLog) : (m) => safeLog(m);
  const errLog = safeLog.error ? safeLog.error.bind(safeLog) : log;

  const thresholdDays = Number(process.env.DEAL_STUCK_DAYS_THRESHOLD) || DEFAULT_THRESHOLD_DAYS;
  const stageId = Number(process.env.PIPEDRIVE_STAGE_NEW) || DEFAULT_STAGE_NEW;

  try {
    log(`[deals-stuck-monitor] starting threshold=${thresholdDays}d stage=${stageId}`);

    const stuck = await pipedrive.listStuckDealsInOurPipe({
      daysThreshold: thresholdDays,
      stageId,
    });

    if (!stuck || stuck.length === 0) {
      log(`[deals-stuck-monitor] no stuck deals — clean`);
      return;
    }

    log(`[deals-stuck-monitor] ${stuck.length} stuck deals found, alerting ${ALERT_EMAIL}`);

    const subject = `[ALERTE] ${stuck.length} deal(s) figé(s) stage NEW depuis ≥ ${thresholdDays} jours`;
    const html = formatStuckDealsHtml(stuck, thresholdDays);

    await sendMail({
      from: FROM_EMAIL,
      to: ALERT_EMAIL,
      subject,
      html,
    });

    await recordDavidAction({
      consultantEmail: FROM_EMAIL,
      type: 'deals_stuck_alert',
      summary: `${stuck.length} deals stuck stage ${stageId} ≥ ${thresholdDays}j`,
      metadata: {
        thresholdDays,
        stageId,
        count: stuck.length,
        dealIds: stuck.map((d) => d.id),
      },
    }).catch(() => {});

    log(`[deals-stuck-monitor] alert sent + davidActions logged`);
  } catch (err) {
    errLog(`[deals-stuck-monitor] failed: ${err && err.message}`, err);
  }
}

app.timer('dealsStuckStageMonitor', {
  schedule: '0 0 9 * * *', // 9h UTC = 11h Paris CEST (10h CET hiver), quotidien
  handler: async (timer, context) => handleDealsStuckMonitor(timer, context),
});

module.exports = {
  handleDealsStuckMonitor,
  formatStuckDealsHtml,
  formatDateFR,
};
