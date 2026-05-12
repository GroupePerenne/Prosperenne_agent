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

// Types d'activités Pipedrive considérés comme un "envoi Martin/Mila".
// En prod, les activités créées par shared/pipedrive.js logEmailSent (type:'email')
// sont remappées par Pipedrive en `appel_de_relance` côté tenant OSEYS — donc
// on accepte les deux. Idem côté ouvertures (`email_open`) si jamais Pipedrive
// les remappe aussi un jour.
const SENT_ACTIVITY_TYPES = new Set(['email', 'appel_de_relance']);
const OPEN_ACTIVITY_TYPES = new Set(['email_open']);

/**
 * Charge l'index des deals du pipeline cible (Prosperene — Prospection automatisée)
 * pour pouvoir, pour chaque activité, retrouver le titre + pipeline du deal
 * rattaché sans faire un GET /deals/{id} par activité (ce qui exploserait le
 * quota API Pipedrive).
 *
 * On itère via `start` + `limit=500` pour récupérer la totalité du pipeline.
 * Le pipeline 28 contient typiquement < 5000 deals (cible pilote).
 *
 * @param {number} pipelineId
 * @param {Function} [pipedriveCall] - injectable pour tests (défaut: callPipedrive)
 * @returns {Promise<Map<number, {title: string, pipeline_id: number}>>}
 */
async function loadPipelineDealsIndex(pipelineId, pipedriveCall = callPipedrive) {
  const index = new Map();
  if (!pipelineId) return index;
  let start = 0;
  const limit = 500;
  // Garde-fou anti-boucle infinie (max 20 pages = 10 000 deals)
  for (let page = 0; page < 20; page++) {
    const deals = await pipedriveCall('/deals', {
      pipeline_id: pipelineId,
      status: 'all_not_deleted',
      limit,
      start,
    });
    const arr = Array.isArray(deals) ? deals : [];
    for (const d of arr) {
      if (d && d.id) {
        index.set(Number(d.id), {
          title: d.title || '',
          pipeline_id: d.pipeline_id,
        });
      }
    }
    if (arr.length < limit) break;
    start += limit;
  }
  return index;
}

/**
 * Compte les envois Martin/Mila d'une journée pour un consultant donné.
 *
 * Diagnostic 12 mai 2026 (récap COMEX aveugle sur 46 envois réels) :
 *   - Les activités Pipedrive sont créées sous owner = David (30884421), pas
 *     sous le user_id du consultant → filtrer par user_id consultant = 0 hit
 *   - Le `type` réel des activités côté tenant OSEYS est `appel_de_relance`
 *     (remap Pipedrive du type:'email' source), pas `email`
 *   - L'attribution au consultant se fait par le TITRE du deal rattaché :
 *     pattern "Morgane DE JESSEY → SOCIETE ..." ou "Johnny SERRA → ENTREPRISE ..."
 *   - Tous les deals pilote sont dans le pipeline PIPEDRIVE_PIPELINE_ID (=28)
 *
 * Stratégie :
 *   1. Charger l'index pipeline → {dealId: {title, pipeline_id}} (1 requête paginée)
 *   2. Récupérer TOUTES les activités du jour, type=appel_de_relance OU email
 *   3. Pour chaque activité, lookup deal dans l'index, vérifier pipeline match,
 *      puis matcher le titre vs `consultantFullName` (case-insensitive)
 *   4. Compter par préfixe subject [martin] / [mila]
 *
 * Pour les replies/rdvSet : on relit les deals du pipeline (déjà en mémoire
 * via l'index est insuffisant — il manque stage_id et update_time, donc on
 * refait 2-3 requêtes ciblées par stage_id, mais sans filtre user_id).
 *
 * @param {string} consultantFullName - Nom complet matché dans le titre du deal
 *   (ex: "Morgane DE JESSEY", "Johnny SERRA"). Comparaison toLowerCase().
 * @param {string} dateISO - YYYY-MM-DD (fenêtre journalière)
 * @param {Object} [opts]
 * @param {number} [opts.pipelineId] - Override pipeline (défaut: env PIPEDRIVE_PIPELINE_ID)
 * @param {Function} [opts.pipedriveCall] - injectable pour tests (défaut: callPipedrive)
 * @returns {Promise<{martinSent, milaSent, martinOpens, milaOpens, replies, rdvSet}>}
 */
async function fetchConsultantMetrics(consultantFullName, dateISO, opts = {}) {
  const metrics = { martinSent: 0, milaSent: 0, martinOpens: 0, milaOpens: 0, replies: 0, rdvSet: 0 };

  const pipelineId = Number(opts.pipelineId || process.env.PIPEDRIVE_PIPELINE_ID);
  if (!pipelineId) {
    // Sans pipeline, on ne sait pas borner — on retourne zéro plutôt que de
    // remonter des chiffres faussement gonflés sur tous pipelines confondus.
    return metrics;
  }
  if (!consultantFullName || typeof consultantFullName !== 'string') {
    return metrics;
  }
  const consultantLower = consultantFullName.toLowerCase();
  const pipedriveCall = opts.pipedriveCall || callPipedrive;

  // 1. Index deals du pipeline (id → {title, pipeline_id})
  const dealsIndex = await loadPipelineDealsIndex(pipelineId, pipedriveCall);

  // 2. Activités de la journée — pas de filtre user_id (les activités sont
  //    sous owner David). Pas de filtre type côté API (mono-type), on filtre
  //    côté code.
  const activities = await pipedriveCall('/activities', {
    done: 1,
    start_date: dateISO,
    end_date: dateISO,
    limit: 500,
  });
  for (const act of (activities || [])) {
    if (!act || !act.deal_id) continue;
    const isSent = SENT_ACTIVITY_TYPES.has(act.type);
    const isOpen = OPEN_ACTIVITY_TYPES.has(act.type);
    if (!isSent && !isOpen) continue;

    const deal = dealsIndex.get(Number(act.deal_id));
    if (!deal) continue; // deal hors pipeline pilote → ignore
    if (Number(deal.pipeline_id) !== pipelineId) continue;

    const title = String(deal.title || '').toLowerCase();
    if (!title.includes(consultantLower)) continue;

    const subject = (act.subject || '').toLowerCase();
    if (isSent) {
      if (subject.startsWith('[martin]')) metrics.martinSent++;
      else if (subject.startsWith('[mila]')) metrics.milaSent++;
    } else if (isOpen) {
      if (subject.startsWith('[martin]')) metrics.martinOpens++;
      else if (subject.startsWith('[mila]')) metrics.milaOpens++;
    }
  }

  // 3. Replies & RDV : on scanne par stage_id sur le pipeline pilote (sans
  //    filtre user_id consultant — les deals ont aussi owner David), puis on
  //    matche par titre de deal.
  const stageReplied = Number(process.env.PIPEDRIVE_STAGE_REPLIED);
  const stageQualified = Number(process.env.PIPEDRIVE_STAGE_QUALIFIED);
  const stageRdvSet = Number(process.env.PIPEDRIVE_STAGE_RDV_SET);
  for (const stageId of [stageReplied, stageQualified, stageRdvSet]) {
    if (!stageId) continue;
    const deals = await pipedriveCall('/deals', { stage_id: stageId, limit: 500 });
    for (const d of (deals || [])) {
      if (!d) continue;
      if (Number(d.pipeline_id) !== pipelineId) continue;
      const title = String(d.title || '').toLowerCase();
      if (!title.includes(consultantLower)) continue;
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

function buildDigestSummary(agg, consultantsActifs, dateISO) {
  const dateFR = formatDateFR(dateISO);
  const noms = consultantsActifs.length === 0
    ? 'aucun consultant actif'
    : consultantsActifs.length === 1
      ? `1 consultant actif (${capitalize(consultantsActifs[0])})`
      : `${consultantsActifs.length} consultants actifs (${consultantsActifs.map(capitalize).join(' et ')})`;

  if (agg.total_sent === 0 && agg.replies === 0 && agg.rdv_set === 0) {
    return `Le ${dateFR}, aucune activité Prospérenne enregistrée sur ${noms}. Pas d'envoi prospect, pas de réponse, pas de RDV. Pilote en sommeil sur la journée.`;
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

  return parts.join(' ');
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

// Mapping prénom court → nom complet utilisé pour matcher le titre du deal
// Pipedrive (pattern "Morgane DE JESSEY → SOCIETE ..." créé par worker.js).
// Hardcoded ici parce que monoclient OSEYS en pilote ; à externaliser via env
// (MORGANE_FULL_NAME, JOHNNY_FULL_NAME, ELIE_FULL_NAME) ou table tenants au
// passage multi-tenancy Tranche 8 (cf. CLAUDE.md §1.1).
const CONSULTANT_FULL_NAMES = {
  morgane: process.env.MORGANE_FULL_NAME || 'Morgane DE JESSEY',
  johnny: process.env.JOHNNY_FULL_NAME || 'Johnny SERRA',
  elie: process.env.ELIE_FULL_NAME || 'Elie',
};

function defaultConsultants() {
  return [
    { email: process.env.MORGANE_EMAIL, prenom: 'morgane', fullName: CONSULTANT_FULL_NAMES.morgane },
    { email: process.env.JOHNNY_EMAIL, prenom: 'johnny', fullName: CONSULTANT_FULL_NAMES.johnny },
    { email: process.env.ELIE_EMAIL, prenom: 'elie', fullName: CONSULTANT_FULL_NAMES.elie },
  ].filter((c) => c.email);
}

function getDefaultTableClient() {
  return TableClient.fromConnectionString(
    process.env.LEADBASE_STORAGE_CONNECTION_STRING,
    'dailyMetrics',
  );
}

function defaultDeps() {
  return {
    consultants: defaultConsultants(),
    findPipedriveUserId,
    fetchConsultantMetrics,
    writeDailyMetricsToTable: (per, date, ctx) => writeDailyMetricsToTable(per, date, ctx, getDefaultTableClient()),
    reportToCharli,
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
  //
  // Diagnostic 12 mai 2026 : la signature historique `(userId, dateISO)`
  // était basée sur l'hypothèse fausse que les activités/deals Pipedrive
  // étaient sous user_id consultant. En réalité, owner = David (30884421)
  // pour TOUS les deals/activités du pilote — l'attribution au consultant
  // se fait par parsing du TITRE du deal ("Morgane DE JESSEY → SOCIETE ...").
  // Nouvelle signature : `(consultantFullName, dateISO)`. Le userId
  // Pipedrive du consultant est conservé en sanity-check (skip si absent)
  // mais n'est plus passé à fetchConsultantMetrics.
  const perConsultant = [];
  for (const c of consultants) {
    try {
      const userId = await deps.findPipedriveUserId(c.email);
      if (!userId) {
        log.warn(`[dailyDigest] user Pipedrive non trouvé pour ${c.email}, skip`);
        continue;
      }
      const fullName = c.fullName || CONSULTANT_FULL_NAMES[c.prenom] || c.prenom;
      const m = await deps.fetchConsultantMetrics(fullName, yesterday);
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

  // 3. reportToCharli — fail-open, log seul
  const agg = aggregateMetrics(perConsultant);
  const consultantsActifs = perConsultant.map((p) => p.consultant);
  const summary = buildDigestSummary(agg, consultantsActifs, yesterday);

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
  // Helpers exposés pour tests / introspection
  getYesterdayParisISO,
  formatDateFR,
  fetchConsultantMetrics,
  loadPipelineDealsIndex,
};
