/**
 * Lint statique — détecte les contournements des invariants I-1, I-2, I-9, I-10
 * sur les opérations LeadBase.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4.
 *
 * Cas d'origine : 7 mai 2026 PM, post-Bloc 4, j'ai trouvé un trou dans
 * src/functions/nightlyMonteCarloSmoke.js (listEntities sans filter
 * discriminant). Mes propres helpers safe-* étaient bypassés en silence.
 * Sans ce lint, un futur dev pourrait reproduire ce pattern.
 *
 * Stratégie :
 *   - Grep dans le code source (hors node_modules, hors tests) :
 *     * `client.listEntities(` non précédé d'une whitelist OU d'un commentaire
 *       `// I-2 OK:` dans les lignes proches → violation candidate.
 *     * `updateEntity` / `createEntity` / `upsertEntity` sur un fichier qui
 *       touche LeadBase et n'est pas whitelisté ni commenté.
 *   - Whitelist explicite des fichiers légitimes (helpers safe-* + writer
 *     SIRENE Couche 1 + audit prod, etc.).
 *   - Faux positifs tolérés sur autres tables (LeadContacts, etc.) — le
 *     lint reste ciblé LeadBase via présence du token 'LeadBase' dans le
 *     fichier.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Fichiers autorisés à utiliser TableClient direct sur LeadBase / LeadContacts
// sans helper :
// - les helpers safe-* eux-mêmes (le helper est l'autorité d'appel)
// - le writer Couche 1 SIRENE qui crée les entrées (seule couche autorisée I-1)
// - le script audit prod qui a un design "scan complet" légitime
// - les anciens scripts archive (à terme à supprimer mais pas dans ce sprint)
// - le module trace lead-exhauster qui est le writer Couche 4 LeadContacts
//   officiel (équivalent de shared/sirene/writer.js pour la Couche 4).
const WHITELIST_FILES = new Set([
  'shared/leadbase/safe-read.js',
  'shared/leadbase/safe-write.js',
  'shared/leadbase/migrate-capital-scrape.js', // utilise safeMergeCoucheN
  'shared/leadbase/migrate-leadcontacts.js', // helpers pure functions, pas de client
  'shared/leadbase/integrity-audit.js', // pure helpers (pas de client)
  'shared/sirene/writer.js', // Couche 1 SIRENE — seule autorisée à create
  'shared/adapters/leadbase/leadbase-table.js', // buildFilter pose schema_version
  'shared/lead-exhauster/trace.js', // writer Couche 4 LeadContacts officiel
  'scripts/audit-leadbase-integrity.js', // audit complet legitime (allowEmptyFilter via design)
  'scripts/migrate-leadbase-storage.js', // legacy archivé (oseysjeannot → pereneoleads)
  'scripts/sirene-bulk-import.js', // utilise writer SIRENE Couche 1
]);

// Tables couvertes par le lint. LeadContacts est la table Couche 4 Email v1
// refondue, soumise aux mêmes invariants schema_version + leadBaseSchemaVersion
// + audit *At (cf. LEADBASE_SCHEMA_v1.md §8).
const COVERED_TABLES = ['LeadBase', 'LeadContacts'];

// Patterns sensibles avec leur invariant correspondant
const PATTERNS = [
  {
    regex: /client\.listEntities\s*\(/g,
    invariant: 'I-2',
    desc: 'listEntities sans filter discriminant',
  },
  {
    regex: /\.listEntities\s*\(\s*\{?\s*queryOptions/g,
    invariant: 'I-2',
    desc: 'tableClient.listEntities direct',
  },
  {
    regex: /client\.updateEntity\s*\(/g,
    invariant: 'I-1/I-9/I-10',
    desc: 'updateEntity sans safeMergeCoucheN',
  },
  {
    regex: /client\.createEntity\s*\(/g,
    invariant: 'I-1',
    desc: 'createEntity sur LeadBase Couche 2-5 interdit',
  },
];

// Walk récursif des .js (hors node_modules, hors tests)
function* walkJs(dir, base = dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '_archive') continue;
    if (e.name === 'tests') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJs(full, base);
    } else if (e.name.endsWith('.js')) {
      yield path.relative(base, full);
    }
  }
}

// Vérifie si une ligne `idx` a un commentaire bypass valide dans les 5 lignes
// précédentes ou la même ligne (commentaire inline).
function hasBypassComment(lines, idx, invariant) {
  const tokens = invariant.split('/').map((i) => `// ${i} OK`); // ex. ["// I-1 OK", "// I-9 OK", "// I-10 OK"]
  for (let i = Math.max(0, idx - 5); i <= idx; i++) {
    const line = lines[i];
    if (tokens.some((t) => line.includes(t))) return true;
  }
  return false;
}

test('lint I-* — pas de contournement TableClient sur LeadBase hors whitelist/bypass', () => {
  const violations = [];

  for (const relPath of walkJs(REPO_ROOT)) {
    const normalized = relPath.replace(/\\/g, '/');
    if (WHITELIST_FILES.has(normalized)) continue;

    const fullPath = path.join(REPO_ROOT, normalized);
    let src;
    try { src = fs.readFileSync(fullPath, 'utf8'); } catch { continue; }

    // Cible les fichiers qui touchent LeadBase ou LeadContacts (Couche 4
    // refondue v1). Faux positifs tolérés sur LeadSelectorTrace, dailyMetrics,
    // EmailPatterns, etc. — pas de discriminant invariant sur ces tables.
    const touchesCovered = COVERED_TABLES.some(
      (t) => src.includes(`'${t}'`) || src.includes(`"${t}"`),
    );
    if (!touchesCovered) continue;

    const lines = src.split('\n');

    for (const pattern of PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;
      lines.forEach((line, idx) => {
        if (pattern.regex.test(line)) {
          if (!hasBypassComment(lines, idx, pattern.invariant)) {
            violations.push(
              `${normalized}:${idx + 1} [${pattern.invariant}] ${pattern.desc} — `
              + `whitelistez le fichier ou ajoutez un commentaire "// ${pattern.invariant.split('/')[0]} OK: <raison>" `
              + `dans les 5 lignes précédentes.\n  Ligne: ${line.trim()}`,
            );
          }
        }
        pattern.regex.lastIndex = 0;
      });
    }
  }

  assert.equal(
    violations.length,
    0,
    `\n\nContournements d'invariants détectés (${violations.length}) :\n\n`
    + violations.map((v, i) => `${i + 1}. ${v}`).join('\n\n')
    + '\n\nDoctrine : LEADBASE_LESSONS_v1.md §4. Helpers : shared/leadbase/safe-*.js',
  );
});

test('lint — whitelist contient les fichiers attendus (anti-régression doctrine)', () => {
  // Si un fichier whitelisté est supprimé/renommé, la whitelist devient menteuse.
  // On vérifie que tous les fichiers whitelistés existent encore.
  for (const f of WHITELIST_FILES) {
    const full = path.join(REPO_ROOT, f);
    assert.ok(
      fs.existsSync(full),
      `Fichier whitelisté absent : ${f} — supprimer de la whitelist ou restaurer le fichier`,
    );
  }
});
