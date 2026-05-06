'use strict';

/**
 * Tests unitaires source T1bis heuristicUrlGuess.
 *
 * Stubs : fetchImpl injecté, retourne un objet fetch-like { ok, status,
 * headers.get(), text() }. Le pool User-Agents est court-circuité via
 * opts.userAgent pour les tests d'invariance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findCandidatesViaHeuristic,
  buildSlugs,
  buildCandidateUrls,
  _internals,
} = require('../../../../shared/site-finder/sources/heuristicUrlGuess');

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * makeFetchStub :
 *   responses → map url → { status, contentType, body, contentLength }
 *   urls inconnues → 404 par défaut.
 *
 * Permet aussi de tracker tous les appels (calls).
 */
function makeFetchStub(responses = {}, defaultBody = null) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push({ url, options });
    const r = responses[url];
    if (!r) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => '',
      };
    }
    const status = r.status || 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      headers: {
        get: (name) => {
          const lower = String(name).toLowerCase();
          if (lower === 'content-type') return r.contentType || 'text/html';
          if (lower === 'content-length') {
            return r.contentLength != null
              ? String(r.contentLength)
              : (r.body ? String(r.body.length) : null);
          }
          return null;
        },
      },
      text: async () => r.body || defaultBody || '',
    };
  };
  return { stub, calls };
}

const BIG_HTML = 'x'.repeat(10000); // > MIN_BODY_BYTES, pas un parking

// ─── buildSlugs ───────────────────────────────────────────────────────────

test('buildSlugs — nom simple avec SAS → slug court', () => {
  const slugs = buildSlugs('ACME PLOMBERIE SAS');
  assert.ok(slugs.includes('acme-plomberie'));
  assert.ok(slugs.includes('acmeplomberie'));
  assert.ok(slugs.includes('acme'));
});

test('buildSlugs — accents normalisés', () => {
  const slugs = buildSlugs('Société Générale');
  assert.ok(slugs.includes('societe-generale'));
});

test('buildSlugs — stop words filtrés si ≥ 3 mots', () => {
  const slugs = buildSlugs('La Maison de Pierre SARL');
  assert.ok(slugs.some((s) => s.includes('maison')));
  assert.ok(!slugs.some((s) => s.startsWith('la-maison')));
});

test('buildSlugs — nom vide → []', () => {
  assert.deepEqual(buildSlugs(''), []);
  assert.deepEqual(buildSlugs(null), []);
  assert.deepEqual(buildSlugs(undefined), []);
});

test('buildSlugs — nom mono-mot SARL → slug racine', () => {
  // "Acme SARL" → ['acme']
  const slugs = buildSlugs('Acme SARL');
  assert.ok(slugs.includes('acme'));
});

test('buildSlugs — caractères spéciaux nettoyés', () => {
  const slugs = buildSlugs("L'Atelier d'Acme & Cie");
  // 'l' stop-word retiré, 'd' isolé retiré, 'cie' suffixe juridique retiré
  assert.ok(slugs.some((s) => s.includes('atelier')));
  assert.ok(slugs.some((s) => s.includes('acme')));
});

test('buildSlugs — déduplication slugs identiques', () => {
  const slugs = buildSlugs('ACME');
  // Un seul mot → un seul slug
  const set = new Set(slugs);
  assert.equal(set.size, slugs.length);
});

// ─── buildCandidateUrls ───────────────────────────────────────────────────

test('buildCandidateUrls — .fr avant .com avant .eu, max 12', () => {
  const slugs = ['acme', 'acme-plomberie', 'acmeplomberie', 'autre', 'cinq'];
  const urls = buildCandidateUrls(slugs);
  assert.ok(urls.length <= 12);
  assert.equal(urls[0], 'https://acme.fr');
  assert.equal(urls[1], 'https://acme.com');
  assert.equal(urls[2], 'https://acme.eu');
  assert.equal(urls[3], 'https://acme-plomberie.fr');
});

test('buildCandidateUrls — slugs vides → []', () => {
  assert.deepEqual(buildCandidateUrls([]), []);
});

// ─── findCandidatesViaHeuristic — entrées invalides ──────────────────────

test('findCandidatesViaHeuristic — siren invalide → [] sans fetch', async () => {
  const { stub, calls } = makeFetchStub();
  const out = await findCandidatesViaHeuristic(
    { siren: '12345', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test('findCandidatesViaHeuristic — companyName absent → [] sans fetch', async () => {
  const { stub, calls } = makeFetchStub();
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

// ─── findCandidatesViaHeuristic — chemin nominal ─────────────────────────

test('findCandidatesViaHeuristic — 1 URL existe .fr → 1 candidat normalisé', async () => {
  const { stub, calls } = makeFetchStub({
    'https://acme.fr': { body: BIG_HTML },
  });
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME SAS' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://acme.fr');
  assert.equal(out[0].source, 'heuristic_url_guess');
  assert.equal(out[0].initialConfidence, 0.70);
  assert.ok(out[0].signals[0].startsWith('heuristic_slug:'));
  // Au moins 1 fetch tenté
  assert.ok(calls.length >= 1);
});

test('findCandidatesViaHeuristic — plusieurs URLs existent → tous candidats', async () => {
  const { stub } = makeFetchStub({
    'https://acme.fr': { body: BIG_HTML },
    'https://acme.com': { body: BIG_HTML },
  });
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.equal(out.length, 2);
  const urls = out.map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://acme.com', 'https://acme.fr']);
});

test('findCandidatesViaHeuristic — aucune URL → []', async () => {
  const { stub } = makeFetchStub({});
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
});

// ─── findCandidatesViaHeuristic — parking detection ──────────────────────

test('findCandidatesViaHeuristic — body petit + marqueur parking → exclu', async () => {
  const parkingBody = '<html><head><title>Domain for sale</title></head><body>Buy this domain</body></html>';
  const { stub } = makeFetchStub({
    'https://acme.fr': { body: parkingBody, contentLength: parkingBody.length },
  });
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
});

test('findCandidatesViaHeuristic — content-length minuscule → exclu (parking probable)', async () => {
  // Body court SANS marqueur explicite mais Content-Length très court
  const tinyBody = '<html><body>hi</body></html>';
  const { stub } = makeFetchStub({
    'https://acme.fr': { body: tinyBody, contentLength: tinyBody.length },
  });
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
});

// ─── findCandidatesViaHeuristic — non-HTML / erreurs réseau ─────────────

test('findCandidatesViaHeuristic — réponse JSON content-type → exclu', async () => {
  const { stub } = makeFetchStub({
    'https://acme.fr': { body: '{"ok": true}', contentType: 'application/json' },
  });
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
});

test('findCandidatesViaHeuristic — fetch throw → URL ignorée, pas crash', async () => {
  const stub = async (url) => {
    if (url === 'https://acme.fr') throw new Error('ECONNREFUSED');
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => '',
    };
  };
  const out = await findCandidatesViaHeuristic(
    { siren: '123456789', companyName: 'ACME' },
    { fetchImpl: stub, userAgent: 'test-ua' },
  );
  assert.deepEqual(out, []);
});

// ─── pickUserAgent ───────────────────────────────────────────────────────

test('pickUserAgent — opts.userAgent override le pool', () => {
  const ua = _internals.pickUserAgent({ userAgent: 'custom-ua/1.0' });
  assert.equal(ua, 'custom-ua/1.0');
});

test('pickUserAgent — randomImpl injecté → déterministe', () => {
  const ua = _internals.pickUserAgent({ randomImpl: () => 0 });
  assert.equal(ua, _internals.USER_AGENTS[0]);
});

test('pickUserAgent — sans opts → l\'un des UA du pool', () => {
  const ua = _internals.pickUserAgent({});
  assert.ok(_internals.USER_AGENTS.includes(ua));
});

// ─── buildHeaders ────────────────────────────────────────────────────────

test('buildHeaders — contient User-Agent + Accept-Language fr-FR', () => {
  const h = _internals.buildHeaders('Mozilla/5.0 test');
  assert.equal(h['User-Agent'], 'Mozilla/5.0 test');
  assert.match(h['Accept-Language'], /fr-FR/);
  assert.ok(h['Sec-Fetch-Mode']);
  assert.ok(h.Accept);
});

// ─── looksLikeParking ────────────────────────────────────────────────────

test('looksLikeParking — content-length < MIN_BODY_BYTES → true', () => {
  assert.equal(_internals.looksLikeParking('whatever', 500), true);
});

test('looksLikeParking — body avec marqueur "domain for sale" → true', () => {
  assert.equal(_internals.looksLikeParking('<html>this domain is for sale</html>', null), true);
});

test('looksLikeParking — body grand sans marqueur → false', () => {
  assert.equal(_internals.looksLikeParking(BIG_HTML, BIG_HTML.length), false);
});
