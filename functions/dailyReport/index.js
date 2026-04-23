/**
 * Timer trigger — 8h Paris, du lundi au vendredi.
 *
 * Pour chaque consultant actif, David envoie un mail récap de l'activité
 * Prospérenne de la veille : envois par agent (Martin/Mila), ouvertures
 * détectées, réponses reçues, RDV fixés. Un résumé narratif + 1-2
 * propositions d'actions du jour sont générés par Claude.
 *
 * Heure locale Paris : garantie par l'app setting `WEBSITE_TIME_ZONE=Romance
 * Standard Time` sur le Function App.
 *
 * Consultants pilotes (MVP) : Morgane et Johnny, hardcodés via env vars
 * MORGANE_EMAIL / JOHNNY_EMAIL. Quand la liste grandira, on stockera les
 * consultants actifs dans Pipedrive (custom user field `is_prosperenne`) ou
 * dans un endpoint dédié.
 *
 * Règle d'honneur respectée dans le prompt LLM : aucun chiffre en dehors
 * des métriques factuelles calculées.
 */

const { app } = require('@azure/functions');
const { sendMail } = require('../../shared/graph-mail');
const { callClaude } = require('../../shared/anthropic');
const { davidSignatureHtml } = require('../../shared/templates');
const { parisDateParts } = require('../../shared/holidays');
const { readEventsSince, summarizeEventsHtml } = require('../../shared/leadSelectorTrace');

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

// ─── Pipedrive minimaliste (inline) ────────────────────────────────────────
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

/**
 * Compte les envois (type email) par agent, les ouvertures (type email_open)
 * par agent, les réponses (stage REPLIED/QUALIFIED) et RDV fixés (stage
 * RDV_SET) pour un consultant sur une date donnée.
 *
 * Les subjects des activités sont préfixés `[martin]` / `[mila]` par le
 * worker (cf. shared/pipedrive.js logEmailSent), on les distingue ainsi.
 */
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
    if (act.type === 'email') {
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

async function generateSummary(consultant, metrics, dateISO) {
  const prompt = `Tu es David, responsable commercial OSEYS. Tu écris à ${consultant.prenom} son rapport quotidien Prospérenne pour le ${formatDateFR(dateISO)}.

Métriques de la veille (${formatDateFR(dateISO)}) :
- Martin : ${metrics.martinSent} envois · ${metrics.martinOpens} ouvertures détectées
- Mila : ${metrics.milaSent} envois · ${metrics.milaOpens} ouvertures détectées
- Réponses reçues : ${metrics.replies}
- RDV fixés : ${metrics.rdvSet}

RÈGLE D'HONNEUR (non négociable) :
- Aucun chiffre inventé. Travaille uniquement avec les chiffres ci-dessus.
- Pas de promesse ni de prédiction.
- Si tout est à zéro, le dis simplement sans dramatiser.

Ton : posé, pragmatique, tutoiement (culture OSEYS).
Format : 2-4 paragraphes courts, HTML minimal (<p>, <strong>, <em> uniquement).
Structure :
1. Résumé narratif de la journée (2-3 phrases factuelles)
2. Si pertinent : analyse comparative Martin vs Mila
3. 1-2 propositions d'actions concrètes pour aujourd'hui

Pas de formule bateau ("voici ton rapport"). Commence directement par la substance.
Pas de signature en bas (ajoutée automatiquement).`;

  const { text } = await callClaude({
    system: 'Tu es David, responsable commercial OSEYS. Tu écris en français, ton posé et direct.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    temperature: 0.5,
  });
  return text.trim();
}

// ─── Timer trigger ─────────────────────────────────────────────────────────
app.timer('dailyReport', {
  schedule: '0 0 8 * * 1-5', // 8h00 Paris (via WEBSITE_TIME_ZONE), lun-ven
  handler: async (myTimer, context) => {
    const yesterday = getYesterdayParisISO();
    context.log(`dailyReport tick for ${yesterday}`);

    const consultants = [
      { email: process.env.MORGANE_EMAIL, prenom: 'Morgane' },
      { email: process.env.JOHNNY_EMAIL, prenom: 'Johnny' },
    ].filter((c) => c.email);

    if (consultants.length === 0) {
      context.warn('dailyReport: aucun consultant configuré (MORGANE_EMAIL / JOHNNY_EMAIL absents)');
      return;
    }

    for (const consultant of consultants) {
      try {
        const userId = await findPipedriveUserId(consultant.email);
        if (!userId) {
          context.warn(`dailyReport: user Pipedrive non trouvé pour ${consultant.email}, skip`);
          continue;
        }

        const metrics = await fetchConsultantMetrics(userId, yesterday);
        const summary = await generateSummary(consultant, metrics, yesterday);
        const html = `<div style="font-family:Arial,sans-serif;color:#1a1714">${summary}${davidSignatureHtml()}</div>`;

        await sendMail({
          from: process.env.DAVID_EMAIL,
          to: consultant.email,
          subject: `Ton point quotidien Prospérenne — ${formatDateFR(yesterday)}`,
          html,
        });
        context.log(`dailyReport sent to ${consultant.email} — metrics: ${JSON.stringify(metrics)}`);
      } catch (err) {
        context.error(`dailyReport failed for ${consultant.email}: ${err.message}`);
      }
    }

    // Section Lead Selector — mail séparé envoyé à direction (escalation),
    // pas aux consultants. Best effort : si la table trace n'existe pas
    // ou est vide, on n'envoie rien.
    try {
      await sendLeadSelectorReport(yesterday, context);
    } catch (err) {
      context.error(`dailyReport leadSelector section failed: ${err.message}`);
    }
  },
});

async function sendLeadSelectorReport(yesterday, context) {
  const events = await readEventsSince(yesterday);
  if (!events || events.length === 0) {
    context.log('[dailyReport] no Lead Selector events for the past 24h');
    return;
  }
  const html = summarizeEventsHtml(events, { dateLabel: formatDateFR(yesterday) });
  if (!html) return;
  const to = process.env.ESCALATION_EMAIL || process.env.ADMIN_EMAIL;
  if (!to) {
    context.warn('[dailyReport] no ESCALATION_EMAIL/ADMIN_EMAIL configured, skipping Lead Selector report');
    return;
  }
  await sendMail({
    from: process.env.DAVID_EMAIL,
    to,
    subject: `Lead Selector — rapport ${formatDateFR(yesterday)}`,
    html: `<div style="font-family:Arial,sans-serif;color:#1a1714"><p>Bonjour,</p><p>Synthèse des exécutions Lead Selector des dernières 24h.</p>${html}${davidSignatureHtml()}</div>`,
  });
  context.log(`[dailyReport] Lead Selector report sent to ${to} (${events.length} events)`);
}
