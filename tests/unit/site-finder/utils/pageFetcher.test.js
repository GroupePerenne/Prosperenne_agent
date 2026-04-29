'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchPagesForValidation,
  _internals,
} = require('../../../../shared/site-finder/utils/pageFetcher');

function makeFetchStub(routes) {
  const calls = [];
  const stub = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) {
      return { status: 404, ok: false, text: async () => '' };
    }
    if (route.throwError) throw route.throwError;
    return {
      status: route.status || 200,
      ok: (route.status || 200) >= 200 && (route.status || 200) < 300,
      text: async () => route.text || '',
    };
  };
  return { stub, calls };
}

test('fetchPagesForValidation — home OK, parse anchors mentions-légales', async () => {
  const home = '<html><body><a href="/mentions-legales">Mentions légales</a><a href="/cgv">CGV</a></body></html>';
  const { stub, calls } = makeFetchStub({
    'https://acme.fr': { status: 200, text: home },
    'https://acme.fr/mentions-legales': { status: 200, text: '<p>SIREN 123 456 789</p>' },
    'https://acme.fr/cgv': { status: 200, text: '<p>CGV</p>' },
  });
  const pages = await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  assert.equal(pages.length, 3);
  assert.equal(pages[0].url, 'https://acme.fr');
  assert.ok(pages.some((p) => p.url === 'https://acme.fr/mentions-legales'));
  assert.ok(pages.some((p) => p.url === 'https://acme.fr/cgv'));
  assert.equal(calls.length, 3);
});

test('fetchPagesForValidation — home OK sans anchor → fallback paths classiques', async () => {
  const home = '<html><body><p>Bienvenue chez ACME</p></body></html>';
  const { stub, calls } = makeFetchStub({
    'https://acme.fr': { status: 200, text: home },
    'https://acme.fr/mentions-legales': { status: 200, text: '<p>SIREN 111 222 333</p>' },
    'https://acme.fr/mentions': { status: 404, text: '' },
    'https://acme.fr/cgv': { status: 200, text: 'cgv' },
    'https://acme.fr/legal': { status: 404, text: '' },
    'https://acme.fr/about': { status: 404, text: '' },
    'https://acme.fr/a-propos': { status: 404, text: '' },
  });
  const pages = await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  // home + 5 fallback paths max
  assert.ok(pages.length >= 2);
  assert.ok(pages.length <= 6);
  assert.equal(calls[0], 'https://acme.fr');
});

test('fetchPagesForValidation — home 404 → tente quand même les fallback paths', async () => {
  const { stub, calls } = makeFetchStub({
    'https://acme.fr': { status: 404, text: '' },
    'https://acme.fr/mentions-legales': { status: 200, text: 'mentions ici' },
  });
  const pages = await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  assert.ok(pages.length >= 2);
  // home a été tentée
  assert.equal(pages[0].url, 'https://acme.fr');
  // au moins un fallback a été tenté
  assert.ok(calls.some((u) => u.includes('mentions-legales')));
});

test('fetchPagesForValidation — fetch throw → marqué fetch_error sur la page', async () => {
  const { stub } = makeFetchStub({
    'https://acme.fr': { throwError: new Error('ECONNRESET') },
  });
  const pages = await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  assert.equal(pages.length >= 1, true);
  assert.equal(pages[0].status, 0);
  assert.equal(pages[0].error, 'fetch_error');
});

test('fetchPagesForValidation — entrée invalide → tableau vide', async () => {
  const { stub } = makeFetchStub({});
  assert.deepEqual(await fetchPagesForValidation('not-a-url', { fetchImpl: stub }), []);
  assert.deepEqual(await fetchPagesForValidation(null, { fetchImpl: stub }), []);
});

test('fetchPagesForValidation — anchors cross-domain ignorées', async () => {
  const home = '<a href="https://other.fr/mentions">Mentions</a><a href="/cgv">CGV</a>';
  const { stub, calls } = makeFetchStub({
    'https://acme.fr': { status: 200, text: home },
    'https://acme.fr/cgv': { status: 200, text: 'cgv' },
  });
  await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  // other.fr ne doit pas être appelé
  assert.ok(!calls.some((u) => u.includes('other.fr')));
});

test('fetchPagesForValidation — limite max additional pages respectée', async () => {
  const anchors = Array.from({ length: 10 }, (_, i) => `<a href="/mentions-${i}">Mentions ${i}</a>`).join('');
  const routes = {
    'https://acme.fr': { status: 200, text: anchors },
  };
  for (let i = 0; i < 10; i++) {
    routes[`https://acme.fr/mentions-${i}`] = { status: 200, text: `page ${i}` };
  }
  const { stub } = makeFetchStub(routes);
  const pages = await fetchPagesForValidation('https://acme.fr', { fetchImpl: stub });
  // home + max 5 additional = 6
  assert.ok(pages.length <= 6, `attendu ≤6, got ${pages.length}`);
});

// ─── Internals ─────────────────────────────────────────────────────────────

test('_internals.matchesAnchorKeyword — accents et casse insensibles', () => {
  const { matchesAnchorKeyword } = _internals;
  assert.equal(matchesAnchorKeyword('Mentions légales'), true);
  assert.equal(matchesAnchorKeyword('mentions legales'), true);
  assert.equal(matchesAnchorKeyword('CGV'), true);
  assert.equal(matchesAnchorKeyword('À PROPOS'), true);
  assert.equal(matchesAnchorKeyword('Accueil'), false);
  assert.equal(matchesAnchorKeyword(''), false);
});

test('_internals.extractAnchorCandidates — déduplique URLs', () => {
  const { extractAnchorCandidates } = _internals;
  const html = '<a href="/cgv">CGV</a><a href="/cgv">Conditions générales de vente</a>';
  const candidates = extractAnchorCandidates(html, 'https://acme.fr');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0], 'https://acme.fr/cgv');
});

test('_internals.buildSameHostUrl — concat path sur host', () => {
  const { buildSameHostUrl } = _internals;
  assert.equal(buildSameHostUrl('https://acme.fr', '/mentions'), 'https://acme.fr/mentions');
  assert.equal(buildSameHostUrl('https://acme.fr/some/path', '/mentions'), 'https://acme.fr/mentions');
});
