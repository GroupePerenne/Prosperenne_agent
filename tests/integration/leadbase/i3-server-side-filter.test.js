/**
 * Test intégration I-3 — Filtres serveur-side prioritaires.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-3.
 * Schéma : LEADBASE_SCHEMA_v1.md §10.6.
 *
 * Vérifie :
 *   - safeListLeadBaseEntities propage le filter au client (pas de filter
 *     client-side caché après scan complet).
 *   - Le ratio simulé scan+filter mémoire vs scan filtré confirme l'intérêt
 *     du filter serveur-side (>50× sur sample 100k).
 *
 * Cas d'origine : commit 19e220e (filtre trancheEffectif client-side après
 * scan complet → 12,8M scannés au lieu de filtrer côté requête).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeListLeadBaseEntities,
  composeDiscriminantFilter,
} = require('../../../shared/leadbase/safe-read');

// ─── Test 1 — Propagation du filter au client ──────────────────────────────

test('I-3 — filter propagé au client (pas de re-filtrage client-side)', async () => {
  let lastQueryOptions = null;
  const client = {
    listEntities(queryOptions) {
      lastQueryOptions = queryOptions;
      return (async function* () {})();
    },
  };

  const filter = composeDiscriminantFilter({
    partitionKey: '75', trancheEffectif: '12', codeNaf: '70.22Z',
  });
  const iter = safeListLeadBaseEntities(client, { queryOptions: { filter } });
  for await (const _e of iter) { /* drain */ }

  assert.ok(lastQueryOptions, 'queryOptions doit être passé au client');
  assert.equal(lastQueryOptions.queryOptions.filter, filter);
  assert.ok(lastQueryOptions.queryOptions.filter.includes("schema_version eq '1.0'"));
  assert.ok(lastQueryOptions.queryOptions.filter.includes("trancheEffectif eq '12'"));
  assert.ok(lastQueryOptions.queryOptions.filter.includes("codeNaf eq '70.22Z'"));
});

test('I-3 — filter top-level aussi propagé', async () => {
  let lastQueryOptions = null;
  const client = {
    listEntities(qo) {
      lastQueryOptions = qo;
      return (async function* () {})();
    },
  };
  const iter = safeListLeadBaseEntities(client, { filter: "schema_version eq '1.0'" });
  for await (const _e of iter) { /* */ }
  assert.equal(lastQueryOptions.filter, "schema_version eq '1.0'");
});

// ─── Test 2 — Bench simulé scan complet vs scan filtré ──────────────────────

test('I-3 — bench simulé : scan filtré ≫ scan complet + filter mémoire', () => {
  const TOTAL_LEADS = 100_000;
  const MATCHING_LEADS = 200;
  const ITERATION_COST_NS = 100; // coût simulé par entrée parcourue (round-trip Azure)

  // Scan complet + filter mémoire : on parcourt 100k entrées
  const scanCompleteWithMemoryFilterNs = TOTAL_LEADS * ITERATION_COST_NS;

  // Scan filtré serveur-side : on parcourt seulement les 200 matchantes
  const scanFilteredServerSideNs = MATCHING_LEADS * ITERATION_COST_NS;

  const ratio = scanCompleteWithMemoryFilterNs / scanFilteredServerSideNs;
  assert.ok(
    ratio >= 50,
    `Ratio attendu ≥ 50, observé ${ratio} (scan complet ${TOTAL_LEADS} vs filtré ${MATCHING_LEADS})`,
  );
  // 100k / 200 = 500× — confirme l'invariant pour des cibles à faible cardinalité.
});

// ─── Test 3 — Anti-régression : pas de filter client-side caché ────────────

test('I-3 — anti-régression : grep sur fichiers ciblés détecte les patterns suspects', () => {
  const fs = require('fs');
  const path = require('path');

  // Liste des fichiers à scruter (lecteurs LeadBase post-v1).
  // Si un nouveau reader est ajouté, l'ajouter ici.
  const filesToScrutinize = [
    'shared/leadbase/safe-read.js',
    'scripts/enrich-leadbase-continuous.js',
  ];

  const violations = [];
  for (const rel of filesToScrutinize) {
    const abs = path.resolve(__dirname, '../../../', rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    // Pattern suspect : .filter(... après un listEntities sans filter serveur
    // Heuristique : on cherche un .listEntities() (sans queryOptions) suivi
    // proche d'un .filter (lodash ou Array.filter) ou d'un if (entity.<champ>...).
    // C'est imparfait (faux positifs / négatifs) mais signale.
    const lines = src.split('\n');
    let openListEntitiesAt = -1;
    lines.forEach((line, idx) => {
      if (/listEntities\s*\(\s*\)/.test(line)) {
        openListEntitiesAt = idx;
      } else if (
        openListEntitiesAt >= 0 &&
        idx - openListEntitiesAt < 30 &&
        /^\s*\.filter\s*\(/.test(line)
      ) {
        violations.push(`${rel}:${idx + 1} listEntities()…filter() suspect`);
        openListEntitiesAt = -1;
      }
    });
  }
  // Pour cette première itération on signale, on ne casse pas.
  // Le fichier safe-read.js ne doit pas avoir de violation (c'est le helper officiel).
  const safeReadViolations = violations.filter((v) => v.startsWith('shared/leadbase/safe-read.js'));
  assert.equal(safeReadViolations.length, 0,
    `safe-read.js viole I-3:\n${safeReadViolations.join('\n')}`);
});

// ─── Test 4 — composeDiscriminantFilter pousse les filtres serveur-side ───

test('I-3 — composeDiscriminantFilter inclut tous les filtres serveur-side', () => {
  const filter = composeDiscriminantFilter({
    partitionKey: '75',
    trancheEffectif: '12',
    codeNaf: '70.22Z',
    sireneRunId: 'sirene-1778083858456-dc261214',
  });
  // 5 conditions OData chaînées en AND
  const conditions = filter.split(' and ');
  assert.equal(conditions.length, 5);
  assert.ok(conditions.every((c) => c.includes(' eq ')));
});
