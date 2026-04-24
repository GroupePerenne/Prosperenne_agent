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
 * Option :
 *   --sirens <path.json> : override les SIRENs hardcodés par un fichier
 *     JSON de format [{ siren, denom, naf, trancheEffectif, dirigeant:{prenom,nom,fonction?} }].
 *     Le sample `scripts/smoke-sirens-sample.json` est fourni comme exemple
 *     (5 SIRENs LeadBase curés pour le smoke réel du pilote).
 *
 * Usage :
 *   node scripts/exhauster-smoke.js --dry-run
 *   node scripts/exhauster-smoke.js --dry-run --sirens scripts/smoke-sirens-sample.json
 *   DROPCONTACT_ENABLED=true DROPCONTACT_API_KEY=... \
 *     node scripts/exhauster-smoke.js --real --yes --sirens scripts/smoke-sirens-sample.json
 *
 * Sortie : rapport par SIREN + compteurs globaux. Exit 0 si tous les
 * scénarios se comportent comme attendu, exit 1 sinon.
 */

'use strict';

const fs = require('fs');
const { leadExhauster } = require('../shared/lead-exhauster');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');

// ─── CLI parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    dryRun: false,
    real: false,
    confirmed: false,
    sirensPath: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--real') out.real = true;
    else if (a === '--yes') out.confirmed = true;
    else if (a === '--sirens') {
      out.sirensPath = args[i + 1];
      i++;
    }
  }
  return out;
}

// ─── Chargement SIRENs depuis fichier JSON ────────────────────────────────

/**
 * Charge un fichier JSON de SIRENs curés (format Paul §extract).
 *
 * Format attendu : array d'objets avec au minimum { siren, denom, dirigeant:{prenom,nom} }.
 * Champs optionnels : naf, trancheEffectif, ville, siteWeb, dirigeant.fonction.
 *
 * Lance une erreur si :
 *   - fichier absent
 *   - JSON invalide
 *   - structure hors contrat (pas un array, entrée sans siren 9 chiffres,
 *     entrée sans dirigeant.prenom+nom)
 *
 * @param {string} filePath
 * @returns {Array<Object>}                        Structures raw du fichier
 */
function loadSirensFromFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('loadSirensFromFile: path requis');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`loadSirensFromFile: fichier introuvable: ${filePath}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`loadSirensFromFile: lecture échouée: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadSirensFromFile: JSON invalide: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('loadSirensFromFile: racine doit être un array');
  }
  if (parsed.length === 0) {
    throw new Error('loadSirensFromFile: array vide');
  }
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i];
    if (!e || typeof e !== 'object') {
      throw new Error(`loadSirensFromFile: entrée ${i} n'est pas un objet`);
    }
    if (!e.siren || !/^\d{9}$/.test(String(e.siren))) {
      throw new Error(`loadSirensFromFile: entrée ${i} siren manquant ou invalide (attendu 9 chiffres)`);
    }
    if (!e.dirigeant || !e.dirigeant.prenom || !e.dirigeant.nom) {
      throw new Error(`loadSirensFromFile: entrée ${i} (siren ${e.siren}) dirigeant.prenom + dirigeant.nom requis`);
    }
  }
  return parsed;
}

/**
 * Convertit une entrée sample (format Paul) en SmokeCase consommable
 * par runCase.
 *
 * En `--real` mode, on n'impose pas de statut attendu (smoke test,
 * not assertion). En `--dry-run` on attend `unresolvable` par défaut
 * (aucun fetchImpl réel ne sera appelé sur un SIREN inconnu de notre
 * stub), sauf si l'entrée spécifie `expectStatusDry`.
 */
function convertSampleToSmokeCase(entry) {
  const input = {
    siren: String(entry.siren),
    companyName: entry.denom || '',
    firstName: entry.dirigeant && entry.dirigeant.prenom ? entry.dirigeant.prenom : '',
    lastName: entry.dirigeant && entry.dirigeant.nom ? entry.dirigeant.nom : '',
    beneficiaryId: 'smoke-sample',
  };
  if (entry.naf) input.naf = entry.naf;
  if (entry.trancheEffectif) input.trancheEffectif = entry.trancheEffectif;
  if (entry.siteWeb) input.companyDomain = entry.siteWeb;
  if (entry.dirigeant && entry.dirigeant.fonction) input.inseeRole = String(entry.dirigeant.fonction);
  return {
    name: `${entry.denom || entry.siren} (${entry.naf || '?'})`,
    input,
    expectStatusDry: Array.isArray(entry.expectStatusDry) && entry.expectStatusDry.length > 0
      ? entry.expectStatusDry
      : ['ok', 'unresolvable'],
  };
}

// ─── SIRENs de test hardcodés (fallback si --sirens absent) ────────────────

const DEFAULT_SMOKE_CASES = [
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
    expectStatusDry: ['ok', 'unresolvable'],
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
    if (u.includes('recherche-entreprises')) {
      if (u.includes('981430001')) {
        return jsonResponse({
          results: [{ siren: '981430001', siege: { site_web: 'https://oseys.fr' } }],
        });
      }
      return jsonResponse({ results: [] });
    }
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
    adapters.dropcontact = new DropcontactAdapter({ enabled: true });
  } else {
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

/**
 * Sélectionne les cas à passer : soit le fichier --sirens, soit les
 * hardcodés. Exposé pour tests (validation parsing fichier).
 */
function resolveSmokeCases({ sirensPath }) {
  if (!sirensPath) {
    return { source: 'hardcoded', cases: DEFAULT_SMOKE_CASES };
  }
  const raw = loadSirensFromFile(sirensPath);
  return {
    source: `file:${sirensPath}`,
    cases: raw.map(convertSampleToSmokeCase),
  };
}

async function main() {
  const cli = parseArgs(process.argv);

  if (!cli.dryRun && !cli.real) {
    console.error('Usage: node scripts/exhauster-smoke.js --dry-run | --real --yes [--sirens path.json]');
    process.exit(2);
  }
  if (cli.real && !cli.confirmed) {
    console.error('--real nécessite --yes explicite (garde-fou coût Dropcontact).');
    process.exit(2);
  }
  if (cli.real && process.env.DROPCONTACT_ENABLED !== 'true') {
    console.error('--real nécessite DROPCONTACT_ENABLED=true dans l\'env.');
    process.exit(2);
  }
  if (cli.real && !process.env.DROPCONTACT_API_KEY) {
    console.error('--real nécessite DROPCONTACT_API_KEY dans l\'env.');
    process.exit(2);
  }

  const mode = cli.dryRun ? 'dry-run' : 'real';
  let cases;
  let source;
  try {
    ({ source, cases } = resolveSmokeCases({ sirensPath: cli.sirensPath }));
  } catch (err) {
    console.error(`Chargement SIRENs échoué : ${err.message}`);
    process.exit(2);
  }

  console.log(`\n🔎 Lead Exhauster Smoke — mode: ${mode}`);
  console.log(`   Source : ${source}`);
  console.log(`   Cas: ${cases.length}\n`);

  const results = [];
  for (const tc of cases) {
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

// Exporte les helpers pour tests unitaires. main() n'est invoqué que si
// le script est exécuté directement (pas quand require() depuis les tests).
module.exports = {
  parseArgs,
  loadSirensFromFile,
  convertSampleToSmokeCase,
  resolveSmokeCases,
  DEFAULT_SMOKE_CASES,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Smoke failed:', err);
    process.exit(1);
  });
}
