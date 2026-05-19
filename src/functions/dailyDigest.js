/**
 * Timer trigger — 00h00 Paris (TZ=Europe/Paris).
 *
 * Daily digest agent David vers Charli (mémoire continue Niveau 2).
 * Collecte les stats de prospection J-1 par consultant, persiste dans
 * Azure Storage Table `dailyMetrics` (analytique scalable, PK=YYYY-MM,
 * RK=YYYY-MM-DD_<consultant>), puis pose un événement narratif synthétique
 * sur la queue charli-events via shared/charli-reporter (consommé par la
 * FA pereneo-charli-aggregator → user_id=charli Mem0).
 *
 * Ordre handler strict (CHARLI v1.5 §10) :
 *   1. Collecte metrics Pipedrive par consultant (fail-open par consultant)
 *   2. Write Table dailyMetrics (fail-open : log + continue, n'empêche pas l'étape 3)
 *   3. reportToCharli (fail-open : log seul si {ok: false}, table déjà écrite récupérable)
 *
 * Dependencies injectées via `deps` pour testabilité (cf. pattern repo
 * onQualification.js). Le timer Azure appelle handleDailyDigest avec les
 * deps réels par défaut.
 */

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const { reportToCharli } = require('../../shared/charli-reporter');
const { parisDateParts } = require('../../shared/holidays');
const { makeSafeLogger } = require('../../shared/safe-log');

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

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ─── Pipedrive minimaliste (copie de dailyReport.js, refacto Phase D) ──────

async function callPipedrive(path, query = {}) {
  const token = process.env.PIPEDRIVE_TOKEN;
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  if (!token || !domain) throw new Error('PIPEDRIVE_TOKEN/PIPEDRIVE_COMPANY_DOMAIN non défini');
  const url = new URL(`https://${domain}.pipedrive.com/api/v1${path}`);
  url.searchParams.set('api_token', token);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Pipedrive ${path} ${res.status}`);
  const data = await res.json();
  return data.data || [];
}

async function findPipedriveUserId(email) {
  const users = await callPipedrive('/users', { limit: 500 });
  const match = (Array.isArray(users) ? users : []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  return match?.id || null;
}

async function fetchConsultantMetrics(userId, dateISO) {
  const metrics = { martinSent: 0, milaSent: 0, martinOpens: 0, milaOpens: 0, replies: 0, rdvSet: 0 };

  const activities = await callPipedrive('/activities', {
    user_id: userId,
    done: 1,
    start_date: dateISO,
    end_date: dateISO,
    limit: 500,
  });
  for (const act of (activities || [])) {
    const subject = (act.subject || '').toLowerCase();
    // Fix 19/05 : Pipedrive tenant oseys.pipedrive.com est custom-only — il
    // n'y a pas de type 'email' natif. Quand pipedrive.js logEmailSent POST
    // {type: 'email'}, l'API renvoie type='appel_de_relance' (key_string du
    // custom field id=12). Le filter strict 'email' ne matchait jamais →
    // métriques journalières muettes côté envois Martin/Mila depuis mai.
    // On accepte les 2 valeurs : 'email' (futur tenant standard) ET
    // 'appel_de_relance' (tenant actuel).
    if (act.type === 'email' || act.type === 'appel_de_relance') {
      if (subject.startsWith('[martin]')) metrics.martinSent++;
      else if (subject.startsWith('[mila]')) metrics.milaSent++;
    } else if (act.type === 'email_open') {
      if (subject.startsWith('[martin]')) metrics.martinOpens++;
      else if (subject.startsWith('[mila]')) metrics.milaOpens++;
    }
  }

  const stageReplied = Number(process.env.PIPEDRIVE_STAGE_REPLIED);
  const stageQualified = Number(process.env.PIPEDRIVE_STAGE_QUALIFIED);
  const stageRdvSet = Number(process.env.PIPEDRIVE_STAGE_RDV_SET);
  for (const stageId of [stageReplied, stageQualified, stageRdvSet]) {
    if (!stageId) continue;
    const deals = await callPipedrive('/deals', { user_id: userId, stage_id: stageId, limit: 100 });
    for (const d of (deals || [])) {
      const updateDate = (d.update_time || '').slice(0, 10);
      if (updateDate === dateISO) {
        if (stageId === stageRdvSet) metrics.rdvSet++;
        else metrics.replies++;
      }
    }
  }
  return metrics;
}

// ─── Agrégation ────────────────────────────────────────────────────────────

function aggregateMetrics(perConsultant) {
  const agg = {
    total_sent: 0,
    martin_sent: 0,
    mila_sent: 0,
    total_opens: 0,
    martin_opens: 0,
    mila_opens: 0,
    replies: 0,
    rdv_set: 0,
  };
  for (const p of perConsultant) {
    agg.martin_sent += p.martinSent || 0;
    agg.mila_sent += p.milaSent || 0;
    agg.martin_opens += p.martinOpens || 0;
    agg.mila_opens += p.milaOpens || 0;
    agg.replies += p.replies || 0;
    agg.rdv_set += p.rdvSet || 0;
  }
  agg.total_sent = agg.martin_sent + agg.mila_sent;
  agg.total_opens = agg.martin_opens + agg.mila_opens;
  return agg;
}

// ─── Narratif synthétique français ─────────────────────────────────────────

function formatMCardinaleLine(mcardinale) {
  if (!mcardinale) return '';
  const m1 = mcardinale.level1 || {};
  const m2 = mcardinale.level2 || {};
  const m1Str = m1.pct == null
    ? `niveau 1 (briefs 7j → ≥1 J0 dans 24h) : n/a (${m1.total || 0} briefs)`
    : `niveau 1 (briefs 7j → ≥1 J0 dans 24h) : ${m1.pct}% (${m1.aboutis}/${m1.total})`;
  const m2Str = m2.pct == null
    ? `niveau 2 (J0 28j → conversion terminale) : n/a (${m2.j0Sent || 0} J0)`
    : `niveau 2 (J0 28j → conversion terminale) : ${m2.pct}% (${m2.dealsQualified}/${m2.j0Sent})`;
  return `M_CARDINALE — ${m1Str} ; ${m2Str}.`;
}

function buildDigestSummary(agg, consultantsActifs, dateISO, mcardinale) {
  const dateFR = formatDateFR(dateISO);
  const noms = consultantsActifs.length === 0
    ? 'aucun consultant actif'
    : consultantsActifs.length === 1
      ? `1 consultant actif (${capitalize(consultantsActifs[0])})`
      : `${consultantsActifs.length} consultants actifs (${consultantsActifs.map(capitalize).join(' et ')})`;

  const mcardLine = formatMCardinaleLine(mcardinale);

  if (agg.total_sent === 0 && agg.replies === 0 && agg.rdv_set === 0) {
    const head = `Le ${dateFR}, aucune activité Prospérenne enregistrée sur ${noms}. Pas d'envoi prospect, pas de réponse, pas de RDV. Pilote en sommeil sur la journée.`;
    return mcardLine ? `${head} ${mcardLine}` : head;
  }

  const parts = [
    `Le ${dateFR}, l'équipe Prospérenne a généré ${agg.total_sent} envoi${agg.total_sent > 1 ? 's' : ''} prospect (${agg.martin_sent} Martin, ${agg.mila_sent} Mila) sur ${noms}.`,
  ];

  if (agg.total_opens > 0) {
    const tauxOuverture = agg.total_sent > 0 ? Math.round((agg.total_opens / agg.total_sent) * 100) : 0;
    parts.push(`${agg.total_opens} ouverture${agg.total_opens > 1 ? 's' : ''} détectée${agg.total_opens > 1 ? 's' : ''} (${agg.martin_opens} Martin, ${agg.mila_opens} Mila), soit un taux d'ouverture indicatif de ${tauxOuverture}%.`);
  }

  const rPart = [];
  if (agg.replies > 0) rPart.push(`${agg.replies} réponse${agg.replies > 1 ? 's' : ''} prospect entrante${agg.replies > 1 ? 's' : ''}`);
  if (agg.rdv_set > 0) rPart.push(`${agg.rdv_set} RDV fixé${agg.rdv_set > 1 ? 's' : ''}`);
  if (rPart.length > 0) parts.push(`${rPart.join(' et ')} sur la journée.`);

  if (mcardLine) parts.push(mcardLine);

  return parts.join(' ');
}

// ─── M_CARDINALE — métrique cardinale pilote (Étape 5.2 plan branchement) ──
//
// Niveau 1 : % briefs reçus sur 7j roulant aboutissant ≥1 J0 dans 24h.
//   - Source : Storage Table leadSelectorJobs (1 entry = 1 brief job posté
//     par dailyLeadSelectorRefresh ou onQualification ou runLeadSelectorForConsultant).
//   - Critère succès : status='done' AND sequenceLaunched=true AND sequenceOk≥1
//     (le job a tourné jusqu au lancement séquence avec ≥1 J0 effectif).
//   - Pct = aboutis / total. Null si total=0 (pas de brief sur la fenêtre).
//
// Niveau 2 : % J0 envoyés sur 28j aboutissant ≥1 conversion terminale.
//   - Convention conversion terminale v1 : deal passé en stage QUALIFIED dans 28j.
//   - Source 1 : Pipedrive activities type IN ('email','appel_de_relance')
//     subject contient 'J0' dans 28j → count J0 envoyés.
//   - Source 2 : Pipedrive deals stage_id=PIPEDRIVE_STAGE_QUALIFIED
//     update_time dans 28j → count deals qualifiés.
//   - Approximation v1 : pct global = dealsQualified28j / J0Sent28j (sans
//     liaison 1-1 stricte deal_id ↔ activity ; à raffiner si besoin observ.).
//   - Null si J0Sent=0.
//
// Seuils plan branchement §3.2 : GO ≥70% / ALERTE <50% / INCIDENT <30%.
// Si 3 jours consécutifs <50% sur niveau 1 OU niveau 2 → mail
// direction@perennereseau.fr (ESCALATION_EMAIL).
//
// Persistence : row dédiée par jour PK=YYYY-MM RK=YYYY-MM-DD_AGG dans
// table dailyMetrics existante (ne perturbe pas les rows _morgane/_johnny).

const M_CARDINALE_ALERT_THRESHOLD_PCT = Number(process.env.M_CARDINALE_ALERT_THRESHOLD_PCT || 50);
const M_CARDINALE_ALERT_CONSECUTIVE_DAYS = Number(process.env.M_CARDINALE_ALERT_CONSECUTIVE_DAYS || 3);
const LEAD_SELECTOR_JOBS_TABLE = process.env.LEAD_SELECTOR_JOBS_TABLE || 'leadSelectorJobs';

async function computeMCardinaleLevel1(jobsTableClient, dateRefIso, windowDays = 7) {
  if (!jobsTableClient) return { pct: null, total: 0, aboutis: 0, reason: 'no_table' };
  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  const startMs = refMs - (windowDays - 1) * 24 * 3600_000;
  const dateStart = new Date(startMs).toISOString().slice(0, 10);
  let total = 0;
  let aboutis = 0;
  try {
    // PartitionKey leadSelectorJobs = YYYY-MM-DD (cf. leadSelectorJobQueue.js
    // markStatus partitionKey = new Date().toISOString().slice(0, 10)).
    const iter = jobsTableClient.listEntities({
      queryOptions: { filter: `PartitionKey ge '${dateStart}' and PartitionKey le '${dateRefIso}'` },
    });
    for await (const e of iter) {
      total++;
      // sequenceLaunched et sequenceOk persistés flattenForTable
      // (cf. leadSelectorJobQueue.js:188 — booléen sérialisé bool, number sérialisé number).
      const sequenceOk = Number(e.sequenceOk) || 0;
      const launched = e.sequenceLaunched === true || e.sequenceLaunched === 'true';
      if (e.status === 'done' && launched && sequenceOk >= 1) aboutis++;
    }
    const pct = total > 0 ? Math.round((aboutis / total) * 1000) / 10 : null;
    return { pct, total, aboutis };
  } catch (err) {
    return { pct: null, total: 0, aboutis: 0, reason: `error:${err && err.message}` };
  }
}

async function computeMCardinaleLevel2(callPipedriveImpl, dateRefIso, windowDays = 28) {
  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  // Window = [refMs - (windowDays-1)j, refMs] inclusif
  const startIso = new Date(refMs - (windowDays - 1) * 24 * 3600_000).toISOString().slice(0, 10);
  let j0Sent = 0;
  let dealsQualified = 0;
  try {
    // Source 1 — J0 sent : activities type='email'|'appel_de_relance', subject 'J0'
    const activities = await callPipedriveImpl('/activities', {
      done: 1,
      start_date: startIso,
      end_date: dateRefIso,
      limit: 500,
    });
    for (const act of (activities || [])) {
      const type = act.type;
      const subject = (act.subject || '').toLowerCase();
      if ((type === 'email' || type === 'appel_de_relance') && subject.includes('j0')) {
        j0Sent++;
      }
    }
    // Source 2 — deals qualifiés : stage_id=QUALIFIED update_time dans window
    const stageQualified = Number(process.env.PIPEDRIVE_STAGE_QUALIFIED);
    if (stageQualified) {
      const deals = await callPipedriveImpl('/deals', { stage_id: stageQualified, limit: 500 });
      for (const d of (deals || [])) {
        const updateDate = (d.update_time || '').slice(0, 10);
        if (updateDate >= startIso && updateDate <= dateRefIso) dealsQualified++;
      }
    }
    const pct = j0Sent > 0 ? Math.round((dealsQualified / j0Sent) * 1000) / 10 : null;
    return { pct, j0Sent, dealsQualified };
  } catch (err) {
    return { pct: null, j0Sent: 0, dealsQualified: 0, reason: `error:${err && err.message}` };
  }
}

async function writeAggregateMetricsToTable(dateISO, mcardinale, tableClient) {
  if (!tableClient) return { ok: false, reason: 'no_table' };
  try {
    await tableClient.upsertEntity({
      partitionKey: dateISO.slice(0, 7),
      rowKey: `${dateISO}_AGG`,
      date: dateISO,
      type: 'aggregate',
      // Sentinelle -1 pour pct null (Azure Table évite stocker null explicite).
      m_cardinale_1_pct: mcardinale.level1.pct == null ? -1 : mcardinale.level1.pct,
      m_cardinale_1_total: mcardinale.level1.total,
      m_cardinale_1_aboutis: mcardinale.level1.aboutis,
      m_cardinale_2_pct: mcardinale.level2.pct == null ? -1 : mcardinale.level2.pct,
      m_cardinale_2_j0_sent: mcardinale.level2.j0Sent,
      m_cardinale_2_deals_qualified: mcardinale.level2.dealsQualified,
      created_at: new Date().toISOString(),
    }, 'Replace');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function checkAndSendCardinalAlert({
  tableClient, sendMailImpl, fromEmail, todayMCardinale, dateRefIso, log,
}) {
  if (!tableClient || !sendMailImpl) return { sent: false, reason: 'no_deps' };

  const refMs = Date.parse(`${dateRefIso}T00:00:00Z`);
  const threeDaysAgoIso = new Date(refMs - (M_CARDINALE_ALERT_CONSECUTIVE_DAYS - 1) * 24 * 3600_000).toISOString().slice(0, 10);
  const monthsToScan = new Set([dateRefIso.slice(0, 7), threeDaysAgoIso.slice(0, 7)]);

  const recentByDate = new Map();
  // Inclure today's compute en mémoire pour évaluer la fenêtre incluse aujourd'hui
  recentByDate.set(dateRefIso, {
    m1: todayMCardinale.level1.pct,
    m2: todayMCardinale.level2.pct,
  });

  for (const month of monthsToScan) {
    try {
      const iter = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${month}' and type eq 'aggregate'` },
      });
      for await (const e of iter) {
        if (!e.date) continue;
        const eDate = String(e.date);
        if (eDate < threeDaysAgoIso || eDate >= dateRefIso) continue; // aujourd'hui déjà en map
        const m1 = e.m_cardinale_1_pct;
        const m2 = e.m_cardinale_2_pct;
        recentByDate.set(eDate, {
          m1: m1 == null || m1 === -1 ? null : Number(m1),
          m2: m2 == null || m2 === -1 ? null : Number(m2),
        });
      }
    } catch (err) {
      log.warn(`[dailyDigest] M_CARDINALE lecture historique échec mois ${month} : ${err && err.message}`);
    }
  }

  const sortedDates = [...recentByDate.keys()].sort().reverse().slice(0, M_CARDINALE_ALERT_CONSECUTIVE_DAYS);
  if (sortedDates.length < M_CARDINALE_ALERT_CONSECUTIVE_DAYS) {
    return { sent: false, reason: 'historique_insuffisant', daysObserved: sortedDates.length };
  }

  const below_m1 = sortedDates.every((d) => {
    const v = recentByDate.get(d).m1;
    return v != null && v < M_CARDINALE_ALERT_THRESHOLD_PCT;
  });
  const below_m2 = sortedDates.every((d) => {
    const v = recentByDate.get(d).m2;
    return v != null && v < M_CARDINALE_ALERT_THRESHOLD_PCT;
  });

  if (!below_m1 && !below_m2) return { sent: false, reason: 'seuils_ok' };

  const which = [
    below_m1 && 'M_CARDINALE niveau 1 (briefs aboutissant ≥1 J0 dans 24h)',
    below_m2 && 'M_CARDINALE niveau 2 (J0 aboutissant ≥1 conversion terminale dans 28j)',
  ].filter(Boolean).join(' + ');

  const html = `<p>Bonjour,</p>
<p>Alerte automatique pilote David : <strong>${which}</strong> sous le seuil ${M_CARDINALE_ALERT_THRESHOLD_PCT}% sur ${M_CARDINALE_ALERT_CONSECUTIVE_DAYS} jours consécutifs.</p>
<p>Détail par jour (du plus récent au plus ancien) :</p>
<ul>
${sortedDates.map((d) => `<li>${d} : niveau 1 = ${recentByDate.get(d).m1 == null ? 'n/a' : recentByDate.get(d).m1 + '%'}, niveau 2 = ${recentByDate.get(d).m2 == null ? 'n/a' : recentByDate.get(d).m2 + '%'}</li>`).join('\n')}
</ul>
<p>Référence plan branchement §3.2 critères cardinaux. Garde-fou 14/06/2026 si situation persiste.</p>
<p>Sources data : Storage Table dailyMetrics (PK=mois, RK=DATE_AGG) + leadSelectorJobs + Pipedrive activities/deals.</p>
<p>David</p>`;

  const to = process.env.ESCALATION_EMAIL || 'direction@perennereseau.fr';
  try {
    await sendMailImpl({
      from: fromEmail,
      to,
      subject: `[ALERTE pilote David] M_CARDINALE < ${M_CARDINALE_ALERT_THRESHOLD_PCT}% sur ${M_CARDINALE_ALERT_CONSECUTIVE_DAYS}j consécutifs`,
      html,
    });
    log(`[dailyDigest] M_CARDINALE alerte envoyée à ${to} (below_m1=${below_m1}, below_m2=${below_m2})`);
    return { sent: true, to, below_m1, below_m2, days: sortedDates };
  } catch (err) {
    log.warn(`[dailyDigest] M_CARDINALE alerte sendMail échec : ${err && err.message}`);
    return { sent: false, error: err && err.message };
  }
}

// ─── Persistence Azure Storage Table dailyMetrics ──────────────────────────

/**
 * Persiste les métriques par consultant dans Azure Storage Table `dailyMetrics`.
 * PartitionKey = YYYY-MM (mois), RowKey = YYYY-MM-DD_<consultant>.
 * Mode 'Replace' = idempotent (re-run même date écrase proprement).
 *
 * Fail-open par ligne : si un upsert lève (réseau, throttling, RBAC),
 * log warn et passe au consultant suivant. Le caller continue (étape 3).
 */
async function writeDailyMetricsToTable(perConsultant, dateISO, ctx, tableClient) {
  const log = (ctx && typeof ctx.warn === 'function')
    ? ctx.warn.bind(ctx)
    : console.warn.bind(console);
  if (!perConsultant || perConsultant.length === 0) {
    return { ok: true, written: 0 };
  }
  let written = 0;
  for (const row of perConsultant) {
    try {
      await tableClient.upsertEntity({
        partitionKey: dateISO.slice(0, 7),
        rowKey: `${dateISO}_${row.consultant}`,
        date: dateISO,
        agent: 'david',
        consultant: row.consultant,
        martin_sent: row.martinSent || 0,
        mila_sent: row.milaSent || 0,
        total_opens: (row.martinOpens || 0) + (row.milaOpens || 0),
        martin_opens: row.martinOpens || 0,
        mila_opens: row.milaOpens || 0,
        replies: row.replies || 0,
        rdv_set: row.rdvSet || 0,
        created_at: new Date().toISOString(),
      }, 'Replace');
      written++;
    } catch (err) {
      log(`[dailyDigest] writeDailyMetricsToTable failed for ${row.consultant}: ${err.message}`);
    }
  }
  return { ok: written === perConsultant.length, written };
}

// ─── Default deps (real impls) ─────────────────────────────────────────────

function defaultConsultants() {
  return [
    { email: process.env.MORGANE_EMAIL, prenom: 'morgane' },
    { email: process.env.JOHNNY_EMAIL, prenom: 'johnny' },
  ].filter((c) => c.email);
}

function getDefaultTableClient() {
  return TableClient.fromConnectionString(
    process.env.LEADBASE_STORAGE_CONNECTION_STRING,
    'dailyMetrics',
  );
}

function getDefaultJobsTableClient() {
  // leadSelectorJobs vit sur AzureWebJobsStorage (cf. leadSelectorJobQueue.js
  // getJobsTable). Indépendant de LEADBASE_STORAGE_CONNECTION_STRING.
  const cs = process.env.AzureWebJobsStorage;
  if (!cs) return null;
  try {
    return TableClient.fromConnectionString(cs, LEAD_SELECTOR_JOBS_TABLE);
  } catch {
    return null;
  }
}

function defaultDeps() {
  const metricsTable = getDefaultTableClient();
  const jobsTable = getDefaultJobsTableClient();
  return {
    consultants: defaultConsultants(),
    findPipedriveUserId,
    fetchConsultantMetrics,
    writeDailyMetricsToTable: (per, date, ctx) => writeDailyMetricsToTable(per, date, ctx, metricsTable),
    reportToCharli,
    // M_CARDINALE deps (Étape 5.2)
    jobsTableClient: jobsTable,
    metricsTableClient: metricsTable,
    callPipedrive,
    sendMail: require('../../shared/graph-mail').sendMail,
    fromEmail: process.env.DAVID_EMAIL,
    computeMCardinaleLevel1,
    computeMCardinaleLevel2,
    writeAggregateMetricsToTable,
    checkAndSendCardinalAlert,
  };
}

// ─── Handler core (testable) ───────────────────────────────────────────────

async function handleDailyDigest(myTimer, context, deps = defaultDeps()) {
  const log = makeSafeLogger(context);

  // Flag d'activation pilote (cf. décision Paul 1er mai 2026 PM) : le
  // dailyDigest vers Charli ne doit tourner qu'une fois la prospection
  // réellement démarrée. Sinon génère 'rien fait aujourd'hui' qui pollue
  // la mémoire continue Charli (user_id=charli).
  if (process.env.DAILY_REPORT_ENABLED !== '1') {
    log('[dailyDigest] skipped (DAILY_REPORT_ENABLED != 1) — pilote pas encore démarré');
    return;
  }

  const yesterday = getYesterdayParisISO();
  log(`dailyDigest tick for ${yesterday}`);

  const consultants = deps.consultants || [];

  // 1. Collecte metrics par consultant — fail-open par consultant
  const perConsultant = [];
  for (const c of consultants) {
    try {
      const userId = await deps.findPipedriveUserId(c.email);
      if (!userId) {
        log.warn(`[dailyDigest] user Pipedrive non trouvé pour ${c.email}, skip`);
        continue;
      }
      const m = await deps.fetchConsultantMetrics(userId, yesterday);
      perConsultant.push({ consultant: c.prenom, ...m });
    } catch (err) {
      log.warn(`[dailyDigest] metrics partial fail pour ${c.prenom}: ${err.message}`);
    }
  }

  // 2. Write Table dailyMetrics — fail-open, log + continue
  let writeRes;
  try {
    writeRes = await deps.writeDailyMetricsToTable(perConsultant, yesterday, context);
  } catch (err) {
    log.warn(`[dailyDigest] writeDailyMetricsToTable threw: ${err.message}, continuing to reportToCharli`);
    writeRes = { ok: false, written: 0 };
  }
  if (!writeRes.ok) {
    log.warn(`[dailyDigest] write Table dégradé (${writeRes.written}/${perConsultant.length}), reportToCharli quand même appelé`);
  } else {
    log(`[dailyDigest] Table dailyMetrics écrite (${writeRes.written}/${perConsultant.length} entrées)`);
  }

  // 3. M_CARDINALE — calcul 2 niveaux + persistence + alerte (Étape 5.2)
  let mcardinale = {
    level1: { pct: null, total: 0, aboutis: 0 },
    level2: { pct: null, j0Sent: 0, dealsQualified: 0 },
  };
  try {
    mcardinale.level1 = await (deps.computeMCardinaleLevel1 || computeMCardinaleLevel1)(
      deps.jobsTableClient,
      yesterday,
    );
    mcardinale.level2 = await (deps.computeMCardinaleLevel2 || computeMCardinaleLevel2)(
      deps.callPipedrive || callPipedrive,
      yesterday,
    );
    log(`[dailyDigest] M_CARDINALE niveau 1 = ${mcardinale.level1.pct}% (${mcardinale.level1.aboutis}/${mcardinale.level1.total}), niveau 2 = ${mcardinale.level2.pct}% (${mcardinale.level2.dealsQualified}/${mcardinale.level2.j0Sent})`);
  } catch (err) {
    log.warn(`[dailyDigest] M_CARDINALE compute échec : ${err && err.message}`);
  }

  // Persistence row aggregate (best effort)
  try {
    const writeRes = await (deps.writeAggregateMetricsToTable || writeAggregateMetricsToTable)(
      yesterday,
      mcardinale,
      deps.metricsTableClient || getDefaultTableClient(),
    );
    if (!writeRes.ok) {
      log.warn(`[dailyDigest] writeAggregateMetricsToTable dégradé : ${writeRes.reason || writeRes.error}`);
    }
  } catch (err) {
    log.warn(`[dailyDigest] writeAggregateMetricsToTable échec : ${err && err.message}`);
  }

  // Alerte 3 jours consécutifs si l'un des 2 niveaux est sous seuil (best effort)
  try {
    const alertRes = await (deps.checkAndSendCardinalAlert || checkAndSendCardinalAlert)({
      tableClient: deps.metricsTableClient || getDefaultTableClient(),
      sendMailImpl: deps.sendMail,
      fromEmail: deps.fromEmail || process.env.DAVID_EMAIL,
      todayMCardinale: mcardinale,
      dateRefIso: yesterday,
      log,
    });
    if (alertRes.sent) {
      log(`[dailyDigest] M_CARDINALE alerte envoyée (below_m1=${alertRes.below_m1}, below_m2=${alertRes.below_m2})`);
    }
  } catch (err) {
    log.warn(`[dailyDigest] checkAndSendCardinalAlert échec : ${err && err.message}`);
  }

  // 4. reportToCharli — fail-open, log seul
  const agg = aggregateMetrics(perConsultant);
  const consultantsActifs = perConsultant.map((p) => p.consultant);
  const summary = buildDigestSummary(agg, consultantsActifs, yesterday, mcardinale);

  const event = {
    agent: 'david',
    eventType: 'daily_digest',
    summary,
    metadata: {
      date: yesterday,
      source: 'david-pipeline',
      agent: 'david',
      event_type: 'daily_digest',
      metrics: agg,
      m_cardinale: {
        level1: mcardinale.level1,
        level2: mcardinale.level2,
      },
      per_consultant: perConsultant.map((p) => ({
        consultant: p.consultant,
        martin_sent: p.martinSent || 0,
        mila_sent: p.milaSent || 0,
        martin_opens: p.martinOpens || 0,
        mila_opens: p.milaOpens || 0,
        replies: p.replies || 0,
        rdv_set: p.rdvSet || 0,
      })),
      consultants_actifs: consultantsActifs,
    },
  };

  const reportRes = await deps.reportToCharli(event, context);
  if (!reportRes || !reportRes.ok) {
    log.warn(`[dailyDigest] reportToCharli failed: ${reportRes && reportRes.error}`);
  } else {
    log(`[dailyDigest] digest posté event_id=${reportRes.eventId}`);
  }
}

// ─── Timer trigger ─────────────────────────────────────────────────────────
app.timer('dailyDigest', {
  schedule: '0 0 0 * * *', // 00h00 Paris (TZ=Europe/Paris)
  handler: async (myTimer, context) => handleDailyDigest(myTimer, context),
});

module.exports = {
  handleDailyDigest,
  aggregateMetrics,
  buildDigestSummary,
  writeDailyMetricsToTable,
  // M_CARDINALE (Étape 5.2 plan branchement)
  computeMCardinaleLevel1,
  computeMCardinaleLevel2,
  writeAggregateMetricsToTable,
  checkAndSendCardinalAlert,
  formatMCardinaleLine,
  // Helpers exposés pour tests / introspection
  getYesterdayParisISO,
  formatDateFR,
};
