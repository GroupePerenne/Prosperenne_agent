'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  looksBlocked,
  extractResults,
  _internals,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/_genericHtmlExtractor');

// ─── looksBlocked ─────────────────────────────────────────────────────────

test('looksBlocked — Cloudflare "just a moment" → true', () => {
  assert.equal(looksBlocked('<title>Just a moment...</title>'), true);
});

test('looksBlocked — DDoS protection by Cloudflare → true', () => {
  assert.equal(looksBlocked('DDoS protection by Cloudflare'), true);
});

test('looksBlocked — recaptcha présent → true', () => {
  assert.equal(looksBlocked('<div class="g-recaptcha"></div>'), true);
});

test('looksBlocked — body normal → false', () => {
  assert.equal(looksBlocked('<html><body>normal results</body></html>'), false);
});

test('looksBlocked — empty/null → false', () => {
  assert.equal(looksBlocked(''), false);
  assert.equal(looksBlocked(null), false);
  assert.equal(looksBlocked(undefined), false);
});

// ─── extractResults ───────────────────────────────────────────────────────

test('extractResults — extrait les <a href="https://..."> simples', () => {
  const html = `
    <a href="https://acme.fr/">ACME</a>
    <a href="https://example.com/">Example</a>
  `;
  const out = extractResults(html, { excludeHostSuffixes: [], maxResults: 10 });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].title, 'ACME');
  assert.equal(out[0].rank, 1);
  assert.equal(out[1].url, 'https://example.com');
  assert.equal(out[1].rank, 2);
});

test('extractResults — exclut les hosts internes du moteur', () => {
  const html = `
    <a href="https://www.mojeek.com/about">About</a>
    <a href="https://acme.fr/">Real result</a>
  `;
  const out = extractResults(html, { excludeHostSuffixes: ['mojeek.com'], maxResults: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('extractResults — déduplique sur URL canonique', () => {
  const html = `
    <a href="https://acme.fr/">title 1</a>
    <a href="https://www.acme.fr/">title 2</a>
    <a href="https://other.fr/">other</a>
  `;
  const out = extractResults(html, { excludeHostSuffixes: [], maxResults: 10 });
  assert.equal(out.length, 2);
  // 1er match gagne (rank 1)
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[1].url, 'https://other.fr');
});

test('extractResults — borne maxResults', () => {
  const html = Array.from({ length: 20 }, (_, i) => `<a href="https://site${i}.fr/">${i}</a>`).join('');
  const out = extractResults(html, { excludeHostSuffixes: [], maxResults: 5 });
  assert.equal(out.length, 5);
});

test('extractResults — strip HTML tags + decode entities dans le titre', () => {
  const html = '<a href="https://acme.fr/">ACME &amp; Co <em>Solutions</em></a>';
  const out = extractResults(html, { excludeHostSuffixes: [], maxResults: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'ACME & Co Solutions');
});

test('extractResults — ignore les hrefs non-http', () => {
  const html = `
    <a href="mailto:a@b.fr">email</a>
    <a href="javascript:void(0)">js</a>
    <a href="/relative">relative</a>
    <a href="https://acme.fr/">real</a>
  `;
  const out = extractResults(html, { excludeHostSuffixes: [], maxResults: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

test('extractResults — body vide ou null → []', () => {
  assert.deepEqual(extractResults('', {}), []);
  assert.deepEqual(extractResults(null, {}), []);
});

test('extractResults — sous-domaines couverts par excludeHostSuffixes', () => {
  const html = `
    <a href="https://blog.ecosia.org/article">ecosia blog</a>
    <a href="https://acme.fr/">real</a>
  `;
  const out = extractResults(html, { excludeHostSuffixes: ['ecosia.org'], maxResults: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
});

// ─── isInternalHost ───────────────────────────────────────────────────────

test('isInternalHost — match exact', () => {
  assert.equal(_internals.isInternalHost('mojeek.com', ['mojeek.com']), true);
});

test('isInternalHost — match suffix (sous-domaine)', () => {
  assert.equal(_internals.isInternalHost('www.mojeek.com', ['mojeek.com']), true);
  assert.equal(_internals.isInternalHost('blog.mojeek.com', ['mojeek.com']), true);
});

test('isInternalHost — pas de match si suffix non-aligné aux dots', () => {
  // 'fakemojeek.com' ne doit pas matcher 'mojeek.com'
  assert.equal(_internals.isInternalHost('fakemojeek.com', ['mojeek.com']), false);
});
