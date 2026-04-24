/**
 * Tests unitaires — scripts/exhauster-smoke.js (parsing --sirens).
 *
 * Couvre :
 *   - parseArgs : drapeaux + --sirens <path>
 *   - loadSirensFromFile : fichier absent, JSON invalide, shape correcte
 *   - convertSampleToSmokeCase : mapping Paul → SmokeCase
 *   - resolveSmokeCases : fallback hardcoded vs override fichier
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  loadSirensFromFile,
  convertSampleToSmokeCase,
  resolveSmokeCases,
  DEFAULT_SMOKE_CASES,
} = require('../../../scripts/exhauster-smoke');

// ─── Helpers fichier temp ─────────────────────────────────────────────────

function writeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
  const p = path.join(dir, 'sample.json');
  fs.writeFileSync(p, content);
  return p;
}

// ─── parseArgs ────────────────────────────────────────────────────────────

test('parseArgs — --dry-run seul', () => {
  const a = parseArgs(['node', 'script', '--dry-run']);
  assert.equal(a.dryRun, true);
  assert.equal(a.real, false);
  assert.equal(a.sirensPath, null);
});

test('parseArgs — --real --yes --sirens path', () => {
  const a = parseArgs(['node', 'script', '--real', '--yes', '--sirens', '/tmp/s.json']);
  assert.equal(a.real, true);
  assert.equal(a.confirmed, true);
  assert.equal(a.sirensPath, '/tmp/s.json');
});

test('parseArgs — --sirens sans valeur → undefined (pas de crash)', () => {
  const a = parseArgs(['node', 'script', '--dry-run', '--sirens']);
  assert.equal(a.sirensPath, undefined);
});

// ─── loadSirensFromFile ──────────────────────────────────────────────────

test('loadSirensFromFile — fichier absent → throw', () => {
  assert.throws(
    () => loadSirensFromFile('/tmp/does-not-exist-smoke-test.json'),
    /introuvable/i,
  );
});

test('loadSirensFromFile — path vide → throw', () => {
  assert.throws(() => loadSirensFromFile(''), /path requis/i);
  assert.throws(() => loadSirensFromFile(null), /path requis/i);
});

test('loadSirensFromFile — JSON invalide → throw', () => {
  const p = writeTmpFile('{ not valid json');
  assert.throws(() => loadSirensFromFile(p), /JSON invalide/i);
});

test('loadSirensFromFile — racine pas array → throw', () => {
  const p = writeTmpFile('{"siren":"123456789"}');
  assert.throws(() => loadSirensFromFile(p), /racine doit être un array/i);
});

test('loadSirensFromFile — array vide → throw', () => {
  const p = writeTmpFile('[]');
  assert.throws(() => loadSirensFromFile(p), /array vide/i);
});

test('loadSirensFromFile — siren invalide → throw', () => {
  const p = writeTmpFile(JSON.stringify([
    { siren: 'abc', denom: 'x', dirigeant: { prenom: 'a', nom: 'b' } },
  ]));
  assert.throws(() => loadSirensFromFile(p), /siren manquant ou invalide/i);
});

test('loadSirensFromFile — dirigeant manquant → throw', () => {
  const p = writeTmpFile(JSON.stringify([
    { siren: '123456789', denom: 'x' },
  ]));
  assert.throws(() => loadSirensFromFile(p), /dirigeant/i);
});

test('loadSirensFromFile — shape correcte → retourne array', () => {
  const p = writeTmpFile(JSON.stringify([
    {
      siren: '123456789',
      denom: 'Acme SAS',
      naf: '62.02A',
      trancheEffectif: '11',
      dirigeant: { prenom: 'Jean', nom: 'Dupont', fonction: '73' },
    },
  ]));
  const out = loadSirensFromFile(p);
  assert.equal(out.length, 1);
  assert.equal(out[0].siren, '123456789');
  assert.equal(out[0].dirigeant.prenom, 'Jean');
});

test('loadSirensFromFile — charge le fichier sample livré dans le repo', () => {
  const samplePath = path.join(__dirname, '../../../scripts/smoke-sirens-sample.json');
  const out = loadSirensFromFile(samplePath);
  assert.equal(out.length, 5);
  for (const e of out) {
    assert.ok(/^\d{9}$/.test(e.siren), `siren ${e.siren} invalide`);
    assert.ok(e.dirigeant && e.dirigeant.prenom && e.dirigeant.nom);
  }
});

// ─── convertSampleToSmokeCase ────────────────────────────────────────────

test('convertSampleToSmokeCase — mapping complet', () => {
  const sc = convertSampleToSmokeCase({
    siren: '384989208',
    denom: 'COMPAGNIE PHOCEENNE',
    naf: '62.02A',
    trancheEffectif: '03',
    ville: 'MARSEILLE',
    siteWeb: 'https://example.fr',
    dirigeant: { prenom: 'Jean Francois', nom: 'PAPAZIAN', fonction: '73' },
  });
  assert.equal(sc.input.siren, '384989208');
  assert.equal(sc.input.companyName, 'COMPAGNIE PHOCEENNE');
  assert.equal(sc.input.firstName, 'Jean Francois');
  assert.equal(sc.input.lastName, 'PAPAZIAN');
  assert.equal(sc.input.companyDomain, 'https://example.fr');
  assert.equal(sc.input.inseeRole, '73');
  assert.equal(sc.input.beneficiaryId, 'smoke-sample');
  assert.equal(sc.input.trancheEffectif, '03');
  assert.deepEqual(sc.expectStatusDry, ['ok', 'unresolvable']);
  assert.ok(sc.name.includes('COMPAGNIE PHOCEENNE'));
  assert.ok(sc.name.includes('62.02A'));
});

test('convertSampleToSmokeCase — siteWeb null → pas de companyDomain', () => {
  const sc = convertSampleToSmokeCase({
    siren: '123456789',
    denom: 'Test',
    dirigeant: { prenom: 'J', nom: 'D' },
    siteWeb: null,
  });
  assert.equal(sc.input.companyDomain, undefined);
});

// ─── resolveSmokeCases ────────────────────────────────────────────────────

test('resolveSmokeCases — sans sirensPath → hardcoded fallback', () => {
  const r = resolveSmokeCases({ sirensPath: null });
  assert.equal(r.source, 'hardcoded');
  assert.deepEqual(r.cases, DEFAULT_SMOKE_CASES);
});

test('resolveSmokeCases — avec sirensPath → override', () => {
  const samplePath = path.join(__dirname, '../../../scripts/smoke-sirens-sample.json');
  const r = resolveSmokeCases({ sirensPath: samplePath });
  assert.ok(r.source.startsWith('file:'));
  assert.equal(r.cases.length, 5);
  // Check que la structure est bien un SmokeCase (input + expectStatusDry)
  for (const c of r.cases) {
    assert.ok(c.input && c.input.siren);
    assert.ok(Array.isArray(c.expectStatusDry));
  }
});
