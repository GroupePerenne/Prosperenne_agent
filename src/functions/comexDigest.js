'use strict';

/**
 * Timer trigger — 7h45 Paris, du lundi au vendredi.
 *
 * Envoie un récap COMEX (journée précédente + cumul 7 jours) à direction@oseys.fr
 * (Paul + Constantin). Objectif : permettre au COMEX de répondre en 2 minutes
 * sur l'état du pilote OSEYS sans ouvrir Pipedrive / AI / autre outil.
 *
 * Source : Azure Storage Table `dailyMetrics` alimentée par dailyDigest 00h.
 * Pré-requis : DAILY_REPORT_ENABLED=1 (le cron dailyDigest écrit cette table
 * uniquement quand activé). Si la table est vide ou ce flag est à 0, le récap
 * est envoyé avec un message "Pilote pas encore en activité".
 *
 * Heure 7h45 (avant dailyReport 8h) : donne au COMEX la visibilité AVANT que
 * les consultants reçoivent leur brief. Si quelque chose cloche, on peut
 * stopper la matinée à temps.
 *
 * Destinataire dérogatoire : ce mail interne ne suit PAS la doctrine jitter
 * humain (cf. shared/jitter.js) — c'est de la télémétrie pour le COMEX, pas
 * de l'échange commercial. Envoi instantané voulu.
 */

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { sendMail } = require('../../shared/graph-mail');
const { parisDateParts } = require('../../shared/holidays');
const { makeSafeLogger } = require('../../shared/safe-log');
const {
  aggregate7Days,
  aggregateSingleDay,
  formatComexDigestHtml,
} = require('../../shared/comex-digest');

const TABLE_NAME = process.env.DAILY_METRICS_TABLE || 'dailyMetrics';

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

/**
 * Lit toutes les entrées dailyMetrics sur les 8 derniers jours (marge 1j pour
 * être sûr de couvrir J-6 → J0).
 *
 * Schéma table (cf. dailyDigest.js) :
 *   PartitionKey = YYYY-MM (mois)
 *   RowKey       = YYYY-MM-DD_<consultant>
 */
async function readDailyMetricsWindow(dateRefIso, tableClient) {
  if (!tableClient) return [];
  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  const startMs = refMs - 7 * 24 * 3600_000; // J-7 (marge 1j)
  const dateStart = new Date(startMs).toISOString().slice(0, 10);

  // On lit la partition du mois courant + celle du mois précédent si la
  // fenêtre les chevauche. C'est plus simple que de calculer un filter
  // précis sur RowKey.
  const monthsToScan = new Set([
    dateRefIso.slice(0, 7),
    dateStart.slice(0, 7),
  ]);

  const entries = [];
  for (const month of monthsToScan) {
    try {
      const iter = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${month}'` },
      });
      for await (const e of iter) {
        // Filtre côté code sur la fenêtre exacte
        if (!e || !e.date) continue;
        const t = Date.parse(`${e.date}T00:00:00Z`);
        if (t >= startMs && t <= refMs) {
          entries.push(e);
        }
      }
    } catch {
      // Best effort par partition
    }
  }
  return entries;
}

async function handleComexDigest(myTimer, context, deps = defaultDeps()) {
  const log = makeSafeLogger(context);

  const adminEmail = process.env.COMEX_EMAIL || process.env.ADMIN_EMAIL || 'direction@oseys.fr';
  const fromEmail = process.env.DAVID_EMAIL;
  if (!fromEmail) {
    log.warn('[comexDigest] DAVID_EMAIL non défini, abort');
    return;
  }

  const yesterday = getYesterdayParisISO();
  log(`[comexDigest] tick for ${yesterday} → ${adminEmail}`);

  const entries = await deps.readMetrics(yesterday);
  log(`[comexDigest] ${entries.length} entries dailyMetrics lues sur fenêtre 8j`);

  const singleDay = aggregateSingleDay(entries, yesterday);
  const weekly = aggregate7Days(entries, yesterday);
  const alerts = []; // Hook pour futures intégrations (sentItemsMonitor, exceptions AI...)

  const html = formatComexDigestHtml({
    singleDay,
    weekly,
    dateLabel: formatDateFR(yesterday),
    alerts,
  });

  try {
    await deps.sendMail({
      from: fromEmail,
      to: adminEmail,
      subject: `Récap COMEX OSEYS — ${formatDateFR(yesterday)}`,
      html,
    });
    log(`[comexDigest] récap envoyé à ${adminEmail}`);
  } catch (err) {
    log.error(`[comexDigest] sendMail failed: ${err.message}`);
  }
}

function defaultDeps() {
  return {
    readMetrics: async (dateRefIso) => {
      const conn = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
      if (!conn) return [];
      const tc = TableClient.fromConnectionString(conn, TABLE_NAME);
      return readDailyMetricsWindow(dateRefIso, tc);
    },
    sendMail,
  };
}

app.timer('comexDigest', {
  schedule: '0 45 7 * * 1-5', // 7h45 Paris (TZ=Europe/Paris), lun-ven
  handler: async (myTimer, context) => handleComexDigest(myTimer, context),
});

module.exports = {
  handleComexDigest,
  readDailyMetricsWindow,
  getYesterdayParisISO,
};
