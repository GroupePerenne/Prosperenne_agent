/**
 * E2E #4 — Budget temps batch AirWorker.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.3 + invariant I-7.
 *
 * Scénario : run AirWorker complet sur batch 10 leads avec polls Dropcontact
 * max + scraping max + RNE max. Mesure temps total cumulé.
 *
 * Critère succès : temps total ≤ 8 min (marge 2 min sur fenêtre 10 min FA).
 *
 * Cas d'origine : commit 75efed4 (Dropcontact polls 5×30s × batch=10
 * causaient timeout 10min séquentiel — fix concurrency=3 + 3×30s polls).
 *
 * Statut : SKIP par défaut.
 */

'use strict';

const test = require('node:test');

const E2E_ENABLED = process.env.LEADBASE_E2E === '1';
const SKIP_REASON = E2E_ENABLED
  ? null
  : 'LEADBASE_E2E env absent — test skipped';

test('E2E #4 — batch AirWorker 10 leads worst case ≤ 8 min',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // 1. Préparer 10 leads cibles avec dirigeant peuplé + siteWeb null.
    // 2. Mock Dropcontact pour répondre au poll 3 (max delays).
    // 3. Mock scraping pour 8s par site (max DEFAULT_PAGE_TIMEOUT).
    // 4. Lancer enrichBatch concurrency=3.
    // 5. Mesurer temps total cumulé.
    // 6. Assert ≤ 480_000ms (8 min).
  },
);

test('E2E #4 — formule budget cohérente avec valeurs runtime',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // Re-vérifier en runtime que (BATCH_SIZE × WORST_CASE_MS / CONCURRENCY)
    // ≤ FA_WINDOW - SAFETY_MARGIN, avec les vraies valeurs de prod.
    // Cohérent avec tests/integration/leadbase/i7-time-budget.test.js mais
    // sur les valeurs effectives runtime, pas seulement les constantes module.
  },
);
