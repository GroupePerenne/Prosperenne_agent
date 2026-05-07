/**
 * E2E #3 — Fallback multi-source pour intégrations externes.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.3 + invariants I-4 et I-5.
 *
 * Scénario : on simule l'indisponibilité de chaque source externe critique
 * une à une. À chaque fois, la cascade doit continuer avec un fallback ou
 * une dégradation gracieuse (pas de plante hard).
 *
 * Cas d'origine : commit 62a7cc9 + ban IP data.gouv (resolveDomain mono-
 * source plante 7/10 leads sur Phase 4 smoke).
 *
 * Statut : SKIP par défaut.
 */

'use strict';

const test = require('node:test');

const E2E_ENABLED = process.env.LEADBASE_E2E === '1';
const SKIP_REASON = E2E_ENABLED
  ? null
  : 'LEADBASE_E2E env absent — test skipped (requires mock infra avec network injectable)';

test('E2E #3 — data.gouv banni : cascade resolveDomain continue via fallback',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 2 :
    // 1. Mock fetch pour rejeter recherche-entreprises.api.gouv.fr (Connection refused).
    // 2. Lancer resolveDomain sur 10 leads cibles.
    // 3. Vérifier ≥ 80% des leads ont domain résolu via fallback (site-finder
    //    heuristic, ou autre webSearchBackend).
  },
);

test('E2E #3 — OpenDataSoft 503 : sireneIngestion continue via INSEE direct',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 2 :
    // 1. Mock OpenDataSoft pour retourner 503.
    // 2. Lancer sireneIngestion sur 100 SIRENs.
    // 3. Vérifier le fallback api.insee.fr est tenté et que ≥ 50% des SIRENs
    //    sont quand même ingérés en mode dégradé.
  },
);

test('E2E #3 — Dropcontact timeout : exhauster fallback internal_patterns',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 3 :
    // 1. Mock Dropcontact pour timeout 110s sur tout call.
    // 2. Lancer leadExhauster sur 10 leads avec firstName/lastName + domain.
    // 3. Vérifier ≥ 30% des leads ont email via internal_patterns ou
    //    internal_scraping en fallback (circuit breaker ouvre, fallback prend).
  },
);

test('E2E #3 — RNE api.gouv 500 : fallback annuaire-entreprises HTML',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 2 :
    // 1. Mock recherche-entreprises.api.gouv.fr 500.
    // 2. Lancer enrich-leadbase-continuous sur 50 SIRENs.
    // 3. Vérifier le fallback annuaire-entreprises.data.gouv.fr HTML scraping
    //    enrichit ≥ 30% des SIRENs malgré la panne primaire.
  },
);

test('E2E #3 — Mem0 timeout : fallback local ~/.charli/fallback ne perd rien',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // 1. Mock Mem0 pour timeout sur add_memory.
    // 2. Tenter d'ajouter une mémoire critique côté Charli wrapper.
    // 3. Vérifier que le fait est dans ~/.charli/fallback/<date>-<topic>.md
    //    avec contenu reconstituable.
  },
);
