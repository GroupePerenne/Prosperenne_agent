/**
 * Test intégration I-8 — Cache TTL obligatoire.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-8.
 * Cas d'origine : commit 6e93b03 (negativeCache Dropcontact bloquait
 * les retry sur des leads où email serait résolvable depuis).
 *
 * Vérifie :
 *   - Tout cache du codebase expose un TTL via env override.
 *   - TTL est strictement positif (pas de cache éternel).
 *   - Quand un cache distingue positif/négatif, le négatif < positif.
 *
 * Caches identifiés :
 *   1. dirigeants-rne : CACHE_TTL_DAYS (env DIRIGEANTS_CACHE_TTL_DAYS)
 *   2. lead-exhauster index : DEFAULT_CACHE_TTL_DAYS
 *   3. site-finder websitePatternsCache : TTL_VALIDATED_DAYS / TTL_UNVERIFIED_DAYS
 *   4. experiments registry : DEFAULT_CACHE_TTL_MS
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Cache 1 — dirigeants-rne ──────────────────────────────────────────────

test('I-8 — cache dirigeants-rne expose CACHE_TTL_DAYS > 0', () => {
  // Le module n'exporte pas la constante directement, mais le default est 30j.
  // On vérifie via l'env override.
  delete require.cache[require.resolve('../../../shared/enrichers/dirigeants-rne')];
  process.env.DIRIGEANTS_CACHE_TTL_DAYS = '15';
  // Le module re-lit l'env au require.
  // On valide juste que la constante par défaut est documentée dans le code source.
  const fs = require('fs');
  const src = fs.readFileSync(
    require.resolve('../../../shared/enrichers/dirigeants-rne'),
    'utf8',
  );
  assert.ok(
    src.includes('DIRIGEANTS_CACHE_TTL_DAYS'),
    'env DIRIGEANTS_CACHE_TTL_DAYS doit être documenté',
  );
  assert.ok(/CACHE_TTL_DAYS\s*=.*30/.test(src), 'défaut 30j doit être présent');
  delete process.env.DIRIGEANTS_CACHE_TTL_DAYS;
});

// ─── Cache 2 — lead-exhauster index ────────────────────────────────────────

test('I-8 — cache lead-exhauster expose DEFAULT_CACHE_TTL_DAYS > 0', () => {
  const idx = require('../../../shared/lead-exhauster/index');
  const ttl = idx._internals.DEFAULT_CACHE_TTL_DAYS;
  assert.equal(typeof ttl, 'number');
  assert.ok(ttl > 0, `DEFAULT_CACHE_TTL_DAYS = ${ttl}, doit être > 0`);
  assert.ok(ttl >= 30, `TTL ${ttl}j semble trop court pour cache positif (recommandé ≥ 30j)`);
});

// ─── Cache 3 — site-finder websitePatternsCache ────────────────────────────

test('I-8 — cache site-finder expose TTL_VALIDATED_DAYS et TTL_UNVERIFIED_DAYS', () => {
  const cache = require('../../../shared/site-finder/cache/websitePatternsCache');
  const { TTL_VALIDATED_DAYS, TTL_UNVERIFIED_DAYS } = cache._internals;
  assert.equal(typeof TTL_VALIDATED_DAYS, 'number');
  assert.equal(typeof TTL_UNVERIFIED_DAYS, 'number');
  assert.ok(TTL_VALIDATED_DAYS > 0);
  assert.ok(TTL_UNVERIFIED_DAYS > 0);
});

test('I-8 — site-finder TTL_UNVERIFIED < TTL_VALIDATED (négatif < positif)', () => {
  const cache = require('../../../shared/site-finder/cache/websitePatternsCache');
  const { TTL_VALIDATED_DAYS, TTL_UNVERIFIED_DAYS } = cache._internals;
  assert.ok(
    TTL_UNVERIFIED_DAYS < TTL_VALIDATED_DAYS,
    `unverified ${TTL_UNVERIFIED_DAYS}j ≥ validated ${TTL_VALIDATED_DAYS}j — viole I-8 négatif < positif`,
  );
});

// ─── Cache 4 — experiments registry ────────────────────────────────────────

test('I-8 — cache experiments expose DEFAULT_CACHE_TTL_MS > 0', () => {
  const reg = require('../../../shared/experiments/registry');
  assert.equal(typeof reg.DEFAULT_CACHE_TTL_MS, 'number');
  assert.ok(reg.DEFAULT_CACHE_TTL_MS > 0);
  // 5 min observé, raisonnable pour un cache court de config (refresh fréquent acceptable)
  assert.ok(reg.DEFAULT_CACHE_TTL_MS >= 60_000, 'TTL < 1 min trop agressif pour cache de config');
});

// ─── Anti-régression : pas de "cache éternel" en code ──────────────────────

test('I-8 — anti-régression : pas de Infinity ou Number.MAX_VALUE comme TTL', () => {
  const fs = require('fs');
  const path = require('path');
  const sharedDir = path.resolve(__dirname, '../../../shared');

  // Recherche brutale de patterns suspects.
  function* walkJs(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* walkJs(p);
      else if (e.name.endsWith('.js')) yield p;
    }
  }

  const violations = [];
  for (const file of walkJs(sharedDir)) {
    const src = fs.readFileSync(file, 'utf8');
    // patterns suspects sur des lignes contenant "TTL" ou "ttl" ou "expires"
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      const isTtlLine = /TTL|ttl|expires|cache/i.test(line);
      if (!isTtlLine) return;
      if (/=\s*(Infinity|Number\.MAX_VALUE|Number\.MAX_SAFE_INTEGER)\b/.test(line)) {
        violations.push(`${file}:${idx + 1} ${line.trim()}`);
      }
    });
  }
  assert.equal(violations.length, 0,
    `Caches éternels détectés (I-8 violation):\n${violations.join('\n')}`);
});
