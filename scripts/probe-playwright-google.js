'use strict';

/**
 * Probe ad-hoc 8 mai 2026 PM — backend Playwright Google sur cas réels.
 *
 * Test rapide pour valider que :
 *   - Chromium se lance correctement (Mac Paul)
 *   - Google répond depuis IP résidentielle
 *   - Pas de CAPTCHA en quelques requêtes
 *   - Parse résultats fonctionne
 *   - Performance acceptable
 *
 * Si OK : on poursuit refonte AirWorker waterfall locale.
 * Si CAPTCHA / ban : on doit revoir (proxy, session cookies, etc).
 */

const playwrightGoogle = require('../shared/site-finder/sources/webSearchBackends/playwrightGoogle');
const { isAggregator } = require('../shared/site-finder/aggregators');

const QUERIES = [
  'Univert Paysages Collonges',          // miss Brave/Dropcontact
  'MARGUIN SAS Chalamont',                // BTP TPE Ain
  'PROTECSAN Chaleins',                   // BTP TPE Ain
  '"NORMANDIE DERATISATION" Bernay',      // service TPE Eure
  'ETABLISSEMENTS BROKA Cloyes',          // BTP Eure-et-Loir
];

async function main() {
  console.log(`Probe Playwright Google — ${QUERIES.length} queries`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log('');

  for (const query of QUERIES) {
    const t0 = Date.now();
    console.log(`--- Query: ${query}`);
    try {
      const results = await playwrightGoogle.search(query, { maxResults: 5 });
      const elapsed = Date.now() - t0;
      console.log(`  OK en ${elapsed}ms : ${results.length} résultats`);
      results.forEach((r, i) => {
        const aggr = isAggregator(r.url) ? '[AGGREGATOR]' : '';
        console.log(`    ${i + 1}. ${r.url} ${aggr}`);
        if (r.title) console.log(`       "${r.title.slice(0, 70)}"`);
      });
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.log(`  FAIL en ${elapsed}ms : ${err.message} (code=${err.code || '-'})`);
    }
    // Throttle politesse 8s entre queries (recommandation côté Google)
    await new Promise((r) => setTimeout(r, 8000));
  }

  await playwrightGoogle.closeBrowser();
  console.log('\nFin probe.');
}

main().catch(async (err) => {
  console.error(err);
  try { await playwrightGoogle.closeBrowser(); } catch {}
  process.exit(1);
});
