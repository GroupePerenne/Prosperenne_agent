/**
 * Tests fallback multi-source I-4 sur shared/sirene/downloader.
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-4.
 *
 * Cas d'origine : OpenDataSoft 503 ou timeout transitoire ne doit pas
 * bloquer l'ingestion mensuelle. Si un snapshot local récent existe
 * (< TTL 35j), on l'utilise comme fallback (donnée potentiellement
 * obsolète mais disponible — V capital permanent > qualité fraîche).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  findRecentSnapshot,
  downloadDepartementWithFallback,
} = require('../../../shared/sirene/downloader');

// ─── Setup tmpdir isolé ─────────────────────────────────────────────────────

let tmpDir;
const ORIGINAL_SNAPSHOT_DIR = process.env.SIRENE_SNAPSHOT_DIR;

function setupTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sirene-fallback-test-'));
  process.env.SIRENE_SNAPSHOT_DIR = tmpDir;
}

function teardownTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (ORIGINAL_SNAPSHOT_DIR === undefined) {
    delete process.env.SIRENE_SNAPSHOT_DIR;
  } else {
    process.env.SIRENE_SNAPSHOT_DIR = ORIGINAL_SNAPSHOT_DIR;
  }
}

function writeSnapshot(departement, dateStr, bytes = 5000) {
  const fp = path.join(tmpDir, `sirene-${departement}-${dateStr}.csv`);
  fs.writeFileSync(fp, 'x'.repeat(bytes));
  return fp;
}

function dateStrDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ─── findRecentSnapshot ────────────────────────────────────────────────────

test('findRecentSnapshot — répertoire absent retourne null', () => {
  process.env.SIRENE_SNAPSHOT_DIR = '/tmp/__inexistant_snapshot_dir__';
  const r = findRecentSnapshot({ departement: '75' });
  assert.equal(r, null);
});

test('findRecentSnapshot — snapshot du jour trouvé', () => {
  setupTmpDir();
  try {
    const fp = writeSnapshot('75', dateStrDaysAgo(0));
    const r = findRecentSnapshot({ departement: '75' });
    assert.ok(r);
    assert.equal(r.path, fp);
    assert.ok(r.ageDays === 0 || r.ageDays === 1);
  } finally {
    teardownTmpDir();
  }
});

test('findRecentSnapshot — snapshot 30j ago : in TTL 35j', () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(30));
    const r = findRecentSnapshot({ departement: '75', ttlDays: 35 });
    assert.ok(r);
    assert.ok(r.ageDays >= 29 && r.ageDays <= 31);
  } finally {
    teardownTmpDir();
  }
});

test('findRecentSnapshot — snapshot 40j ago : hors TTL 35j → null', () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(40));
    const r = findRecentSnapshot({ departement: '75', ttlDays: 35 });
    assert.equal(r, null);
  } finally {
    teardownTmpDir();
  }
});

test('findRecentSnapshot — multi-snapshots : retourne le plus récent', () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(20));
    const fp10 = writeSnapshot('75', dateStrDaysAgo(10));
    writeSnapshot('75', dateStrDaysAgo(30));
    const r = findRecentSnapshot({ departement: '75', ttlDays: 35 });
    assert.equal(r.path, fp10);
  } finally {
    teardownTmpDir();
  }
});

test('findRecentSnapshot — département différent ignoré', () => {
  setupTmpDir();
  try {
    writeSnapshot('13', dateStrDaysAgo(5));
    const r = findRecentSnapshot({ departement: '75' });
    assert.equal(r, null);
  } finally {
    teardownTmpDir();
  }
});

test('findRecentSnapshot — snapshot trop petit (< 100 bytes) ignoré', () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(5), 50);
    const r = findRecentSnapshot({ departement: '75' });
    assert.equal(r, null);
  } finally {
    teardownTmpDir();
  }
});

// ─── downloadDepartementWithFallback ───────────────────────────────────────

test('I-4 fallback — download OK : pas de fallback', async () => {
  setupTmpDir();
  try {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => 'siren;a;b\n552081317;x;y',
    });
    const result = await downloadDepartementWithFallback({
      departement: '75',
      trancheLabels: ['10 à 19 salariés'],
      force: true,
      fetchImpl: fakeFetch,
    });
    assert.equal(result.downloaded, true);
    assert.notEqual(result.fallbackUsed, true);
  } finally {
    teardownTmpDir();
  }
});

test('I-4 fallback — download 503 + snapshot récent : fallback s active', async () => {
  setupTmpDir();
  try {
    // Pose un snapshot local de 5 jours
    const fpFallback = writeSnapshot('75', dateStrDaysAgo(5));

    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    });

    const result = await downloadDepartementWithFallback({
      departement: '75',
      trancheLabels: ['10 à 19 salariés'],
      force: true,
      fetchImpl: fakeFetch,
    });
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.path, fpFallback);
    assert.ok(typeof result.fallbackAgeDays === 'number');
    assert.ok(typeof result.fallbackReason === 'string');
    assert.ok(result.fallbackReason.includes('503'));
  } finally {
    teardownTmpDir();
  }
});

test('I-4 fallback — download timeout + snapshot récent : fallback s active', async () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(2));

    const fakeFetch = async () => {
      const e = new Error('timeout');
      e.name = 'AbortError';
      throw e;
    };

    const result = await downloadDepartementWithFallback({
      departement: '75',
      trancheLabels: ['10 à 19 salariés'],
      force: true,
      fetchImpl: fakeFetch,
    });
    assert.equal(result.fallbackUsed, true);
  } finally {
    teardownTmpDir();
  }
});

test('I-4 fallback — download fail + pas de snapshot : remonte l erreur', async () => {
  setupTmpDir();
  try {
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    });

    await assert.rejects(
      downloadDepartementWithFallback({
        departement: '75',
        trancheLabels: ['10 à 19 salariés'],
        force: true,
        fetchImpl: fakeFetch,
      }),
      /503/,
    );
  } finally {
    teardownTmpDir();
  }
});

test('I-4 fallback — download fail + snapshot trop vieux (>35j) : remonte erreur', async () => {
  setupTmpDir();
  try {
    writeSnapshot('75', dateStrDaysAgo(40));

    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    });

    await assert.rejects(
      downloadDepartementWithFallback({
        departement: '75',
        trancheLabels: ['10 à 19 salariés'],
        force: true,
        fetchImpl: fakeFetch,
      }),
      /503/,
    );
  } finally {
    teardownTmpDir();
  }
});
