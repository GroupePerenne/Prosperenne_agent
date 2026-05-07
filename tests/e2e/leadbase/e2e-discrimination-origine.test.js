/**
 * E2E #2 — Discrimination origine.
 *
 * Doctrine : LEADBASE_SCHEMA_v1.md §11.3 + invariant I-2.
 *
 * Scénario : LeadBase contient un mix legacy (sans schema_version) + v1
 * (schema_version='1.0'). Tous les readers de prod ne lisent QUE les
 * entrées v1. Test = aucun reader ne remonte une entrée legacy.
 *
 * Cas d'origine : 351 emails comptés sur PK=75 mais en réalité sur du
 * legacy non-cible OSEYS (constat 7 mai matin).
 *
 * Statut : SKIP par défaut.
 */

'use strict';

const test = require('node:test');

const E2E_ENABLED = process.env.LEADBASE_E2E === '1';
const SKIP_REASON = E2E_ENABLED
  ? null
  : 'LEADBASE_E2E env absent — test skipped (requires real infra)';

test('E2E #2 — readers de prod ne lisent que schema_version=1.0',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // 1. Préparer LeadBase test : 100 entrées legacy (sans schema_version)
    //    + 100 entrées v1 (schema_version='1.0').
    // 2. Pour chaque reader de prod (lead-selector, AirWorker, smoke,
    //    dailyDigest), capturer les entrées remontées.
    // 3. Assert : 100% des entrées remontées ont schema_version='1.0'.
    // Tout reader doit utiliser safeListLeadBaseEntities ou équivalent.
  },
);

test('E2E #2 — safeListLeadBaseEntities rejette scan sans discriminant en prod',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // Tente un listEntities sans filter discriminant via le code de prod
    // (post-bascule). Doit lancer I2_violation, pas remonter de données.
  },
);

test('E2E #2 — audit prod détecte un reader fautif (anti-régression)',
  { skip: SKIP_REASON },
  async () => {
    // À implémenter Bloc 4 :
    // Inject volontairement un reader fautif (sans filter), lance
    // audit-leadbase-integrity.js, vérifier qu'il alerte.
  },
);
