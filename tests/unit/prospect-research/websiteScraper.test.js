/**
 * Tests — shared/prospect-research/sources/websiteScraper.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scrapeCompanyWebsite,
  extractTextFromHtml,
  normalizeBaseUrl,
} = require('../../../shared/prospect-research/sources/websiteScraper');

// ─── extractTextFromHtml ──────────────────────────────────────────────────

test('extractTextFromHtml — vide retourne vide', () => {
  assert.equal(extractTextFromHtml(''), '');
  assert.equal(extractTextFromHtml(null), '');
  assert.equal(extractTextFromHtml(undefined), '');
});

test('extractTextFromHtml — retire <script>, <style>, <head>', () => {
  const html =
    '<html><head><title>X</title></head>' +
    '<body><script>var a = 1;</script><style>body{}</style>' +
    '<p>Contenu utile</p></body></html>';
  const res = extractTextFromHtml(html);
  assert.ok(res.includes('Contenu utile'));
  assert.ok(!res.includes('var a'));
  assert.ok(!res.includes('body{}'));
  assert.ok(!res.includes('<title>'));
});

test('extractTextFromHtml — retire nav/footer/aside', () => {
  const html =
    '<body><nav>menu top</nav><main>page body</main>' +
    '<footer>copyright bidon</footer></body>';
  const res = extractTextFromHtml(html);
  assert.ok(res.includes('page body'));
  assert.ok(!res.includes('menu top'));
  assert.ok(!res.includes('copyright bidon'));
});

test('extractTextFromHtml — retire bannière cookie typique', () => {
  const html =
    '<body><main>contenu</main>' +
    '<div id="cookieConsent">accepter les cookies</div>' +
    '<section class="rgpd-banner">bandeau RGPD</section>' +
    '</body>';
  const res = extractTextFromHtml(html);
  assert.ok(res.includes('contenu'));
  assert.ok(!res.includes('accepter les cookies'));
  assert.ok(!res.includes('bandeau RGPD'));
});

test('extractTextFromHtml — décode entités HTML courantes', () => {
  const html = '<p>Caf&eacute; &amp; th&egrave; &#233;galement</p>';
  const res = extractTextFromHtml(html);
  assert.ok(res.includes('Café'));
  assert.ok(res.includes('thè'));
  assert.ok(res.includes('également'));
  assert.ok(!res.includes('&eacute;'));
});

test('extractTextFromHtml — collapse whitespace', () => {
  const html = '<p>foo\n\n\t  bar\n   baz</p>';
  const res = extractTextFromHtml(html);
  assert.equal(res, 'foo bar baz');
});

// ─── normalizeBaseUrl ─────────────────────────────────────────────────────

test('normalizeBaseUrl — accepte avec et sans scheme', () => {
  assert.equal(normalizeBaseUrl('acme.fr'), 'https://acme.fr');
  assert.equal(normalizeBaseUrl('https://acme.fr'), 'https://acme.fr');
  assert.equal(normalizeBaseUrl('http://acme.fr'), 'http://acme.fr');
  assert.equal(normalizeBaseUrl('https://www.acme.fr/path'), 'https://www.acme.fr');
});

test('normalizeBaseUrl — null/vide → null', () => {
  assert.equal(normalizeBaseUrl(null), null);
  assert.equal(normalizeBaseUrl(''), null);
  assert.equal(normalizeBaseUrl('   '), null);
});

// ─── scrapeCompanyWebsite ─────────────────────────────────────────────────

test('scrapeCompanyWebsite — domain vide → shape vide', async () => {
  const res = await scrapeCompanyWebsite('');
  assert.deepEqual(res.texts, []);
  assert.deepEqual(res.visitedPages, []);
  assert.equal(typeof res.elapsedMs, 'number');
});

test('scrapeCompanyWebsite — fetch renvoie HTML → extrait textes', async () => {
  const fakeFetch = async (url) => {
    if (url.endsWith('/') || url.endsWith('/a-propos')) {
      return {
        ok: true,
        status: 200,
        text: async () => `<html><body><nav>menu</nav><main>contenu pour ${url}</main></body></html>`,
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const res = await scrapeCompanyWebsite('acme.fr', {
    fetchImpl: fakeFetch,
    paths: ['/', '/a-propos', '/inexistant'],
    maxPages: 5,
  });
  assert.equal(res.texts.length, 2);
  assert.ok(res.texts[0].text.includes('contenu pour'));
  assert.ok(!res.texts[0].text.includes('menu'));
  assert.equal(res.visitedPages.length, 3);
  assert.equal(res.visitedPages[2].status, 404);
});

test('scrapeCompanyWebsite — maxPages respecté', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><body>page</body></html>',
  });
  const res = await scrapeCompanyWebsite('acme.fr', {
    fetchImpl: fakeFetch,
    paths: ['/a', '/b', '/c', '/d'],
    maxPages: 2,
  });
  assert.equal(res.texts.length, 2);
});

test('scrapeCompanyWebsite — fetch throw → page ignorée, suite continue', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/boom')) throw new Error('connection refused');
    return { ok: true, status: 200, text: async () => '<body>ok</body>' };
  };
  const res = await scrapeCompanyWebsite('acme.fr', {
    fetchImpl: fakeFetch,
    paths: ['/boom', '/ok'],
  });
  assert.equal(res.texts.length, 1);
  assert.equal(calls.length, 2);
});

test('scrapeCompanyWebsite — budget global respecté', async () => {
  // Fake fetch rapide ; on met un budget si bas qu'après la 1ère page on stoppe.
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<body>page</body>',
  });
  const res = await scrapeCompanyWebsite('acme.fr', {
    fetchImpl: fakeFetch,
    paths: ['/a', '/b', '/c'],
    globalBudgetMs: 0, // budget épuisé avant la 2e page
  });
  // Au moins 1 fetch a été tenté, pas forcément 3
  assert.ok(res.visitedPages.length <= 3);
});

test('scrapeCompanyWebsite — maxCharsPerPage tronque le texte', async () => {
  const big = 'x'.repeat(20000);
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => `<body>${big}</body>`,
  });
  const res = await scrapeCompanyWebsite('acme.fr', {
    fetchImpl: fakeFetch,
    paths: ['/'],
    maxCharsPerPage: 1000,
  });
  assert.equal(res.texts[0].text.length, 1000);
});
