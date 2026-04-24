/**
 * Tests — sources LinkedIn (company + profile) stubs V0.
 *
 * Vérifie la shape stable, la normalisation d'URL, et qu'aucun appel réseau
 * n'est effectué quel que soit le provider demandé.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchLinkedInCompany,
  normalizeLinkedInCompanyUrl,
  STUB_NOTE: COMPANY_NOTE,
} = require('../../../shared/prospect-research/sources/linkedinCompany');
const {
  fetchLinkedInProfile,
  normalizeLinkedInProfileUrl,
  STUB_NOTE: PROFILE_NOTE,
} = require('../../../shared/prospect-research/sources/linkedinProfile');

// ─── linkedinCompany ──────────────────────────────────────────────────────

test('normalizeLinkedInCompanyUrl — accepte /company et /school', () => {
  assert.equal(
    normalizeLinkedInCompanyUrl('https://www.linkedin.com/company/acme/'),
    'https://www.linkedin.com/company/acme',
  );
  assert.equal(
    normalizeLinkedInCompanyUrl('linkedin.com/school/hec-paris/'),
    'https://linkedin.com/school/hec-paris',
  );
});

test('normalizeLinkedInCompanyUrl — rejette hors LinkedIn ou hors company', () => {
  assert.equal(normalizeLinkedInCompanyUrl('https://example.com/company/x'), null);
  assert.equal(normalizeLinkedInCompanyUrl('https://www.linkedin.com/in/acme'), null);
  assert.equal(normalizeLinkedInCompanyUrl(''), null);
  assert.equal(normalizeLinkedInCompanyUrl(null), null);
  assert.equal(normalizeLinkedInCompanyUrl('not a url'), null);
});

test('fetchLinkedInCompany — stub, pas d\'appel réseau', async () => {
  const res = await fetchLinkedInCompany('https://www.linkedin.com/company/acme/');
  assert.equal(res.status, 'stub');
  assert.equal(res.company, null);
  assert.equal(res.provider, 'stub');
  assert.equal(typeof res.elapsedMs, 'number');
  assert.equal(res.note, COMPANY_NOTE);
  assert.equal(res.urlRequested, 'https://www.linkedin.com/company/acme');
});

test('fetchLinkedInCompany — provider override retourné tel quel', async () => {
  const res = await fetchLinkedInCompany('https://linkedin.com/company/x/', { provider: 'proxycurl' });
  assert.equal(res.provider, 'proxycurl');
  assert.equal(res.status, 'stub');
  assert.equal(res.company, null);
});

test('fetchLinkedInCompany — PROFILER_LINKEDIN_PROVIDER env respecté', async () => {
  const prev = process.env.PROFILER_LINKEDIN_PROVIDER;
  process.env.PROFILER_LINKEDIN_PROVIDER = 'apify';
  try {
    const res = await fetchLinkedInCompany('https://linkedin.com/company/x/');
    assert.equal(res.provider, 'apify');
  } finally {
    if (prev !== undefined) process.env.PROFILER_LINKEDIN_PROVIDER = prev;
    else delete process.env.PROFILER_LINKEDIN_PROVIDER;
  }
});

// ─── linkedinProfile ──────────────────────────────────────────────────────

test('normalizeLinkedInProfileUrl — accepte /in et /pub', () => {
  assert.equal(
    normalizeLinkedInProfileUrl('https://www.linkedin.com/in/prenom-nom/'),
    'https://www.linkedin.com/in/prenom-nom',
  );
  assert.equal(
    normalizeLinkedInProfileUrl('linkedin.com/pub/prenom-nom/1/2/3'),
    'https://linkedin.com/pub/prenom-nom/1/2/3',
  );
});

test('normalizeLinkedInProfileUrl — rejette hors profil', () => {
  assert.equal(normalizeLinkedInProfileUrl('https://www.linkedin.com/company/acme'), null);
  assert.equal(normalizeLinkedInProfileUrl('https://example.com/in/x'), null);
  assert.equal(normalizeLinkedInProfileUrl(''), null);
  assert.equal(normalizeLinkedInProfileUrl(null), null);
});

test('fetchLinkedInProfile — stub, pas d\'appel réseau', async () => {
  const res = await fetchLinkedInProfile('https://www.linkedin.com/in/prenom-nom/');
  assert.equal(res.status, 'stub');
  assert.equal(res.profile, null);
  assert.equal(res.provider, 'stub');
  assert.equal(typeof res.elapsedMs, 'number');
  assert.equal(res.note, PROFILE_NOTE);
  assert.equal(res.urlRequested, 'https://www.linkedin.com/in/prenom-nom');
});
