#!/usr/bin/env node
/**
 * Smoke test lead-exhauster — SPEC §11.3.
 *
 * Deux modes :
 *   --dry-run : mock fetchImpl, aucun appel réseau réel, exit 0 attendu
 *   --real    : vraie résolution sur 3-5 SIRENs validés par Paul. Exige
 *               DROPCONTACT_ENABLED=true + DROPCONTACT_API_KEY dans l env
 *               ET --yes pour passer le garde-fou de coût.
 *
 * Usage :
 *   node scripts/exhauster-smoke.js --dry-run
 *   DROPCONTACT_ENABLED=true DROPCONTACT_API_KEY=... \
 *     node scripts/exhauster-smoke.js --real --yes
 *
 * Sortie : rapport par SIREN + compteurs globaux. Exit 0 si tous les
 * scénarios se comportent comme attendu, exit 1 sinon.
 */

'use strict';

const { leadExhauster } = require('../shared/lead-exhauster');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const REAL = args.has('--real');
const CONFIRMED = args.has('--yes');

if (!DRY_RUN && !REAL) {
  console.error('Usage: node scripts/exhauster-smoke.js --dry-run | --real --yes');
  process.exit(2);
}

if (REAL && !CONFIRMED) {
  console.error('--real nécessite --yes explicite (garde-fou coût Dropcontact).');
  process.exit(2);
}

if (REAL && process.env.DROPCONTACT_ENABLED !== 'true') {
  console.error('--real nécessite DROPCONTACT_ENABLED=true dans l\'env.');
  process.exit(2);
}
if (REAL && !process.env.DROPCONTACT_API_KEY) {
  console.error('--real nécessite DROPCONTACT_API_KEY dans l\'env.');
  process.exit(2);
}

// SIRENs de test validés par Paul (oseys.fr sphere, faible risque d'impact)
// À élargir après validation pilote Morgane/Johnny.
const SMOKE_CASES = [
  {
    name: 'OSEYS GROUPE',
    input: {
      siren: '981430001', // placeholder — à remplacer par le vrai SIREN OSEYS
      companyName: 'OSEYS GROUPE',
      firstName: 'Paul',
      lastName: 'Rudler',
      companyDomain: 'oseys.fr',
      trancheEffectif: '11',
      beneficiaryId: 'smoke-test',
    },
    expectStatusDry: ['ok', 'unresolvable'], // dry-run, patterns.first.last avec scraping oseys.fr → potentiellement OK
  },
  {
    name: 'Entreprise sans domaine',
    input: {
      siren: '123456789',
      companyName: 'Fake Corp',
      firstName: 'Jean',
      lastName: 'Dupont',
      beneficiaryId: 'smoke-test',
    },
    expectStatusDry: ['unresolvable'],
  },
  {
    name: 'SIREN invalide',
    input: {
      siren: 'abc',
      beneficiaryId: 'smoke-test',
    },
    expectStatusDry: ['error'],
  },
];

// En dry-run, on force simulated=true (pas de Dropcontact) et on utilise
// un fetchImpl stub qui retourne des pages HTML prédéfinies. En --real,
// on laisse le vrai fetch global faire son travail.
function dryRunFetchImpl() {
  return async (url) => {
    const u = String(url);
    // API gouv recherche-entreprises : retourne des résultats minimaux
    if (u.includes('recherche-entreprises')) {
      if (u.includes('981430001')) {
        return jsonResponse({
          results: [{ siren: '981430001', siege: { site_web: 'https://oseys.fr' } }],
        });
      }
      return jsonResponse({ results: [] });
    }
    // Scraping : retourne une page bidon avec email nominatif
    if (u.includes('oseys.fr')) {
      return htmlResponse('<p>Paul Rudler, Directeur Général : paul.rudler@oseys.fr</p>');
    }
    return { ok: false, status: 404 };
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function htmlResponse(html, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: (h) => h.toLowerCase() === 'content-type' ? 'text/html' : null },
    text: async () => html,
    json: async () => ({}),
  };
}

// In-memory cache / trace stubs (pas d'Azure Storage en dry-run)
function makeInMemoryCache() {
  const m = new Map();
  const key = (siren, f, l) => `${siren}|${(f || '').toLowerCase()}|${(l || '').toLowerCase()}`;
  return {
    readLeadContact: async ({ siren, firstName, lastName }) => m.get(key(siren, firstName, lastName)) || null,
    upsertLeadContact: async (row) => {
      m.set(key(row.siren, row.firstName, row.lastName), { ...row, lastVerifiedAt: new Date().toISOString() });
      return true;
    },
  };
}

async function runCase(testCase, mode) {
  const started = Date.now();
  const cacheAdapters = mode === 'dry-run' ? makeInMemoryCache() : {};
  const fetchImpl = mode === 'dry-run' ? dryRunFetchImpl() : undefined;

  const adapters = { ...cacheAdapters };
  if (mode === 'real') {
    // Vraie cascade Dropcontact activée
    adapters.dropcontact = new DropcontactAdapter({ enabled: true });
  } else {
    // Dry-run : stub disabled, jamais appelé
    adapters.dropcontact = new DropcontactAdapter({ enabled: false });
  }

  const input = { ...testCase.input };
  if (mode === 'dry-run') input.simulated = true;

  let result;
  try {
    result = await leadExhauster(input, { adapters, fetchImpl });
  } catch (err) {
    return {
      name: testCase.name,
      ok: false,
      reason: `throw: ${err && err.message}`,
      elapsedMs: Date.now() - started,
    };
  }

  const elapsed = Date.now() - started;
  const expected = testCase.expectStatusDry || [];
  const ok = mode === 'real' ? true : expected.includes(result.status);

  return {
    name: testCase.name,
    ok,
    status: result.status,
    email: result.email,
    confidence: result.confidence,
    source: result.source,
    cost_cents: result.cost_cents,
    cached: result.cached,
    elapsedMs: elapsed,
    signals: result.signals ? result.signals.slice(0, 8) : [],
    expectedStatus: mode === 'real' ? 'any' : expected.join('|'),
  };
}

async function main() {
  const mode = DRY_RUN ? 'dry-run' : 'real';
  console.log(`\n🔎 Lead Exhauster Smoke — mode: ${mode}`);
  console.log(`   Cas: ${SMOKE_CASES.length}\n`);

  const results = [];
  for (const tc of SMOKE_CASES) {
    process.stdout.write(`   [${tc.name}] ...`);
    const r = await runCase(tc, mode);
    results.push(r);
    const badge = r.ok ? '✓' : '✗';
    console.log(` ${badge} status=${r.status} email=${r.email || '-'} ${r.elapsedMs}ms`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n   Résumé : ${passed} OK / ${failed} KO / ${results.length} total`);

  if (failed > 0) {
    console.log('\n   Détails échecs :');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`     - ${r.name} : status=${r.status} attendu=${r.expectedStatus} reason=${r.reason || '-'}`);
    }
    process.exit(1);
  }

  if (mode === 'real') {
    const totalCost = results.reduce((s, r) => s + (r.cost_cents || 0), 0);
    console.log(`\n   Coût Dropcontact total : ${totalCost} cents (${(totalCost / 100).toFixed(2)} €)`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
