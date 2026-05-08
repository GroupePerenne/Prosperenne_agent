'use strict';

/**
 * Probe ad-hoc 8 mai 2026 PM — webSearch sur "Univert Paysages COLLONGES".
 *
 * Question Paul : "Google trouve direct, pourquoi notre code n'y arrive pas ?"
 *
 * Test : pour les 4 backends actifs en prod (DDG Lite, Mojeek, Ecosia, DDG HTML)
 * + Brave (retiré du défaut prod le 6 mai mais clé toujours en KV) :
 *   - Quelle est la réponse ?
 *   - Premier résultat = bon site ?
 *   - Quel est le filtrage qui rejette ?
 */

const ddgLite = require('../shared/site-finder/sources/webSearchBackends/duckduckgoLite');
const ddgHtml = require('../shared/site-finder/sources/webSearchBackends/duckduckgoHtml');
const mojeek = require('../shared/site-finder/sources/webSearchBackends/mojeek');
const ecosia = require('../shared/site-finder/sources/webSearchBackends/ecosia');
const braveApi = require('../shared/site-finder/sources/webSearchBackends/braveApi');
const { isAggregator } = require('../shared/site-finder/aggregators');

const QUERIES = [
  // Univert Paysages — sweet spot test
  '"Univert Paysages" Collonges',
  'Univert Paysages',
  // Sanity check Brave (entreprises connues qu'on sait être indexées)
  'EDF',
  'OSEYS',
  'Pereneo',
  // Lead Morgane qui a HIT Dropcontact catch_all
  '"ELEC SAS" Chateauneuf',
  // Un autre lead Johnny BTP qui devrait avoir un site
  '"MARGUIN SAS" Chalamont',
  '"PROTECSAN" Chaleins',
];

async function tryBackend(backend, query) {
  const id = backend.BACKEND_ID;
  console.log(`\n--- Backend: ${id} | Query: ${query} ---`);
  try {
    const t0 = Date.now();
    const results = await backend.search(query, { maxResults: 10 });
    const elapsed = Date.now() - t0;
    console.log(`OK en ${elapsed}ms : ${results.length} résultats`);
    results.forEach((r, i) => {
      const aggr = isAggregator(r.url) ? '[AGGREGATOR]' : '';
      console.log(`  ${i + 1}. ${r.url} ${aggr}`);
      if (r.title) console.log(`     "${r.title}"`);
    });
  } catch (err) {
    console.log(`FAIL : ${err.message} (code=${err.code || '-'})`);
  }
}

async function main() {
  console.log(`Probe webSearch sur ${QUERIES.length} formats query (Brave only)`);
  console.log(`Date: ${new Date().toISOString()}`);

  for (const query of QUERIES) {
    await tryBackend(braveApi, query);
  }

  console.log('\nFin probe.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
