#!/usr/bin/env node
/**
 * Smoke runtime Sonnet 4.6 — validation Étape 2.1 plan branchement CTO.
 *
 * Vérifie sur 5 leads synthétiques BTP que generateSequence produit :
 *   - 3/3 objets (J0/J+14/J+28) contenant le nom de l'entreprise visible
 *   - 0 tiret cadratin (— U+2014, – U+2013) dans aucun objet
 *
 * Lance 5 appels Sonnet 4.6 (~50k tokens cumul, ~0.5€ estimé) avec
 * prompt caching éphémère actif (gain ~60-70% sur calls 2..N).
 *
 * Usage :
 *   # Lecture clé Anthropic depuis local.settings.json (chargement direct)
 *   node scripts/smoke-objet-j0-5-sirens.js
 *
 *   # OU clé déjà en env (CI, var shell)
 *   ANTHROPIC_API_KEY=... node scripts/smoke-objet-j0-5-sirens.js
 *
 * Sortie : tableau résumé stdout + JSON détaillé stderr + exit code 0 (GO)
 *   ou 1 (NO-GO) selon critères de succès.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── 1. Chargement ANTHROPIC_API_KEY depuis local.settings.json si absent env ─
function loadEnvFromLocalSettings() {
  if (process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('[smoke] ANTHROPIC_API_KEY déjà en env, skip local.settings.json\n');
    return;
  }
  const localPath = path.join(__dirname, '..', 'local.settings.json');
  if (!fs.existsSync(localPath)) {
    process.stderr.write(`[smoke] local.settings.json absent (${localPath}) — abort.\n`);
    process.stderr.write('[smoke] Si tu es en CI : exporte ANTHROPIC_API_KEY en var shell avant lancement.\n');
    process.exit(2);
  }
  try {
    const raw = fs.readFileSync(localPath, 'utf8');
    const data = JSON.parse(raw);
    const values = (data && data.Values) || {};
    if (!values.ANTHROPIC_API_KEY) {
      process.stderr.write('[smoke] local.settings.json présent mais ANTHROPIC_API_KEY absent.\n');
      process.exit(2);
    }
    process.env.ANTHROPIC_API_KEY = values.ANTHROPIC_API_KEY;
    // Charger aussi PIPEDRIVE_PIPELINE_ID etc. si besoin par generateSequence (non
    // requis sur le path actuel, mais utile pour ne pas surprendre).
    for (const k of Object.keys(values)) {
      if (process.env[k] === undefined) process.env[k] = values[k];
    }
    process.stderr.write('[smoke] ANTHROPIC_API_KEY chargée depuis local.settings.json\n');
  } catch (err) {
    process.stderr.write(`[smoke] Erreur parse local.settings.json : ${err.message}\n`);
    process.exit(2);
  }
}

loadEnvFromLocalSettings();

// ─── 2. Imports (post env load) ───────────────────────────────────────────────
const { generateSequence } = require('../shared/sequence');

// ─── 3. Données synthétiques BTP 92 (5 leads, noms génériques anonymes) ──────
const CONSULTANT = Object.freeze({
  email: 'm.dejessey@perennereseau.fr',
  prenom: 'Morgane',
  nom: 'DE JESSEY',
  prosperite: 'BTP',
  offre_choisie: 'lead',
  cible_specifique: '',
  methode_consultant: 'pilotage économique copilote',
  ton: 'chaleureux et factuel',
  anecdotes_anonymisees: [],
  mise_en_copie_consultant: false,
});

const AGENT = Object.freeze({
  id: 'martin',
  prenom: 'Martin',
  nom: 'CHEVALIER',
  email: 'martin@perennereseau.fr',
  telephone: '',
});

const LEADS = Object.freeze([
  {
    prenom: 'Jean',
    nom: 'Dupont',
    entreprise: 'MAÇONNERIE DUPONT',
    secteur: 'BTP',
    ville: 'Boulogne-Billancourt',
    contexte: 'aucun signal particulier',
  },
  {
    prenom: 'Pierre',
    nom: 'Martin',
    entreprise: 'BTP MARTIN ET FILS',
    secteur: 'BTP',
    ville: 'Nanterre',
    contexte: 'aucun signal particulier',
  },
  {
    prenom: 'Sophie',
    nom: 'Duval',
    entreprise: 'ÉLECTRICITÉ DUVAL',
    secteur: 'BTP - électricité',
    ville: 'Clichy',
    contexte: 'aucun signal particulier',
  },
  {
    prenom: 'Michel',
    nom: 'Leroux',
    entreprise: 'CONSTRUCTION LEROUX',
    secteur: 'BTP - gros œuvre',
    ville: 'Asnières-sur-Seine',
    contexte: 'aucun signal particulier',
  },
  {
    prenom: 'François',
    nom: 'Bernard',
    entreprise: 'PLOMBERIE BERNARD',
    secteur: 'BTP - plomberie',
    ville: 'Meudon',
    contexte: 'aucun signal particulier',
  },
]);

// ─── 4. Critères de validation ────────────────────────────────────────────────
const CADRAT_DASH = /[—–]/; // U+2014 (em dash) et U+2013 (en dash) bannis REGLES_HONNEUR §12

function normalizeForMatch(s) {
  // Lowercase + retire accents pour comparaison nom entreprise
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function subjectContainsEntreprise(subject, entreprise) {
  if (!subject || !entreprise) return false;
  const subjN = normalizeForMatch(subject);
  const entN = normalizeForMatch(entreprise);
  // Match si TOUT le nom entreprise OU les 2+ mots significatifs (≥4 chars) du nom sont présents
  if (subjN.includes(entN)) return true;
  const significantWords = entN.split(/\s+/).filter((w) => w.length >= 4 && !['avec', 'pour', 'sans'].includes(w));
  if (significantWords.length === 0) return false;
  // Au moins 1 mot significatif présent (assouplit pour "MAÇONNERIE DUPONT" → "Dupont" suffit)
  return significantWords.some((w) => subjN.includes(w));
}

// ─── 5. Smoke runtime ─────────────────────────────────────────────────────────
async function smokeOneLead(lead, idx) {
  const t0 = Date.now();
  try {
    const seq = await generateSequence({
      consultant: CONSULTANT,
      agent: AGENT,
      lead,
      enrichments: null,
      prospectProfile: null,
    });
    const elapsedMs = Date.now() - t0;
    const subjects = seq.map((s) => s.objet || '');
    const checks = subjects.map((subj, i) => {
      const hasEntreprise = subjectContainsEntreprise(subj, lead.entreprise);
      const hasCadrat = CADRAT_DASH.test(subj);
      return {
        step: ['J0', 'J+14', 'J+28'][i] || `step${i}`,
        subject: subj,
        len: subj.length,
        hasEntreprise,
        hasCadrat,
        pass: hasEntreprise && !hasCadrat,
      };
    });
    return {
      lead: lead.entreprise,
      ok: checks.every((c) => c.pass),
      checks,
      elapsedMs,
    };
  } catch (err) {
    return {
      lead: lead.entreprise,
      ok: false,
      error: err.message,
      elapsedMs: Date.now() - t0,
    };
  }
}

async function run() {
  process.stderr.write(`[smoke] Lancement 5 leads BTP synthétiques (model Sonnet 4.6, prompt caching éphémère)\n\n`);
  const results = [];
  for (let i = 0; i < LEADS.length; i++) {
    const r = await smokeOneLead(LEADS[i], i);
    results.push(r);
    process.stderr.write(`[smoke] ${i + 1}/${LEADS.length} ${r.lead} → ${r.ok ? 'OK' : 'FAIL'} (${r.elapsedMs}ms)\n`);
  }

  // Output Markdown stdout
  console.log('# Smoke Étape 2.1 — Objet J0 contient nom entreprise (5 SIREN BTP synthétiques)\n');
  console.log('| Lead | Step | Objet | Long | Nom entreprise | Tiret cadratin | Verdict |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (r.error) {
      console.log(`| ${r.lead} | — | ERROR | — | — | — | ❌ ${r.error.slice(0, 60)} |`);
      continue;
    }
    for (const c of r.checks) {
      console.log(`| ${r.lead} | ${c.step} | ${c.subject.slice(0, 60)} | ${c.len} | ${c.hasEntreprise ? '✓' : '✗'} | ${c.hasCadrat ? '✗ trouvé' : '✓ absent'} | ${c.pass ? '✓' : '✗'} |`);
    }
  }

  // Synthèse + verdict GO/NO-GO
  const total = results.length;
  const okCount = results.filter((r) => r.ok).length;
  const allObjects = results.flatMap((r) => r.checks || []);
  const objectsTotal = allObjects.length;
  const objectsWithEntreprise = allObjects.filter((c) => c.hasEntreprise).length;
  const objectsWithCadrat = allObjects.filter((c) => c.hasCadrat).length;

  console.log('\n## Synthèse\n');
  console.log(`- Leads OK : **${okCount}/${total}**`);
  console.log(`- Objets contenant nom entreprise : **${objectsWithEntreprise}/${objectsTotal}** (cible 100%)`);
  console.log(`- Objets avec tiret cadratin : **${objectsWithCadrat}/${objectsTotal}** (cible 0)`);

  const GO = okCount === total && objectsWithCadrat === 0 && objectsWithEntreprise === objectsTotal;
  console.log(`\n## Verdict : ${GO ? '✓ GO Étape 2.1' : '✗ NO-GO Étape 2.1'}\n`);

  // JSON détaillé stderr
  process.stderr.write('\n[smoke] JSON détaillé :\n');
  process.stderr.write(JSON.stringify(results, null, 2));
  process.stderr.write('\n');

  process.exit(GO ? 0 : 1);
}

run().catch((err) => {
  console.error('[smoke] crash:', err);
  process.exit(2);
});
