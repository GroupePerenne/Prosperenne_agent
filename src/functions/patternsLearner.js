/**
 * Timer Function — patterns-learner.
 *
 * Schedule : dimanche 3h UTC (5h Paris en été / 4h en hiver).
 * CRON v4 Azure Functions : `0 0 3 * * 0` (sec min heure jourMois mois jourSem).
 *
 * Flow hebdomadaire :
 *   1. Scan `LeadContacts` — rows avec feedbackAt ≥ J-7
 *   2. Agrégation par (nafDivision, tranche, patternId) via signals parsés
 *   3. Merge avec les compteurs cumulés en `EmailPatterns`
 *   4. Upsert avec calcul successRate / bounceRate
 *   5. Désactivation soft (active=false) si bounceRate > 0.30 sur
 *      sampleSize > 20
 *
 * Tout le travail utile vit dans `shared/lead-exhauster/patternsLearner.js`.
 * Cette fonction ne fait que déclencher + logger Application Insights.
 *
 * Rétention Application Insights 30 jours par défaut. Les métriques
 * clés (deactivated count, errors) sont observables dans le dashboard
 * Charli futur.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §6 + §12 Jalon 4.
 */

const { app } = require('@azure/functions');
const { runWeeklyLearn } = require('../../shared/lead-exhauster/patternsLearner');

app.timer('patternsLearner', {
  // Dimanche 3h UTC = ~5h Paris été / 4h hiver. Heure creuse pour Azure
  // Storage et évite le conflit avec scheduler (qui tourne toutes les 15 min).
  schedule: '0 0 3 * * 0',
  handler: async (myTimer, context) => {
    const startedAt = new Date().toISOString();
    context.log(`patternsLearner tick @ ${startedAt}`);

    try {
      const stats = await runWeeklyLearn();
      context.log(
        `patternsLearner: rowsScanned=${stats.rowsScanned} bucketsFound=${stats.bucketsFound} `
        + `created=${stats.created} updated=${stats.updated} deactivated=${stats.deactivated} `
        + `errors=${stats.errors} elapsed=${stats.elapsedMs}ms`,
      );
      if (stats.deactivated > 0 && Array.isArray(stats.deactivatedKeys)) {
        context.log(`patternsLearner: deactivated patterns = ${stats.deactivatedKeys.join(', ')}`);
      }
    } catch (err) {
      context.error('patternsLearner failed', err);
    }
  },
});
