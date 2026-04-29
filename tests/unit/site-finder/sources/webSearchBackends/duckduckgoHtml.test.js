'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  search,
  SearchBlockedError,
  SearchTransientError,
  _internals,
} = require('../../../../../shared/site-finder/sources/webSearchBackends/duckduckgoHtml');

function makeFetchStub({ status = 200, body = '', throwError = null } = {}) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url, options });
    if (throwError) throw throwError;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  };
  return { stub, calls };
}

// HTML synthétique reproduisant le format DDG observé en T2.0.
function makeResultsHtml(results) {
  return results
    .map((r, i) => {
      const ddgUrl = `//duckduckgo.com/l/?uddg=${encodeURIComponent(r.target)}&rut=hash${i}`;
      return `<div class="result results_links results_links_deep web-result">
        <h2 class="result__title">
          <a class="result__a" href="${ddgUrl}">${r.title || `Result ${i + 1}`}</a>
        </h2>
        <a class="result__snippet" href="${ddgUrl}">snippet ${i + 1}</a>
      </div>`;
    })
    .join('\n');
}

// ─── Cas nominaux ──────────────────────────────────────────────────────────

test('search — HTML 5 résultats organiques → array de 5', async () => {
  const html = makeResultsHtml([
    { target: 'https://acme.fr/' },
    { target: 'https://example.com/' },
    { target: 'https://foo.fr/page' },
    { target: 'https://bar.fr/' },
    { target: 'https://baz.com/' },
  ]);
  const { stub, calls } = makeFetchStub({ body: html });
  const out = await search('test query', { fetchImpl: stub });
  assert.equal(out.length, 5);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].rank, 1);
  assert.equal(out[4].url, 'https://baz.com');
  assert.equal(out[4].rank, 5);
  // Vérifie l'URL appelée — encodeURIComponent encode l'espace en %20, pas en +
  assert.match(calls[0].url, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=test%20query$/);
});

test('search — déduplique résultats répétés (titre + snippet pointent même URL)', async () => {
  // Le même HTML DDG répète chaque résultat plusieurs fois (titre, snippet, footer)
  const html = makeResultsHtml([
    { target: 'https://acme.fr/' },
    { target: 'https://acme.fr/' }, // répété
    { target: 'https://other.fr/' },
  ]);
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[1].url, 'https://other.fr');
});

test('search — décode redirection DDG (param uddg)', async () => {
  // Vérifie la robustesse : URL avec params, fragments, encodage spécial
  const target = 'https://acme.fr/?utm=test&x=y';
  const html = makeResultsHtml([{ target }]);
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 1);
  // urlNormalizer strippe la query → 'https://acme.fr'
  assert.equal(out[0].url, 'https://acme.fr');
});

test('search — HTML sans résultats organiques → array vide', async () => {
  const html = '<html><body><p>No results found.</p></body></html>';
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.deepEqual(out, []);
});

test('search — query vide ou non-string → array vide sans appel', async () => {
  const { stub, calls } = makeFetchStub({ body: '' });
  assert.deepEqual(await search('', { fetchImpl: stub }), []);
  assert.deepEqual(await search('   ', { fetchImpl: stub }), []);
  assert.deepEqual(await search(null, { fetchImpl: stub }), []);
  assert.equal(calls.length, 0);
});

test('search — extrait le titre dépouillé des balises et entities', async () => {
  const ddgUrl = `//duckduckgo.com/l/?uddg=${encodeURIComponent('https://acme.fr/')}`;
  const html = `<a class="result__a" href="${ddgUrl}">Acme &amp; Co &lt;Solutions&gt; <em>since 2020</em></a>`;
  const { stub } = makeFetchStub({ body: html });
  const out = await search('q', { fetchImpl: stub });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Acme & Co <Solutions> since 2020');
});

// ─── Erreurs classifiées ───────────────────────────────────────────────────

test('search — HTTP 429 → SearchBlockedError(rate_limited)', async () => {
  const { stub } = makeFetchStub({ status: 429, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'rate_limited',
  );
});

test('search — HTTP 403 → SearchBlockedError(forbidden)', async () => {
  const { stub } = makeFetchStub({ status: 403, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'forbidden',
  );
});

test('search — HTTP 503 → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ status: 503, body: '' });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError && err.code === 'transient',
  );
});

test('search — body anomaly modal → SearchBlockedError(anomaly_challenge)', async () => {
  // Reproduit le pattern observé T2.0 : 202 + form action="//duckduckgo.com/anomaly.js?..."
  const html = '<form action="//duckduckgo.com/anomaly.js?sv=html"></form>';
  const { stub } = makeFetchStub({ status: 202, body: html });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError && err.reason === 'anomaly_challenge',
  );
});

test('search — body anomaly-modal__image → SearchBlockedError', async () => {
  const html = '<img class="anomaly-modal__image" alt=""/>';
  const { stub } = makeFetchStub({ status: 200, body: html });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchBlockedError,
  );
});

test('search — réseau throw → SearchTransientError', async () => {
  const { stub } = makeFetchStub({ throwError: new Error('ECONNRESET') });
  await assert.rejects(
    () => search('q', { fetchImpl: stub }),
    (err) => err instanceof SearchTransientError,
  );
});

// ─── Internals ─────────────────────────────────────────────────────────────

test('_internals.decodeDuckduckgoRedirect — décode uddg', () => {
  const { decodeDuckduckgoRedirect } = _internals;
  assert.equal(
    decodeDuckduckgoRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.fr%2F&rut=h'),
    'https://acme.fr/',
  );
  assert.equal(
    decodeDuckduckgoRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com'),
    'https://example.com',
  );
});

test('_internals.decodeDuckduckgoRedirect — pass-through si pas une redirection DDG', () => {
  const { decodeDuckduckgoRedirect } = _internals;
  assert.equal(
    decodeDuckduckgoRedirect('https://acme.fr/page'),
    'https://acme.fr/page',
  );
});

test('_internals.decodeDuckduckgoRedirect — null pour entrée invalide', () => {
  const { decodeDuckduckgoRedirect } = _internals;
  assert.equal(decodeDuckduckgoRedirect(null), null);
  assert.equal(decodeDuckduckgoRedirect(''), null);
});

test('_internals.isAnomalyBody — détecte les patterns connus', () => {
  const { isAnomalyBody } = _internals;
  assert.equal(isAnomalyBody('<form action="//duckduckgo.com/anomaly.js?x=y">'), true);
  assert.equal(isAnomalyBody('<div class="anomaly-modal foo">'), true);
  assert.equal(isAnomalyBody('<a class="result__a">link</a>'), false);
  assert.equal(isAnomalyBody(''), false);
  assert.equal(isAnomalyBody(null), false);
});
