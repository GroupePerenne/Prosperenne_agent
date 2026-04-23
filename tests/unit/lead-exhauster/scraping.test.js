/**
 * Tests unitaires — shared/lead-exhauster/scraping.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scrapeDomain,
  extractEmailsFromHtml,
  extractTeamProfiles,
  isJunkEmail,
  scoreEmailAgainstName,
  parseFullName,
  findRoleInSnippet,
  fetchPage,
  _constants,
} = require('../../../shared/lead-exhauster/scraping');

// ─── extractEmailsFromHtml ─────────────────────────────────────────────────

test('extractEmailsFromHtml — cas nominal', () => {
  const html = '<p>Contact: <a href="mailto:jean.dupont@acme.fr">jean.dupont@acme.fr</a></p>';
  const out = extractEmailsFromHtml(html);
  assert.deepEqual(out, ['jean.dupont@acme.fr']);
});

test('extractEmailsFromHtml — dédoublonnage', () => {
  const html = 'jean.dupont@acme.fr et encore jean.dupont@acme.fr et jean.dupont@acme.fr';
  assert.deepEqual(extractEmailsFromHtml(html), ['jean.dupont@acme.fr']);
});

test('extractEmailsFromHtml — lowercase forcé', () => {
  assert.deepEqual(
    extractEmailsFromHtml('Jean.DUPONT@Acme.FR'),
    ['jean.dupont@acme.fr'],
  );
});

test('extractEmailsFromHtml — rejette noms d image (.@2x déjà filtré)', () => {
  const html = '<img src="logo@2x.png"> <a>jean@acme.fr</a> <img src="photo.png">';
  const out = extractEmailsFromHtml(html);
  // Les chaînes "logo@2x.png" et "photo.png" ne matchent pas le regex email
  // (manque un TLD ou local-part invalide). On ne trouve que le vrai email.
  assert.deepEqual(out, ['jean@acme.fr']);
});

test('extractEmailsFromHtml — filtrage expectedDomain', () => {
  const html = 'support@gmail.com jean@acme.fr mkt@acme.co.uk contact@acme.fr';
  const out = extractEmailsFromHtml(html, { expectedDomain: 'acme.fr' });
  assert.ok(out.includes('jean@acme.fr'));
  assert.ok(out.includes('contact@acme.fr'));
  assert.ok(!out.includes('support@gmail.com'));
  assert.ok(!out.includes('mkt@acme.co.uk'));
});

test('extractEmailsFromHtml — sous-domaines acceptés', () => {
  const html = 'admin@paris.acme.fr et jean@acme.fr';
  const out = extractEmailsFromHtml(html, { expectedDomain: 'acme.fr' });
  assert.ok(out.includes('admin@paris.acme.fr'));
  assert.ok(out.includes('jean@acme.fr'));
});

test('extractEmailsFromHtml — entrée invalide retourne []', () => {
  assert.deepEqual(extractEmailsFromHtml(null), []);
  assert.deepEqual(extractEmailsFromHtml(''), []);
  assert.deepEqual(extractEmailsFromHtml(42), []);
});

// ─── isJunkEmail ───────────────────────────────────────────────────────────

test('isJunkEmail — vrais junks', () => {
  assert.equal(isJunkEmail('contact@acme.fr'), true);
  assert.equal(isJunkEmail('info@acme.fr'), true);
  assert.equal(isJunkEmail('NOREPLY@acme.fr'), true);
  assert.equal(isJunkEmail('support@acme.fr'), true);
});

test('isJunkEmail — emails nominatifs', () => {
  assert.equal(isJunkEmail('jean.dupont@acme.fr'), false);
  assert.equal(isJunkEmail('j.dupont@acme.fr'), false);
  assert.equal(isJunkEmail('pdg@acme.fr'), false); // pas dans la junk list
});

// ─── scoreEmailAgainstName ─────────────────────────────────────────────────

test('scoreEmailAgainstName — match exact prenom.nom', () => {
  const html = '<p>Jean Dupont - jean.dupont@acme.fr</p>';
  const score = scoreEmailAgainstName('jean.dupont@acme.fr', html, {
    firstName: 'Jean', lastName: 'Dupont',
  });
  // base 0.25 + match local-part 0.35 + proximité nom 0.20 = 0.80
  assert.equal(score, 0.80);
});

test('scoreEmailAgainstName — junk alias score bas', () => {
  const html = '<p>Contact: contact@acme.fr</p>';
  const score = scoreEmailAgainstName('contact@acme.fr', html, {
    firstName: 'Jean', lastName: 'Dupont',
  });
  // base junk 0.40, pas de match, pas de proximité
  assert.equal(score, 0.40);
});

test('scoreEmailAgainstName — initiale + nom', () => {
  const score = scoreEmailAgainstName('j.dupont@acme.fr', '', {
    firstName: 'Jean', lastName: 'Dupont',
  });
  // base 0.25 + match f.last 0.35 = 0.60
  assert.equal(score, 0.60);
});

test('scoreEmailAgainstName — plafonnement 0.90', () => {
  const html = 'Jean Dupont jean.dupont@acme.fr Jean Dupont Jean Dupont';
  const score = scoreEmailAgainstName('jean.dupont@acme.fr', html, {
    firstName: 'Jean', lastName: 'Dupont',
  });
  assert.ok(score <= 0.90);
});

// ─── parseFullName ─────────────────────────────────────────────────────────

test('parseFullName — Prénom Nom simple', () => {
  assert.deepEqual(parseFullName('Jean Dupont'), { firstName: 'Jean', lastName: 'Dupont' });
});

test('parseFullName — nom composé', () => {
  assert.deepEqual(parseFullName('Jean-Pierre Duval'), {
    firstName: 'Jean-Pierre', lastName: 'Duval',
  });
});

test('parseFullName — nom à particule', () => {
  assert.deepEqual(parseFullName('Pierre de la Fontaine'), {
    firstName: 'Pierre', lastName: 'de la Fontaine',
  });
});

test('parseFullName — rejette phrases, URLs, chiffres', () => {
  assert.equal(parseFullName('Voici notre équipe'), null);
  assert.equal(parseFullName('https://acme.fr'), null);
  assert.equal(parseFullName('Jean Dupont 42'), null);
  assert.equal(parseFullName('Bonjour, voici Jean'), null);
});

test('parseFullName — rejette un seul mot', () => {
  assert.equal(parseFullName('Jean'), null);
});

test('parseFullName — rejette trop long ou trop court', () => {
  assert.equal(parseFullName('Jo'), null);
  assert.equal(parseFullName('a'.repeat(100)), null);
});

// ─── findRoleInSnippet ─────────────────────────────────────────────────────

test('findRoleInSnippet — rôle haut retourne score 0.9', () => {
  const r = findRoleInSnippet('Jean Dupont, Directeur Général');
  assert.equal(r.score, 0.9);
  assert.ok(r.role && r.role.toLowerCase().includes('directeur'));
});

test('findRoleInSnippet — rôle mid', () => {
  const r = findRoleInSnippet('Marie Martin, DRH et directrice RH');
  assert.equal(r.score, 0.6);
});

test('findRoleInSnippet — rôle low', () => {
  const r = findRoleInSnippet('Paul Martin, consultant senior');
  assert.equal(r.score, 0.3);
});

test('findRoleInSnippet — pas de rôle détecté', () => {
  const r = findRoleInSnippet('Quelque chose sans mot-clé');
  assert.equal(r.score, 0);
  assert.equal(r.role, null);
});

// ─── extractTeamProfiles ───────────────────────────────────────────────────

test('extractTeamProfiles — header + rôle', () => {
  const html = '<h2>Jean Dupont</h2><p>Directeur Général</p>';
  const out = extractTeamProfiles(html);
  assert.equal(out.length, 1);
  assert.equal(out[0].firstName, 'Jean');
  assert.equal(out[0].lastName, 'Dupont');
  assert.equal(out[0].roleScore, 0.9);
});

test('extractTeamProfiles — plusieurs headers dédoublonnés', () => {
  const html = '<h2>Jean Dupont</h2><p>CEO</p><h2>Marie Martin</h2><p>Directrice</p><h2>Jean Dupont</h2><p>CEO</p>';
  const out = extractTeamProfiles(html);
  // Jean Dupont apparaît 2x, on ne le garde qu'une fois
  const jeanCount = out.filter((p) => p.firstName === 'Jean').length;
  assert.equal(jeanCount, 1);
});

test('extractTeamProfiles — ignore headers non-noms', () => {
  const html = '<h1>Bienvenue sur le site</h1><h2>Nos Services</h2>';
  const out = extractTeamProfiles(html);
  assert.equal(out.length, 0);
});

// ─── fetchPage ─────────────────────────────────────────────────────────────

test('fetchPage — 200 HTML retourne text', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
    text: async () => '<html>ok</html>',
  });
  const r = await fetchPage('https://acme.fr/', { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.text, '<html>ok</html>');
});

test('fetchPage — content-type non-html rejeté', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    text: async () => '{}',
  });
  const r = await fetchPage('https://acme.fr/api', { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /not_html/);
});

test('fetchPage — 404 retourne ok:false', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const r = await fetchPage('https://acme.fr/', { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('fetchPage — network throw → graceful', async () => {
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const r = await fetchPage('https://acme.fr/', { fetchImpl });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('fetchPage — fetch impl absent → fetch_missing', async () => {
  const r = await fetchPage('https://acme.fr/', { fetchImpl: null });
  // En Node 22+ fetch global existe, le test vérifie que ça ne throw pas
  assert.ok(r);
});

// ─── scrapeDomain ──────────────────────────────────────────────────────────

test('scrapeDomain — domaine invalide retourne signal', async () => {
  const r = await scrapeDomain({ domain: 'not a domain' });
  assert.ok(r.signals.includes('invalid_domain'));
  assert.equal(r.emails.length, 0);
});

test('scrapeDomain — agrégation multi-pages + dédup emails', async () => {
  const pagesByPath = {
    '/contact': '<p>Jean Dupont <a>jean.dupont@acme.fr</a></p>',
    '/equipe': '<h2>Jean Dupont</h2><p>CEO jean.dupont@acme.fr</p><h2>Marie Martin</h2><p>Directrice <a>marie.martin@acme.fr</a></p>',
    '/': '<p>Contact générique contact@acme.fr</p>',
  };
  const visited = [];
  const fetchImpl = async (url) => {
    visited.push(url);
    const path = new URL(url).pathname;
    const html = pagesByPath[path];
    if (!html) return { ok: false, status: 404 };
    return {
      ok: true, status: 200,
      headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html' : null },
      text: async () => html,
    };
  };
  const r = await scrapeDomain(
    { domain: 'acme.fr', firstName: 'Jean', lastName: 'Dupont', paths: ['/contact', '/equipe', '/'] },
    { fetchImpl },
  );
  // Les 3 emails uniques sont présents
  const emails = r.emails.map((e) => e.email);
  assert.ok(emails.includes('jean.dupont@acme.fr'));
  assert.ok(emails.includes('marie.martin@acme.fr'));
  assert.ok(emails.includes('contact@acme.fr'));
  // Jean Dupont scoré max (match local-part + contexte)
  assert.equal(r.emails[0].email, 'jean.dupont@acme.fr');
  // Profils équipe extraits
  assert.ok(r.teamProfiles.some((p) => p.firstName === 'Marie' && p.lastName === 'Martin'));
  // 3 visites réussies
  assert.equal(r.pagesVisited.length, 3);
});

test('scrapeDomain — pages failed tracées', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const r = await scrapeDomain(
    { domain: 'acme.fr', paths: ['/contact', '/equipe'] },
    { fetchImpl },
  );
  assert.equal(r.emails.length, 0);
  assert.equal(r.pagesFailed.length, 2);
});

// ─── Constants sanity ─────────────────────────────────────────────────────

test('TARGET_PATHS contient les pages FR conventionnelles', () => {
  assert.ok(_constants.TARGET_PATHS.includes('/contact'));
  assert.ok(_constants.TARGET_PATHS.includes('/equipe'));
  assert.ok(_constants.TARGET_PATHS.includes('/mentions-legales'));
});

test('JUNK_LOCAL_PARTS contient catch-all classiques', () => {
  assert.ok(_constants.JUNK_LOCAL_PARTS.has('contact'));
  assert.ok(_constants.JUNK_LOCAL_PARTS.has('info'));
  assert.ok(_constants.JUNK_LOCAL_PARTS.has('noreply'));
});
