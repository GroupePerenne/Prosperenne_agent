'use strict';

/**
 * Endpoint diag temporaire — test accessibilité APIs externes depuis FA prod.
 *
 * Conçu pour identifier la cause racine "100% LeadContacts résolus avec
 * source=none + signals=domain_unresolved + sf.no_result" observée 15/05 matin.
 *
 * Hypothèse : api.gouv.fr ET/OU DDG bloqués pour l'IP Azure FA pereneo-mail-sender.
 *
 * Usage : GET /api/diagExternalApis?key=<FUNCTION_KEY>
 * Retourne JSON status code + latency pour chaque endpoint.
 *
 * À supprimer post-investigation (PR séparée).
 */

const { app } = require('@azure/functions');

async function testEndpoint(name, url, opts = {}) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs || 10000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: opts.method || 'GET',
      signal: ctrl.signal,
      headers: opts.headers || {},
    });
    clearTimeout(timer);
    const elapsedMs = Date.now() - started;
    const text = await res.text().catch(() => '');
    return {
      name,
      url,
      status: res.status,
      ok: res.ok,
      elapsedMs,
      bodyPreview: text.slice(0, 200),
    };
  } catch (err) {
    return {
      name,
      url,
      status: 0,
      ok: false,
      elapsedMs: Date.now() - started,
      error: err && err.message ? err.message : String(err),
    };
  }
}

// Fetch RNE depuis api.gouv.fr/recherche-entreprises pour enrichir rne payload
// (telephone, dirigeant prenom+nom, adresse complete).
async function fetchRneEnrichment(siren) {
  try {
    const url = `https://recherche-entreprises.api.gouv.fr/search?q=${siren}&page=1&per_page=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const ent = (data.results || [])[0];
    if (!ent) return null;
    const siege = ent.siege || {};
    const dir = (ent.dirigeants || [])[0] || {};
    return {
      telephone: siege.telephone || siege.numero_voie || null,
      dirigeantFirstName: dir.prenoms ? String(dir.prenoms).split(' ')[0] : null,
      dirigeantLastName: dir.nom_patronymique || dir.nom || null,
      adresse: siege.adresse || null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

app.http('diagSiteFinder', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    const siren = request.query.get('siren') || '852115740';
    const companyName = request.query.get('name') || 'OSEYS RESEAU';
    const ville = request.query.get('ville') || 'PARIS';
    const codePostal = request.query.get('cp') || '75000';
    const trace = { input: { siren, companyName, ville, codePostal }, steps: [] };

    // Fetch RNE enrichment auto (api.gouv.fr) pour passer rne signaux au validator
    const rne = await fetchRneEnrichment(siren);
    trace.rne = rne;

    // Mode override via query param (?mode=batch ou ?mode=on_demand, défaut on_demand)
    const mode = request.query.get('mode') === 'batch' ? 'batch' : 'on_demand';
    trace.mode = mode;

    try {
      const { findWebsite } = require('../../shared/site-finder');
      const started = Date.now();
      const result = await findWebsite({
        siren,
        companyName,
        ville,
        codePostal,
        rne,
        options: { mode, logger: (m,d) => trace.steps.push({ msg: m, data: d }) },
      });
      trace.elapsedMs = Date.now() - started;
      trace.result = result;
    } catch (err) {
      trace.error = err && err.message ? err.message : String(err);
      trace.stack = err && err.stack ? err.stack.split('\n').slice(0,5) : null;
    }

    return { jsonBody: trace };
  },
});

app.http('diagScraping', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    const domain = request.query.get('domain');
    const firstName = request.query.get('firstName') || '';
    const lastName = request.query.get('lastName') || '';
    const mode = request.query.get('mode') === 'fast' ? 'fast' : 'exhaustive';
    if (!domain) return { jsonBody: { error: 'domain requis' } };
    try {
      const { scrapeDomain } = require('../../shared/lead-exhauster/scraping');
      const result = await scrapeDomain(
        { domain, firstName, lastName },
        { mode, globalTimeoutMs: 60000, pageTimeoutMs: 8000 },
      );
      return {
        jsonBody: {
          domain,
          mode,
          firstName,
          lastName,
          emailsCount: result.emails.length,
          emails: result.emails.slice(0, 30).map((e) => ({ email: e.email, confidence: e.confidence, sources: e.sources })),
          teamProfilesCount: result.teamProfiles.length,
          teamProfiles: result.teamProfiles.slice(0, 10),
          pagesVisited: result.pagesVisited,
          pagesFailed: result.pagesFailed,
          elapsedMs: result.elapsedMs,
        },
      };
    } catch (err) {
      return { jsonBody: { error: err && err.message } };
    }
  },
});

app.http('diagExhauster', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    const siren = request.query.get('siren');
    const companyName = request.query.get('name');
    const ville = request.query.get('ville') || '';
    const firstName = request.query.get('firstName') || '';
    const lastName = request.query.get('lastName') || '';
    const simulated = request.query.get('simulated') !== '0'; // défaut true (skip Dropcontact)

    if (!siren || !companyName) {
      return { jsonBody: { error: 'siren + name requis' } };
    }

    const trace = { input: { siren, companyName, ville, firstName, lastName, simulated } };

    try {
      const { leadExhauster } = require('../../shared/lead-exhauster');
      const { DropcontactAdapter } = require('../../shared/lead-exhauster/adapters/dropcontact');
      const started = Date.now();
      const companyDomain = request.query.get('domain') || null;
      const dropcontactAdapter = new DropcontactAdapter({
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
      const result = await leadExhauster({
        siren,
        beneficiaryId: 'diag-charli-15mai',
        firstName,
        lastName,
        companyName,
        companyDomain,
        city: ville,
        simulated,
      }, {
        logger: { info: () => {}, warn: () => {} },
        adapters: { dropcontact: dropcontactAdapter },
      });
      trace.elapsedMs = Date.now() - started;
      trace.result = {
        status: result.status,
        email: result.email,
        confidence: result.confidence,
        source: result.source,
        signals: result.signals,
        cost_cents: result.cost_cents,
        resolvedDecisionMaker: result.resolvedDecisionMaker,
        resolvedDomain: result.resolvedDomain,
        cached: result.cached,
      };
    } catch (err) {
      trace.error = err && err.message ? err.message : String(err);
      trace.stack = err && err.stack ? err.stack.split('\n').slice(0,8) : null;
    }

    return { jsonBody: trace };
  },
});

app.http('diagDdgRaw', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    const query = request.query.get('q') || '"DAHAN & FILS" ISSY-LES-MOULINEAUX';
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const trace = { query, url };

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        },
      });
      trace.status = res.status;
      trace.headers = Object.fromEntries(res.headers.entries());
      const html = await res.text();
      trace.htmlLength = html.length;
      trace.htmlPreview = html.slice(0, 3000);

      // Extract result URLs via regex DDG patterns
      const urls = [];
      const linkRegex = /class="result__url"[^>]*>([^<]+)</g;
      let m;
      while ((m = linkRegex.exec(html)) !== null && urls.length < 30) {
        urls.push(m[1].trim());
      }
      trace.extractedUrls = urls;

      const linkRegex2 = /<a\s+(?:rel="nofollow"\s+)?class="result__a"\s+href="([^"]+)"/g;
      const hrefUrls = [];
      while ((m = linkRegex2.exec(html)) !== null && hrefUrls.length < 30) {
        hrefUrls.push(m[1]);
      }
      trace.extractedHrefs = hrefUrls;

      // Check anti-bot challenge
      trace.hasAnomalyModal = html.includes('anomaly') || html.includes('captcha');
      trace.hasResults = html.includes('result__url') || html.includes('result__a');

    } catch (err) {
      trace.error = err && err.message ? err.message : String(err);
    }

    return { jsonBody: trace };
  },
});

app.http('diagExternalApis', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async (request, context) => {
    const results = [];

    // Test 1 — api.gouv.fr recherche-entreprises (source T1 site-finder)
    results.push(await testEndpoint(
      'api.gouv.fr/recherche-entreprises',
      'https://recherche-entreprises.api.gouv.fr/search?q=852115740&page=1&per_page=1',
    ));

    // Test 2 — DuckDuckGo HTML (source T2 site-finder, backend défaut)
    results.push(await testEndpoint(
      'duckduckgo-html',
      'https://html.duckduckgo.com/html/?q=test+entreprise',
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    ));

    // Test 3 — Dropcontact ping (vérifier auth API key)
    const dropcontactApiKey = process.env.DROPCONTACT_API_KEY;
    results.push(await testEndpoint(
      'dropcontact-batch',
      'https://api.dropcontact.io/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Token': dropcontactApiKey || 'missing',
        },
        timeoutMs: 15000,
      },
    ));

    return {
      jsonBody: {
        timestamp: new Date().toISOString(),
        results,
        env: {
          DROPCONTACT_ENABLED: process.env.DROPCONTACT_ENABLED,
          DROPCONTACT_API_KEY_set: Boolean(dropcontactApiKey),
          LEAD_EXHAUSTER_CONFIDENCE_THRESHOLD: process.env.LEAD_EXHAUSTER_CONFIDENCE_THRESHOLD,
          WEBSITE_TIME_ZONE: process.env.WEBSITE_TIME_ZONE,
        },
      },
    };
  },
});
