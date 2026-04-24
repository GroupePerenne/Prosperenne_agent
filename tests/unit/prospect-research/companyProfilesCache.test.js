/**
 * Tests — shared/prospect-research/cache/companyProfilesCache.js
 *
 * Couvre uniquement la logique pure (ISO week, sanitization siren) et la
 * dégradation silencieuse quand AzureWebJobsStorage absent. Les scénarios
 * Azure Table réels sont hors scope unit (couverts en intégration manuelle).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getCachedCompanyProfile,
  setCachedCompanyProfile,
  isoWeekYear,
  TABLE_NAME,
  CACHE_VERSION,
  _resetForTests,
} = require('../../../shared/prospect-research/cache/companyProfilesCache');

test('isoWeekYear — ISO 8601 correct', () => {
  // 1er janvier 2026 est un jeudi → semaine 1
  assert.equal(isoWeekYear(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  // 28 décembre 2026 : lundi → semaine 53
  assert.equal(isoWeekYear(new Date('2026-12-28T12:00:00Z')), '2026-W53');
  // 3 janvier 2027 : dimanche → toujours semaine 53 de 2026 (ISO)
  assert.equal(isoWeekYear(new Date('2027-01-03T12:00:00Z')), '2026-W53');
});

test('TABLE_NAME et CACHE_VERSION exposés', () => {
  assert.equal(typeof TABLE_NAME, 'string');
  assert.ok(TABLE_NAME.length > 0);
  assert.equal(CACHE_VERSION, 'v0');
});

test('getCachedCompanyProfile — sans AzureWebJobsStorage retourne null', async () => {
  const prev = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  _resetForTests();
  try {
    const res = await getCachedCompanyProfile('123456789');
    assert.equal(res, null);
  } finally {
    if (prev !== undefined) process.env.AzureWebJobsStorage = prev;
    _resetForTests();
  }
});

test('setCachedCompanyProfile — sans AzureWebJobsStorage retourne false', async () => {
  const prev = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  _resetForTests();
  try {
    const res = await setCachedCompanyProfile('123456789', { activity: 'x' });
    assert.equal(res, false);
  } finally {
    if (prev !== undefined) process.env.AzureWebJobsStorage = prev;
    _resetForTests();
  }
});

test('getCachedCompanyProfile — siren invalide retourne null', async () => {
  const prev = process.env.AzureWebJobsStorage;
  // Valeur bidon — suffisante pour créer le client ; les tests d'intégration
  // vérifient les 404 réels. Ici on vérifie juste le garde-fou sanitization.
  process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
  _resetForTests();
  try {
    assert.equal(await getCachedCompanyProfile('abc'), null);
    assert.equal(await getCachedCompanyProfile(''), null);
    assert.equal(await getCachedCompanyProfile(null), null);
    assert.equal(await getCachedCompanyProfile('12345'), null);
  } finally {
    if (prev !== undefined) process.env.AzureWebJobsStorage = prev;
    else delete process.env.AzureWebJobsStorage;
    _resetForTests();
  }
});

test('setCachedCompanyProfile — profile null retourne false', async () => {
  const prev = process.env.AzureWebJobsStorage;
  process.env.AzureWebJobsStorage = 'UseDevelopmentStorage=true';
  _resetForTests();
  try {
    assert.equal(await setCachedCompanyProfile('123456789', null), false);
    assert.equal(await setCachedCompanyProfile('123456789', undefined), false);
  } finally {
    if (prev !== undefined) process.env.AzureWebJobsStorage = prev;
    else delete process.env.AzureWebJobsStorage;
    _resetForTests();
  }
});
