'use strict';

/**
 * Timer trigger nightlySmokeE2E — smoke E2E quotidien P-R4 (doctrine Richard).
 *
 * Tourne tous les jours ouvrés à 5h UTC (7h Paris CEST en mai → octobre,
 * 6h Paris CET en hiver). Lance un run réel `enrichBatchForConsultant` sur
 * briefs Morgane + Johnny avec destinataire technique paul.rudler@perennereseau.fr
 * et envoie un rapport HTML quotidien.
 *
 * Différence avec nightlyMonteCarloSmoke : celui-ci teste la cascade COMPLÈTE
 * (selectCandidates + leadExhauster + Dropcontact réel) jusqu'aux leads
 * enrichis. nightlyMonteCarloSmoke ne teste que selectCandidates.
 *
 * Né du verdict Richard 18 mai 2026 (audit cascade 0/6 BTP TPE 92) :
 *   « Le fix briefId de ce matin était nécessaire mais pas suffisant. Sans
 *    smoke E2E quotidien, on rejoue les 4 jours mortes du 14-18 mai. »
 *
 * Alerte : si returned == 0 sur les 2 briefs un jour donné → entrée dans le
 * mail récap quotidien avec subject [ALERTE]. Si returned == 0 sur 3 jours
 * consécutifs → alerte direction@perennereseau.fr explicite (incident).
 *
 * Coût Dropcontact : ~5 candidats × 2 briefs × 22j ouvrés = ~220 calls/mois
 * sur plan 1500. Aligné cap DROPCONTACT_MONTHLY_BUDGET_CENTS=150000.
 */

const { app } = require('@azure/functions');
const { enrichBatchForConsultant } = require('../../shared/lead-exhauster/enrichBatch');
const { sendMail } = require('../../shared/graph-mail');
const { TableClient } = require('@azure/data-tables');
const { makeSafeLogger } = require('../../shared/safe-log');

const TABLE_NAME = process.env.SMOKE_E2E_RUNS_TABLE || 'SmokeE2ERuns';
const ALERT_EMAIL = process.env.SMOKE_E2E_ALERT_EMAIL || 'direction@perennereseau.fr';
const RECAP_EMAIL = process.env.SMOKE_E2E_RECAP_EMAIL || 'paul.rudler@perennereseau.fr';
const FROM_EMAIL = process.env.DAVID_EMAIL || 'david@perennereseau.fr';
const CONSECUTIVE_FAIL_THRESHOLD = Number(process.env.SMOKE_E2E_FAIL_THRESHOLD || 3);

// Briefs des 2 consultants pilote Pérenne au 18 mai 2026. Hardcoded ici pour
// que le smoke E2E reste autonome de Mem0 / formulaire. À mettre à jour si
// brief consultant évolue.
const BRIEF_TEMPLATES = [
  {
    name: 'smoke_morgane',
    description: 'Smoke Morgane DE JESSEY — BTP TPE sweet spot 92',
    brief: {
      nom: 'Smoke Morgane',
      email: 'm.dejessey@perennereseau.fr',
      secteurs: 'plomberie,electricite,menuiserie,maintenance',
      effectif: '5-9,10-19',
      zone: 'default',
      zone_rayon: 15,
      ville: 'Boulogne-Billancourt',
      adresse: '92100 Boulogne-Billancourt',
      prospecteur: 'mila',
      offre: 'rdv-cale',
    },
    expected: { minLeadsResolved: 1 },
  },
  {
    name: 'smoke_johnny',
    description: 'Smoke Johnny SERRA — BTP TPE 92 Hauts-de-Seine',
    brief: {
      nom: 'Smoke Johnny',
      email: 'j.serra@perennereseau.fr',
      secteurs: 'plomberie,electricite,maintenance,securite',
      effectif: '5-9,10-19',
      zone: 'default',
      zone_rayon: 20,
      ville: 'Nanterre',
      adresse: '92000 Nanterre',
      prospecteur: 'martin',
      offre: 'lead',
    },
    expected: { minLeadsResolved: 1 },
  },
];

// Cron 5h UTC L-V = 7h Paris CEST (mai-oct) / 6h Paris CET (nov-avr).
// Linux Consumption ignore WEBSITE_TIME_ZONE → UTC pur (cf. CLAUDE.md §3).
app.timer('nightlySmokeE2E', {
  schedule: process.env.SMOKE_E2E_CRON || '0 0 5 * * 1-5',
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    log('[smoke-e2e] starting');
    const startedAt = new Date();
    const runId = `smoke-${startedAt.toISOString().replace(/[:.]/g, '-')}`;

    const results = [];
    for (const tpl of BRIEF_TEMPLATES) {
      const tStart = Date.now();
      let result;
      try {
        result = await enrichBatchForConsultant({
          brief: tpl.brief,
          beneficiaryId: 'smoke-e2e@perennereseau.fr',
          batchSize: 5,
          dryRun: false,
          briefId: `${runId}__${tpl.name}`,
          consultantId: tpl.brief.email,
          context,
        });
      } catch (err) {
        result = {
          status: 'error',
          leads: [],
          meta: {
            errorCode: 'thrown',
            errorMessage: String((err && err.message) || err),
          },
        };
      }
      const elapsedMs = Date.now() - tStart;
      const meta = result.meta || {};
      const selectorMeta = result.selectorMeta || {};
      const leads = Array.isArray(result.leads) ? result.leads : [];
      const leadsResolved = leads.filter((l) => l && l.email).length;
      const passed = leadsResolved >= (tpl.expected.minLeadsResolved || 1);
      results.push({
        name: tpl.name,
        description: tpl.description,
        consultantId: tpl.brief.email,
        passed,
        status: result.status,
        candidatesCount: selectorMeta.candidatesCount || meta.candidatesCount || 0,
        excludedNoDirigeant: selectorMeta.excludedNoDirigeant || meta.excludedNoDirigeant || 0,
        excludedAlreadyInPipe: selectorMeta.excludedAlreadyInPipe || meta.excludedAlreadyInPipe || 0,
        leadsResolved,
        leadsAttempted: leads.length,
        unresolvableCount: result.unresolvableCount || 0,
        elapsedMs,
        reason: meta.reason || meta.errorCode || null,
        errorMessage: meta.errorMessage || null,
        leadsSample: leads.slice(0, 5).map((l) => ({
          siren: l && l.siren,
          entreprise: l && l.entreprise,
          email: l && l.email,
          prenom: l && l.prenom,
          nom: l && l.nom,
        })),
      });
      log(`[smoke-e2e] ${tpl.name} → ${result.status} resolved=${leadsResolved} ${passed ? 'PASS' : 'FAIL'} (${elapsedMs}ms)`);
    }

    await persistResults(runId, results, startedAt, context);

    // Compte des fails consécutifs sur la base des runs récents
    const consecutiveFails = await countRecentConsecutiveFails(startedAt, context).catch(() => 0);
    log(`[smoke-e2e] consecutiveFails detected=${consecutiveFails}`);

    const anyFailToday = results.some((r) => !r.passed);
    await sendRecap(results, runId, startedAt, anyFailToday, consecutiveFails).catch((err) => {
      log.warn(`[smoke-e2e] recap mail failed: ${err && err.message}`);
    });

    if (consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
      await sendIncidentAlert(results, runId, startedAt, consecutiveFails).catch((err) => {
        log.warn(`[smoke-e2e] incident alert failed: ${err && err.message}`);
      });
    }

    log(`[smoke-e2e] done`);
  },
});

async function persistResults(runId, results, startedAt, context) {
  const log = makeSafeLogger(context);
  const cs = process.env.AzureWebJobsStorage;
  if (!cs) return;
  let client;
  try {
    client = TableClient.fromConnectionString(cs, TABLE_NAME);
    await client.createTable().catch(() => {});
  } catch (err) {
    log.warn(`[smoke-e2e] cannot init table: ${err && err.message}`);
    return;
  }

  const allPassed = results.every((r) => r.passed);
  for (const r of results) {
    try {
      await client.upsertEntity({
        partitionKey: startedAt.toISOString().slice(0, 10),
        rowKey: `${runId}__${r.name}`,
        runId,
        startedAt: startedAt.toISOString(),
        allRunPassed: allPassed,
        ...r,
        leadsSampleJson: JSON.stringify(r.leadsSample || []).slice(0, 32000),
        leadsSample: undefined,
      }, 'Replace');
    } catch (err) {
      log.warn(`[smoke-e2e] persist ${r.name} failed: ${err && err.message}`);
    }
  }
}

/**
 * Compte les jours consécutifs (en remontant depuis aujourd'hui inclus) où
 * `allRunPassed === false`. Retourne 0 si aujourd'hui ou la veille a passé.
 */
async function countRecentConsecutiveFails(startedAt, context) {
  const log = makeSafeLogger(context);
  const cs = process.env.AzureWebJobsStorage;
  if (!cs) return 0;
  let client;
  try {
    client = TableClient.fromConnectionString(cs, TABLE_NAME);
  } catch {
    return 0;
  }

  // Fenêtre 14 jours pour borner la lecture
  const since = new Date(startedAt.getTime() - 14 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  let count = 0;
  try {
    const iter = client.listEntities({
      queryOptions: { filter: `PartitionKey ge '${since}'` },
    });
    const byDate = new Map();
    for await (const e of iter) {
      const d = String(e.partitionKey || '');
      if (!byDate.has(d)) byDate.set(d, true);
      // allRunPassed est booléen mais Azure Table sérialise en string parfois
      const pass = e.allRunPassed === true || e.allRunPassed === 'true';
      if (!pass) byDate.set(d, false);
    }
    const sortedDates = [...byDate.keys()].sort().reverse();
    for (const d of sortedDates) {
      if (byDate.get(d) === false) count++;
      else break;
    }
  } catch (err) {
    log.warn(`[smoke-e2e] countRecentConsecutiveFails failed: ${err && err.message}`);
    return 0;
  }
  return count;
}

async function sendRecap(results, runId, startedAt, anyFailToday, consecutiveFails) {
  const subject = anyFailToday
    ? `[Pereneo Smoke E2E ${consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD ? 'ALERTE' : 'WARN'}] ${runId.slice(0, 16)} — fail détecté`
    : `[Pereneo Smoke E2E OK] ${runId.slice(0, 16)} — pipeline pilote vivant`;

  const allRows = results
    .map(
      (r) =>
        `<tr><td>${r.passed ? '✓' : '✗'}</td><td>${r.name}</td><td>${r.consultantId}</td><td>${r.status}</td><td>${r.candidatesCount}</td><td>${r.leadsAttempted}</td><td>${r.leadsResolved}</td><td>${r.excludedNoDirigeant}</td><td>${r.excludedAlreadyInPipe}</td><td>${r.elapsedMs}ms</td><td>${r.reason || ''}${r.errorMessage ? ' ' + r.errorMessage : ''}</td></tr>`,
    )
    .join('');

  const leadsHtml = results
    .map((r) => {
      const sample = (r.leadsSample || []).map(
        (l) =>
          `<li><strong>${l.entreprise || '∅'}</strong> (${l.siren || '∅'}) — ${l.prenom || ''} ${l.nom || ''} → <code>${l.email || '∅'}</code></li>`,
      ).join('');
      return `<h4>${r.name}</h4>${sample ? `<ul>${sample}</ul>` : '<p><em>0 lead enrichi</em></p>'}`;
    })
    .join('');

  const html = `<p>Bonjour Paul,</p>
<p>Smoke E2E pilote Pérenne du <strong>${startedAt.toLocaleString('fr-FR')}</strong>.</p>
${consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD ? `<p style="background:#fee;padding:10px;border-left:4px solid #c33"><strong>ALERTE :</strong> ${consecutiveFails} jours consécutifs de fail. <code>direction@perennereseau.fr</code> notifié.</p>` : ''}
<h3>Récap briefs</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr><th>OK</th><th>Brief</th><th>Consultant</th><th>Status</th><th>Cand.</th><th>Tentés</th><th>Résolus</th><th>NoDir.</th><th>InPipe</th><th>Elapsed</th><th>Notes</th></tr>
${allRows}
</table>

<h3>Leads enrichis (échantillon 5 par brief)</h3>
${leadsHtml}

<p><em>Run ID : ${runId}</em></p>
<p>Richard (smoke E2E P-R4)</p>`;

  await sendMail({
    from: FROM_EMAIL,
    to: RECAP_EMAIL,
    subject,
    html,
  });
}

async function sendIncidentAlert(results, runId, startedAt, consecutiveFails) {
  const html = `<p>Bonjour direction,</p>
<p>Le smoke E2E pilote Pérenne échoue depuis <strong>${consecutiveFails} jours consécutifs</strong>.</p>
<p>Run en cours : <code>${runId}</code> du ${startedAt.toLocaleString('fr-FR')}.</p>
<p>Détail consultants :</p>
<ul>
${results.map((r) => `<li>${r.name} (${r.consultantId}) — status=${r.status}, leadsResolved=${r.leadsResolved}/${r.leadsAttempted}, reason=${r.reason || '-'}</li>`).join('')}
</ul>
<p>Action attendue : ouvrir un incident, vérifier état pipeline + état FA <code>pereneo-mail-sender</code> + état RNE api.gouv + cascade Dropcontact.</p>
<p>Richard — DG RT &amp; Delivery Péreneo</p>`;

  await sendMail({
    from: FROM_EMAIL,
    to: ALERT_EMAIL,
    subject: `[INCIDENT Pereneo] Smoke E2E pilote fail ${consecutiveFails}j consécutifs`,
    html,
  });
}
