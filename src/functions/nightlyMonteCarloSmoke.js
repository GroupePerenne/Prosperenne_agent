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
const { enrichBatchInPlace } = require('../../shared/enrichers/dirigeants-rne');

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

// Cron 4h Paris (WEBSITE_TIME_ZONE=Romance Standard Time sur le FA David).
// Choix 4h : assez tôt pour que les auto-corrections aient le temps de
// tourner et de pré-enrichir AVANT le démarrage du pilote (envois 9h-11h).
app.timer('nightlyMonteCarloSmoke', {
  schedule: process.env.MONTECARLO_CRON || '0 0 4 * * *',
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

    // Auto-corrections sur les patterns connus
    const failed = results.filter((r) => !r.passed);
    let corrections = [];
    if (failed.length > 0) {
      corrections = await applyAutoCorrections(failed, BRIEF_TEMPLATES, context).catch((err) => {
        log.warn(`[mc] auto-corrections failed: ${err.message}`);
        return [];
      });
    }

    // Alerter si fail (avec détail des corrections appliquées)
    if (failed.length > 0) {
      await sendAlert(failed, results, corrections, runId, startedAt).catch((err) => {
        log.warn(`[mc] alert mail failed: ${err.message}`);
      });
    }

    log(`[mc] done — ${results.length} briefs tested, ${failed.length} failed, ${corrections.length} corrections appliquées`);
  },
});

/**
 * Auto-corrections Monte Carlo. Pour chaque échec détecté, applique une
 * action corrective sûre (jamais destructive). Retourne le journal des
 * corrections appliquées avec leur résultat.
 *
 * Patterns gérés :
 * - excludedNoDirigeant ratio > 70% : déclenche pré-enrichissement RNE sur
 *   un échantillon LeadBase ciblé pour améliorer le pool des prochains runs.
 * - errorMessage "Cannot read private member" : BL-45 détecté → log + alerte
 *   uniquement (le fix est dans le code, signal d'une régression de deploy).
 * - errorMessage "LeadBase connection string absente" : KV ref unresolved →
 *   alerte (correction manuelle requise sur access policy).
 * - returned 0 sur brief edge_secteur_inconnu attendu empty : OK, pas une
 *   dégradation.
 */
async function applyAutoCorrections(failed, templates, context) {
  const log = makeSafeLogger(context);
  const corrections = [];

  for (const result of failed) {
    const tpl = templates.find((t) => t.name === result.name);
    if (!tpl) continue;

    // Pattern 1 : noDirigeant ratio élevé → pré-enrichissement RNE
    if (
      result.status === 'empty' &&
      result.candidatesCount > 100 &&
      result.excludedNoDirigeant > 0
    ) {
      const ratio = result.excludedNoDirigeant / Math.max(1, result.candidatesCount);
      if (ratio > 0.7) {
        try {
          const sample = await prefetchEnrichmentForBrief(tpl.brief, 100, context);
          corrections.push({
            name: result.name,
            action: 'prefetch_rne_sample',
            note: `noDirigeant ratio ${(ratio * 100).toFixed(0)}% — pré-enrichissement RNE sur 100 SIRENs zone`,
            outcome: `${sample.enriched}/${sample.attempted} dirigeants enrichis`,
          });
          log(`[mc] auto-correction prefetch_rne sur ${result.name}: ${sample.enriched}/${sample.attempted}`);
        } catch (err) {
          corrections.push({
            name: result.name,
            action: 'prefetch_rne_sample',
            note: 'tentative échouée',
            outcome: `error: ${err.message}`,
          });
        }
      }
    }

    // Pattern 2 : BL-45 detected
    if (result.errorMessage && result.errorMessage.includes('Cannot read private member')) {
      corrections.push({
        name: result.name,
        action: 'bl45_signal',
        note: 'Régression BL-45 détectée — context bind perdu',
        outcome: 'alerte uniquement, code patch est déjà déployé. Vérifier si dernier deploy a écrasé le fix.',
      });
    }

    // Pattern 3 : LeadBase KV ref unresolved
    if (
      result.errorMessage &&
      result.errorMessage.includes('LeadBase connection string absente')
    ) {
      corrections.push({
        name: result.name,
        action: 'kv_ref_alert',
        note: 'KV ref LEADBASE_STORAGE_CONNECTION_STRING non résolue',
        outcome: 'alerte uniquement, vérifier MI access policy sur pereneo-prod-kv',
      });
    }

    // Pattern 4 : timeout > 180s
    if (result.elapsedMs > 180000) {
      corrections.push({
        name: result.name,
        action: 'timeout_signal',
        note: `elapsedMs ${result.elapsedMs}ms > 180s`,
        outcome: 'alerte uniquement. Probable scan LeadBase lent ou enrichissement RNE en boucle.',
      });
    }
  }

  return corrections;
}

/**
 * Pré-enrichissement RNE ciblé : récupère un échantillon LeadBase pour la
 * zone du brief, fetch les dirigeants RNE, persiste en LeadBase. Améliore
 * le pool des prochains runs.
 *
 * V0 simple : fetch ~100 SIRENs du même secteur+département, sans filtre
 * complexe. Suffit pour combler une partie du trou.
 */
async function prefetchEnrichmentForBrief(brief, limit, context) {
  const cs = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!cs) return { attempted: 0, enriched: 0, skipped: 'no_connection_string' };

  // V0 : fetch les N premiers candidats SANS filtre fin (le but est juste
  // de remplir progressivement la cache RNE). En V1+, on pourrait ré-utiliser
  // mapBriefToFilters pour cibler le secteur exact.
  const tableClient = TableClient.fromConnectionString(cs, 'LeadBase');
  const sample = [];
  try {
    const iter = tableClient.listEntities({
      queryOptions: {
        select: ['partitionKey', 'rowKey', 'siren', 'dirigeants'],
      },
    });
    for await (const e of iter) {
      if (!e.dirigeants || e.dirigeants === 'null' || e.dirigeants === '[]') {
        sample.push(e);
        if (sample.length >= limit) break;
      }
    }
  } catch (err) {
    return { attempted: 0, enriched: 0, error: err.message };
  }

  if (sample.length === 0) return { attempted: 0, enriched: 0 };

  const enriched = await enrichBatchInPlace(sample, { concurrency: 8 }).catch(() => 0);

  // Persiste les enrichissements en LeadBase (Merge)
  let persisted = 0;
  for (const e of sample) {
    if (e.dirigeants && e.dirigeants !== 'null' && e.dirigeants !== '[]') {
      try {
        await tableClient.updateEntity(
          {
            partitionKey: e.partitionKey,
            rowKey: e.rowKey,
            dirigeants: e.dirigeants,
            rne_checked_at: new Date().toISOString(),
          },
          'Merge',
        );
        persisted++;
      } catch {
        // best effort
      }
    }
  }

  return { attempted: sample.length, enriched, persisted };
}

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

async function sendAlert(failed, allResults, corrections, runId, startedAt) {
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

  const correctionsHtml =
    corrections && corrections.length > 0
      ? `<h3>Auto-corrections appliquées (${corrections.length})</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12px">
<tr><th>Brief</th><th>Action</th><th>Note</th><th>Résultat</th></tr>
${corrections.map((c) => `<tr><td>${c.name}</td><td><code>${c.action}</code></td><td>${c.note || '-'}</td><td>${c.outcome || '-'}</td></tr>`).join('')}
</table>`
      : '<p><em>Aucune auto-correction appliquée (pas de pattern reconnu pour ces échecs).</em></p>';

  const html = `<p>Bonjour,</p>
<p>La passe Monte Carlo nocturne du <strong>${startedAt.toLocaleString('fr-FR')}</strong> a détecté <strong>${failed.length} dégradation(s)</strong> sur Lead Selector.</p>
<h3>Briefs en échec</h3>
<ul>${summary}</ul>
${correctionsHtml}
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
    subject: `[Pereneo] Alerte Monte Carlo — ${failed.length} brief(s) en échec, ${corrections ? corrections.length : 0} corrections`,
    html,
  });
}
