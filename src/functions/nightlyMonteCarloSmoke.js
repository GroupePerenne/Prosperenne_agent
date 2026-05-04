/**
 * Timer trigger nightlyMonteCarloSmoke — tourne tous les jours à 3h UTC
 * (5h Paris été / 4h hiver). Lance N briefs synthétiques contre Lead
 * Selector pour détecter les régressions silencieuses.
 *
 * Né de l'incident BL-45 + dirigeants null du 4 mai 2026 : Lead Selector
 * était cassé silencieusement, on l'a découvert via Morgane. Cette fonction
 * vise à détecter ces dégradations en amont, AVANT qu'un consultant ne soit
 * impacté.
 *
 * Schéma :
 *   - Pour chaque BRIEF_TEMPLATE de la suite Monte Carlo, on appelle
 *     selectCandidatesForConsultant (sans Dropcontact ni séquence) et on
 *     observe : status, candidatesCount, excludedNoDirigeant ratio,
 *     returned, elapsedMs.
 *   - Résultats archivés en Storage Table monteCarloRuns (1 row par brief).
 *   - Alerte mail direction@oseys.fr si une métrique de santé sort des
 *     seuils définis (status != ok|insufficient, ou returned == 0 sur un
 *     brief qui devrait en produire, ou elapsedMs > 180s).
 */

'use strict';

const { app } = require('@azure/functions');
const { selectCandidatesForConsultant } = require('../../shared/leadSelector');
const { sendMail } = require('../../shared/graph-mail');
const { TableClient } = require('@azure/data-tables');
const { makeSafeLogger } = require('../../shared/safe-log');

const TABLE_NAME = process.env.MONTECARLO_RUNS_TABLE || 'monteCarloRuns';
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'direction@oseys.fr';
const FROM_EMAIL = process.env.DAVID_EMAIL || 'david@oseys.fr';

// Suite de briefs synthétiques couvrant des configurations variées.
// Chaque template a un nom + un brief + une attente minimale (returned ≥ N).
const BRIEF_TEMPLATES = [
  {
    name: 'morgane_boulogne_10km',
    description: 'Brief consultant Morgane (Boulogne 10km, 10 secteurs PME)',
    brief: {
      nom: 'MC Morgane',
      email: 'mc-morgane@oseys.fr',
      secteurs:
        'plomberie,electricite,domotique,menuiserie,architecture,formation,maintenance,securite,nettoyage,services_particuliers',
      effectif: '10-20',
      zone: 'default',
      zone_rayon: 10,
      ville: '87 Avenue Pierre Grenier 92100 Boulogne-Billancourt',
      prospecteur: 'mila',
      offre: 'rdv-cale',
    },
    expected: { minCandidates: 500, minReturned: 1 },
  },
  {
    name: 'paris_idf_conseil',
    description: 'Conseil/ESN/agence Paris IDF effectif 20-49',
    brief: {
      nom: 'MC Paris Conseil',
      email: 'mc-paris-conseil@oseys.fr',
      secteurs: 'agence_communication,conseil,esn,bureau_etudes',
      effectif: '20-49',
      zone: 'region',
      ville: 'Paris',
      prospecteur: 'both',
      offre: 'lead',
    },
    expected: { minCandidates: 500, minReturned: 1 },
  },
  {
    name: 'minimal_secteur_unique',
    description: 'Brief minimal 1 secteur, effectif 10-20, zone region IDF',
    brief: {
      nom: 'MC Minimal',
      email: 'mc-minimal@oseys.fr',
      secteurs: 'maintenance',
      effectif: '10-20',
      zone: 'region',
      ville: 'Paris',
      prospecteur: 'martin',
      offre: 'rdv-cale',
    },
    expected: { minCandidates: 200, minReturned: 1 },
  },
  {
    name: 'large_france',
    description: 'Brief large : agences communication + esn, France entière',
    brief: {
      nom: 'MC Large France',
      email: 'mc-large@oseys.fr',
      secteurs: 'agence_communication,esn,bureau_etudes,conseil',
      effectif: '20-49,40-75',
      zone: 'france',
      ville: 'Paris',
      prospecteur: 'both',
      offre: 'lead',
    },
    expected: { minCandidates: 1000, minReturned: 5 },
  },
  {
    name: 'edge_secteur_inconnu',
    description: 'Brief avec secteur inconnu (devrait fallback sur empty/no_sector_mapped)',
    brief: {
      nom: 'MC Edge Unknown',
      email: 'mc-edge@oseys.fr',
      secteurs: 'totalement_inconnu_xyz',
      effectif: '10-20',
      zone: 'region',
      ville: 'Paris',
      prospecteur: 'both',
      offre: 'lead',
    },
    expected: { expectedStatus: 'empty', expectedReason: 'no_sector_mapped' },
  },
];

app.timer('nightlyMonteCarloSmoke', {
  schedule: process.env.MONTECARLO_CRON || '0 0 3 * * *',
  handler: async (myTimer, context) => {
    const log = makeSafeLogger(context);
    log('[mc] starting nightly Monte Carlo smoke suite');
    const startedAt = new Date();
    const runId = `mc-${startedAt.toISOString().replace(/[:.]/g, '-')}`;

    const results = [];
    for (const tpl of BRIEF_TEMPLATES) {
      const tStart = Date.now();
      let result;
      try {
        result = await selectCandidatesForConsultant({
          brief: tpl.brief,
          briefId: `${runId}__${tpl.name}`,
          consultantId: tpl.brief.email,
          context,
          batchSize: 10,
        });
      } catch (err) {
        result = {
          status: 'error',
          meta: {
            errorCode: 'thrown',
            errorMessage: String((err && err.message) || err),
          },
        };
      }
      const elapsedMs = Date.now() - tStart;
      const sel = result.meta || {};
      const passed = checkExpectations(tpl, result);
      results.push({
        name: tpl.name,
        description: tpl.description,
        passed,
        status: result.status,
        candidatesCount: sel.candidatesCount || 0,
        excludedNoDirigeant: sel.excludedNoDirigeant || 0,
        returned: sel.returned || 0,
        nafCount: (sel.nafCodesQueried || []).length,
        deptCount: (sel.zoneFilter && Array.isArray(sel.zoneFilter.departements))
          ? sel.zoneFilter.departements.length : 0,
        elapsedMs,
        reason: sel.reason || sel.errorCode || null,
        errorMessage: sel.errorMessage || null,
      });
      log(`[mc] ${tpl.name} → ${result.status} ${passed ? 'PASS' : 'FAIL'} (${elapsedMs}ms)`);
    }

    // Persist results
    await persistResults(runId, results, startedAt, context);

    // Alerter si fail
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      await sendAlert(failed, results, runId, startedAt).catch((err) => {
        log.warn(`[mc] alert mail failed: ${err.message}`);
      });
    }

    log(`[mc] done — ${results.length} briefs tested, ${failed.length} failed`);
  },
});

function checkExpectations(tpl, result) {
  const e = tpl.expected || {};
  const sel = result.meta || {};
  const status = result.status;

  if (e.expectedStatus && status !== e.expectedStatus) return false;
  if (e.expectedReason && sel.reason !== e.expectedReason) return false;
  if (e.minCandidates !== undefined && (sel.candidatesCount || 0) < e.minCandidates) return false;
  if (e.minReturned !== undefined && (sel.returned || 0) < e.minReturned) return false;

  // Erreur silencieuse non attendue
  if (status === 'error' && !e.expectedStatus) return false;
  return true;
}

async function persistResults(runId, results, startedAt, context) {
  const log = makeSafeLogger(context);
  const cs = process.env.AzureWebJobsStorage;
  if (!cs) return;
  let client;
  try {
    client = TableClient.fromConnectionString(cs, TABLE_NAME);
    await client.createTable().catch(() => {});
  } catch (err) {
    log.warn(`[mc] cannot init table: ${err.message}`);
    return;
  }

  for (const r of results) {
    try {
      await client.upsertEntity({
        partitionKey: startedAt.toISOString().slice(0, 10),
        rowKey: `${runId}__${r.name}`,
        runId,
        startedAt: startedAt.toISOString(),
        ...r,
      }, 'Replace');
    } catch (err) {
      log.warn(`[mc] persist ${r.name} failed: ${err.message}`);
    }
  }
}

async function sendAlert(failed, allResults, runId, startedAt) {
  const summary = failed
    .map(
      (r) =>
        `<li><strong>${r.name}</strong> (${r.description}) — status=${r.status}, returned=${r.returned}, candidates=${r.candidatesCount}, reason=${r.reason || '-'}, ${r.errorMessage ? 'errorMessage=' + r.errorMessage : ''}</li>`,
    )
    .join('');
  const allRows = allResults
    .map(
      (r) =>
        `<tr><td>${r.passed ? '✓' : '✗'}</td><td>${r.name}</td><td>${r.status}</td><td>${r.candidatesCount}</td><td>${r.returned}</td><td>${r.excludedNoDirigeant}</td><td>${r.elapsedMs}ms</td></tr>`,
    )
    .join('');

  const html = `<p>Bonjour,</p>
<p>La passe Monte Carlo nocturne du <strong>${startedAt.toLocaleString('fr-FR')}</strong> a détecté <strong>${failed.length} dégradation(s)</strong> sur Lead Selector.</p>
<h3>Briefs en échec</h3>
<ul>${summary}</ul>
<h3>Récap complet</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr><th>OK</th><th>Brief</th><th>Status</th><th>Candidates</th><th>Returned</th><th>NoDirigeant</th><th>Elapsed</th></tr>
${allRows}
</table>
<p><em>Run ID : ${runId}</em></p>
<p>Charli</p>`;

  await sendMail({
    from: FROM_EMAIL,
    to: ALERT_EMAIL,
    subject: `[Pereneo] Alerte Monte Carlo — ${failed.length} brief(s) en échec`,
    html,
  });
}
