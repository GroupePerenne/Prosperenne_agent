/**
 * Timer trigger — 8h Paris, du lundi au vendredi.
 *
 * Pour chaque consultant pilote actif, David envoie un récap quotidien de
 * l activité Prospérenne de la veille + cumul 7 jours.
 *
 * Refonte 12 mai 2026 PM (recadrage Paul) :
 *   Avant : prompt Claude avec instruction "1-2 propositions d actions
 *   concrètes pour aujourd hui" + tutoiement par défaut → posture stagiaire
 *   paniqué qui propose des choses à faire même sans matière.
 *   Après : template HTML structuré factuel (cf. shared/consultant-digest.js),
 *   tableau dans l esprit du récap COMEX mais scopé sur les chiffres du seul
 *   consultant. Pas de Claude pour générer du texte. Vouvoiement par défaut,
 *   tutoiement seulement si brief consultantOnboarding tutoiement:true.
 *
 * Source des chiffres : Storage Table `dailyMetrics` alimentée par
 * dailyDigest 00h. Source du registre tu/vous : Storage Table
 * `consultantOnboarding` champ responses.tutoiement.
 *
 * Heure locale Paris : garantie par l app setting `WEBSITE_TIME_ZONE=Romance
 * Standard Time` sur le Function App.
 */

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { sendMail } = require('../../shared/graph-mail');
const { recordAction } = require('../../shared/storage-tables/davidActions');
const { parisDateParts } = require('../../shared/holidays');
const { readEventsSince, summarizeEventsHtml } = require('../../shared/leadSelectorTrace');
const { makeSafeLogger } = require('../../shared/safe-log');
const { davidSignatureHtml } = require('../../shared/templates');
const { formatConsultantDigestHtml } = require('../../shared/consultant-digest');

const DAILY_METRICS_TABLE = process.env.DAILY_METRICS_TABLE || 'dailyMetrics';
const CONSULTANT_ONBOARDING_TABLE = process.env.CONSULTANT_ONBOARDING_TABLE || 'consultantOnboarding';

// ─── Helpers dates ─────────────────────────────────────────────────────────
function getYesterdayParisISO() {
  const now = new Date();
  const { isoDate } = parisDateParts(now);
  const [y, m, d] = isoDate.split('-').map(Number);
  const dd = new Date(Date.UTC(y, m - 1, d));
  dd.setUTCDate(dd.getUTCDate() - 1);
  return dd.toISOString().slice(0, 10);
}

function formatDateFR(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ─── Lecture Storage Tables ────────────────────────────────────────────────

/**
 * Lit toutes les entries dailyMetrics sur les 8 derniers jours pour un
 * consultant donné. Schéma cf. shared/comex-digest.js + dailyDigest.
 */
async function readConsultantMetrics(consultantPrenomLower, dateRefIso) {
  const conn = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!conn) return [];
  const tc = TableClient.fromConnectionString(conn, DAILY_METRICS_TABLE);

  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  const startMs = refMs - 7 * 24 * 3600_000;
  const dateStart = new Date(startMs).toISOString().slice(0, 10);
  const monthsToScan = new Set([dateRefIso.slice(0, 7), dateStart.slice(0, 7)]);

  const entries = [];
  for (const month of monthsToScan) {
    try {
      const iter = tc.listEntities({
        queryOptions: { filter: `PartitionKey eq '${month}'` },
      });
      for await (const e of iter) {
        if (!e || !e.date) continue;
        if (String(e.consultant || '').toLowerCase() !== consultantPrenomLower) continue;
        const t = Date.parse(`${e.date}T00:00:00Z`);
        if (t >= startMs && t <= refMs) entries.push(e);
      }
    } catch {
      // Best effort par mois
    }
  }
  return entries;
}

/**
 * Lit le brief consultant (champ tutoiement notamment) depuis
 * `consultantOnboarding`. Retourne `tutoiement` bool, défaut false (vouvoiement).
 */
async function readConsultantBrief(consultantEmail) {
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return { tutoiement: false };
  const tc = TableClient.fromConnectionString(conn, CONSULTANT_ONBOARDING_TABLE);
  try {
    const entity = await tc.getEntity('consultant', String(consultantEmail || '').toLowerCase());
    if (entity && entity.responses) {
      const responses = typeof entity.responses === 'string'
        ? JSON.parse(entity.responses)
        : entity.responses;
      return {
        tutoiement: Boolean(responses && responses.tutoiement),
      };
    }
  } catch {
    // Best effort : pas de brief = vouvoiement par défaut
  }
  return { tutoiement: false };
}

// ─── Timer trigger ─────────────────────────────────────────────────────────
app.timer('dailyReport', {
  schedule: '0 0 8 * * 1-5', // 8h00 Paris (via WEBSITE_TIME_ZONE), lun-ven
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);

    if (process.env.DAILY_REPORT_ENABLED !== '1') {
      log('[dailyReport] skipped (DAILY_REPORT_ENABLED != 1) — pilote pas activé');
      return;
    }

    const yesterday = getYesterdayParisISO();
    log(`[dailyReport] tick for ${yesterday}`);

    const consultants = [
      { email: process.env.MORGANE_EMAIL, prenom: 'Morgane' },
      { email: process.env.JOHNNY_EMAIL, prenom: 'Johnny' },
      { email: process.env.ELIE_EMAIL, prenom: 'Elie' },
    ].filter((c) => c.email);

    if (consultants.length === 0) {
      log.warn('[dailyReport] aucun consultant configuré (MORGANE_EMAIL / JOHNNY_EMAIL / ELIE_EMAIL absents)');
      return;
    }

    for (const consultant of consultants) {
      try {
        const consultantLower = consultant.prenom.toLowerCase();
        const entries = await readConsultantMetrics(consultantLower, yesterday);
        const brief = await readConsultantBrief(consultant.email);

        const html = formatConsultantDigestHtml({
          consultantPrenom: consultant.prenom,
          consultantEmail: consultant.email,
          entries,
          dateRefIso: yesterday,
          tutoiement: brief.tutoiement,
          alerts: [], // hook futur : sentItemsMonitor scopé consultant, bounces, etc.
        });

        await sendMail({
          from: process.env.DAVID_EMAIL,
          to: consultant.email,
          subject: `Point quotidien Prospérenne — ${formatDateFR(yesterday)}`,
          html,
        });
        log(`[dailyReport] sent to ${consultant.email} — ${entries.length} entries 8j`);

        await recordAction({
          consultantEmail: consultant.email,
          type: 'daily_brief_sent',
          summary: `Récap quotidien Prospérenne envoyé pour le ${formatDateFR(yesterday)}`,
          metadata: { date: yesterday, entriesCount: entries.length, tutoiement: brief.tutoiement },
          at: new Date().toISOString(),
        }).catch(() => null);
      } catch (err) {
        log.error(`[dailyReport] failed for ${consultant.email}: ${err.message}`);
      }
    }

    // Section Lead Selector — mail séparé envoyé à direction (escalation),
    // pas aux consultants. Best effort.
    try {
      await sendLeadSelectorReport(yesterday, context);
    } catch (err) {
      log.error(`[dailyReport] leadSelector section failed: ${err.message}`);
    }
  },
});

async function sendLeadSelectorReport(yesterday, context) {
  const log = makeSafeLogger(context);
  const events = await readEventsSince(yesterday);
  if (!events || events.length === 0) {
    log('[dailyReport] no Lead Selector events for the past 24h');
    return;
  }
  const html = summarizeEventsHtml(events, { dateLabel: formatDateFR(yesterday) });
  if (!html) return;
  const to = process.env.ESCALATION_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) {
    log.warn('[dailyReport] no ESCALATION_EMAIL/ADMIN_EMAIL configured, skipping Lead Selector report');
    return;
  }
  await sendMail({
    from: process.env.DAVID_EMAIL,
    to,
    subject: `Lead Selector — rapport ${formatDateFR(yesterday)}`,
    html: `<div style="font-family:Arial,sans-serif;color:#1a1714"><p>Bonjour,</p><p>Synthèse des exécutions Lead Selector des dernières 24h.</p>${html}${davidSignatureHtml()}</div>`,
  });
  log(`[dailyReport] Lead Selector report sent to ${to} (${events.length} events)`);
}

module.exports = {
  readConsultantMetrics,
  readConsultantBrief,
  getYesterdayParisISO,
  formatDateFR,
};
