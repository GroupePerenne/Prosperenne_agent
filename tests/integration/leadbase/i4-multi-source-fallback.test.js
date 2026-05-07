/**
 * Test intégration I-4 — Multi-source obligatoire + I-5 fallback local.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariants I-4 et I-5.
 * Schéma : LEADBASE_SCHEMA_v1.md §10.8.
 *
 * Vérifie que les adapters externes critiques exposent au moins une source
 * de fallback. Les adapters concernés v1 :
 *   - site-finder webSearch (cascade DDG / Mojeek / Ecosia / Brave)
 *   - resolveDomain (multi-source : api_gouv + site-finder + ...)
 *   - lead-exhauster sources (internal_patterns + scraping + dropcontact + ...)
 *   - sireneIngestion (à livrer Bloc 2 avec fallback INSEE direct)
 *   - rneEnrichment (à livrer Bloc 2 avec fallback annuaire-entreprises)
 *
 * Tests de comportement complet par adapter (mock + simulation indispo
 * primaire) sont reportés au moment où chaque adapter est touché en
 * Blocs 2-3. Ici on valide la convention et l'existence des fallbacks.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─── site-finder webSearch : cascade backends ──────────────────────────────

test('I-4 — site-finder webSearch a au moins 3 backends de cascade', () => {
  const fs = require('fs');
  const path = require('path');
  const backendsDir = path.resolve(__dirname, '../../../shared/site-finder/sources/webSearchBackends');
  const files = fs.readdirSync(backendsDir).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
  assert.ok(files.length >= 3,
    `webSearchBackends doit contenir ≥ 3 backends, trouvé ${files.length}: ${files.join(', ')}`);
  // backends connus minimum
  const expected = ['duckduckgoLite.js', 'mojeek.js', 'ecosia.js'];
  for (const e of expected) {
    assert.ok(files.includes(e), `backend ${e} attendu`);
  }
});

// ─── lead-exhauster sources enum ───────────────────────────────────────────

test('I-4 — lead-exhauster expose ≥ 4 sources distinctes', () => {
  const schemas = require('../../../shared/lead-exhauster/schemas');
  // Module schemas n'expose pas SOURCES directement, on lit la source.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../../shared/lead-exhauster/schemas'), 'utf8');
  const knownSources = ['internal_patterns', 'internal_scraping', 'google_site',
                         'linkedin_signal', 'dropcontact', 'cache'];
  for (const s of knownSources) {
    assert.ok(src.includes(`'${s}'`), `source ${s} attendue dans schemas.js`);
  }
});

// ─── resolveDomain : DOMAIN_SOURCES enum ───────────────────────────────────

test('I-4 — resolveDomain expose ≥ 3 DOMAIN_SOURCES', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../../shared/lead-exhauster/schemas'), 'utf8');
  const expected = ['leadbase', 'api_gouv', 'google', 'scraping', 'input'];
  for (const s of expected) {
    assert.ok(src.includes(`'${s}'`), `source domain ${s} attendue`);
  }
});

// ─── dropcontact adapter : circuit breaker + cache fallback ────────────────

test('I-4 — Dropcontact adapter expose circuit breaker (fallback dégradé)', () => {
  const exports = require('../../../shared/lead-exhauster/adapters/dropcontact');
  const c = exports._constants;
  assert.ok(c.CIRCUIT_BREAKER_THRESHOLD > 0, 'CIRCUIT_BREAKER_THRESHOLD requis pour I-4');
  assert.ok(c.CIRCUIT_BREAKER_OPEN_MS > 0, 'CIRCUIT_BREAKER_OPEN_MS requis');
});

// ─── I-5 : fallback local pour mémoire externe ─────────────────────────────

test('I-5 — convention fallback local Mem0 documentée', () => {
  // Cette séance même utilise ~/.charli/fallback/ quand Mem0 timeout.
  // Le test vérifie que le pattern est documenté dans LEADBASE_SCHEMA §10.8.
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.resolve(__dirname, '../../../docs/LEADBASE_SCHEMA_v1.md');
  const src = fs.readFileSync(schemaPath, 'utf8');
  assert.ok(src.includes('Fallback local pour mémoire externe (I-5)'),
    'Section §10.8 fallback local I-5 doit exister dans LEADBASE_SCHEMA_v1.md');
  assert.ok(src.includes('~/.charli/fallback'),
    'Le pattern ~/.charli/fallback doit être référencé');
});

// ─── Adapters non encore livrés (à livrer Bloc 2) ──────────────────────────

test('I-4 — sireneIngestion fallback INSEE direct : à livrer Bloc 2 (todo)', { todo: 'Bloc 2' }, () => {
  // Quand le pipeline sireneIngestion timer mensuel sera livré (Bloc 2),
  // ce test devra vérifier qu'en cas d'indispo OpenDataSoft, le fallback
  // api.insee.fr direct prend le relais.
});

test('I-4 — rneEnrichment fallback annuaire-entreprises HTML : à livrer Bloc 2 (todo)', { todo: 'Bloc 2' }, () => {
  // Quand le worker enrich-leadbase-continuous sera amendé pour I-4 (Bloc 2),
  // vérifier qu'en cas d'indispo recherche-entreprises.api.gouv.fr, le
  // fallback annuaire-entreprises.data.gouv.fr HTML prend le relais.
});
