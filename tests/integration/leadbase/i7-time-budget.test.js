/**
 * Test intégration I-7 — Time-budget calibré pour batch / async.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-7.
 *
 * Vérifie que les budgets temps cumulés des opérations batch (Dropcontact
 * polls × concurrency × batch_size) ne dépassent pas la fenêtre FA
 * Consumption Plan (10 min = 600s).
 *
 * Cas d'origine : commit 75efed4 (Dropcontact polls 5×30s × batch=10
 * causaient timeout 10min séquentiel). Le fix a passé concurrency=3 et
 * réduit polls à 3×30s. Ce test verrouille que les paramètres restent
 * dans le budget.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DropcontactAdapter } = require('../../../shared/lead-exhauster/adapters/dropcontact');

// ─── Constantes opérationnelles documentées ────────────────────────────────

// Fenêtre FA Consumption Plan (host.json `functionTimeout` post commit 486ffde).
const FA_CONSUMPTION_WINDOW_MS = 600_000; // 10 min

// Marge de sécurité (I-7 demande temps total ≤ window, pas d'égalité).
const SAFETY_MARGIN_MS = 120_000; // 2 min de marge → budget effectif 8 min

// Paramètres opérationnels lead-exhauster (cf. enrichBatch.js).
const EXHAUSTER_CONCURRENCY_DEFAULT = 3;

// Batch size opérationnel observé en prod (cf. lead-selector queue trigger).
const BATCH_SIZE_NOMINAL = 10;

// ─── Tests ─────────────────────────────────────────────────────────────────

test('I-7 — Dropcontact constantes exportées et raisonnables', () => {
  // L'adapter expose DEFAULT_TIMEOUT_MS et DEFAULT_POLL_DELAYS_MS via _constants.
  // On instancie une fois pour vérifier (les statics sont sur la classe).
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const constants = exports._constants || (DropcontactAdapter && DropcontactAdapter._constants);

  // L'adapter expose ses constantes via le module require directement
  // (cf. ligne 438-439 dropcontact.js).
  assert.ok(exports.DEFAULT_TIMEOUT_MS || constants?.DEFAULT_TIMEOUT_MS,
    'DEFAULT_TIMEOUT_MS doit être exporté');
});

test('I-7 — temps unitaire Dropcontact ≤ 110s (post fix 75efed4)', () => {
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const timeoutMs = exports._constants.DEFAULT_TIMEOUT_MS;
  assert.equal(typeof timeoutMs, 'number');
  assert.ok(timeoutMs <= 110_000,
    `DEFAULT_TIMEOUT_MS = ${timeoutMs}, doit être ≤ 110_000 (90s polls + marge)`);
});

test('I-7 — somme polls Dropcontact = 90s (3×30s) post fix 75efed4', () => {
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const polls = exports._constants.DEFAULT_POLL_DELAYS_MS;
  assert.ok(Array.isArray(polls), 'DEFAULT_POLL_DELAYS_MS doit être un array');
  const sum = polls.reduce((acc, ms) => acc + ms, 0);
  assert.equal(sum, 90_000, `Sum polls = ${sum}, doit être 90_000ms (3×30s)`);
  assert.equal(polls.length, 3, 'doit avoir exactement 3 polls (pas 5 comme avant)');
});

test('I-7 — budget batch lead-exhauster nominal ≤ window FA - marge', () => {
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const worstCasePerLeadMs = exports._constants.DEFAULT_TIMEOUT_MS;
  const totalMs = (BATCH_SIZE_NOMINAL * worstCasePerLeadMs) / EXHAUSTER_CONCURRENCY_DEFAULT;
  const budget = FA_CONSUMPTION_WINDOW_MS - SAFETY_MARGIN_MS;
  assert.ok(totalMs <= budget,
    `Budget batch = ${(totalMs / 1000).toFixed(1)}s, doit être ≤ ${(budget / 1000)}s ` +
    `(window ${FA_CONSUMPTION_WINDOW_MS / 1000}s - marge ${SAFETY_MARGIN_MS / 1000}s)`);
});

test('I-7 — alerte si batch_size pousse au-delà du budget', () => {
  // Test du seuil : si on augmentait batch_size jusqu'à dépasser window, doit être détecté.
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const worstCasePerLeadMs = exports._constants.DEFAULT_TIMEOUT_MS;
  const budget = FA_CONSUMPTION_WINDOW_MS - SAFETY_MARGIN_MS;
  const maxSafeBatchSize = Math.floor((budget * EXHAUSTER_CONCURRENCY_DEFAULT) / worstCasePerLeadMs);

  // batch_size nominal doit être ≤ maxSafeBatchSize
  assert.ok(BATCH_SIZE_NOMINAL <= maxSafeBatchSize,
    `BATCH_SIZE_NOMINAL=${BATCH_SIZE_NOMINAL} doit être ≤ maxSafeBatchSize=${maxSafeBatchSize}`);

  // batch_size + 1 ne doit pas systématiquement plus dépasser (sinon on est juste à la limite)
  // Mais pour informer : on log la marge restante
  const usedRatio = (BATCH_SIZE_NOMINAL / maxSafeBatchSize);
  assert.ok(usedRatio <= 0.95,
    `Ratio utilisé = ${(usedRatio * 100).toFixed(0)}% du budget, marge insuffisante (>95%)`);
});

test('I-7 — calcul reproductible via formule documentée', () => {
  // Formule : (batch_size × worst_case_per_lead_ms) / concurrency ≤ FA_window - marge
  // Ce test sert de documentation pour les futurs writers.
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const worstCase = exports._constants.DEFAULT_TIMEOUT_MS;
  const totalMs = (BATCH_SIZE_NOMINAL * worstCase) / EXHAUSTER_CONCURRENCY_DEFAULT;
  // Ex post-fix : 10 × 110_000 / 3 ≈ 366_667ms ≈ 6.1 min — bien dans 8 min budget
  assert.ok(totalMs > 0);
  assert.ok(totalMs < FA_CONSUMPTION_WINDOW_MS);
});
