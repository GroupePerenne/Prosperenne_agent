#!/usr/bin/env node
/**
 * smoke-david-e2e.js — Validation E2E de la chaîne David post-bascule
 * vers la Function App `pereneo-mail-sender`.
 *
 * ─── Schéma LeadBase V1 (étape 2 audit) ─────────────────────────────────────
 *
 * Table Azure Storage : LeadBase (storage account = AzureWebJobsStorage)
 * Adapter : shared/adapters/leadbase/leadbase-table.js (read-only en prod)
 *
 * Champs lus par `LeadBaseAdapter.queryLeads` (voir SELECT_FIELDS) :
 *   - PartitionKey       string  département INSEE 2 chars (ex "75", "92")
 *   - RowKey             string  identifiant unique entité (souvent siren)
 *   - siren              string  9 chiffres
 *   - nom                string  raison sociale
 *   - codeNaf            string  format "XX.XXX" (ex "70.22Z")
 *   - ville              string
 *   - trancheEffectif    string  code INSEE (ex "11" = 10-19, "12" = 20-49)
 *   - latitude           string  décimal
 *   - longitude          string  décimal
 *   - dirigeants         string  JSON.stringify([{prenoms, nom, email,
 *                                fonction, role}])
 *
 * Filtrage queryLeads : OData filter combinant département (PartitionKey),
 * NAF (codeNaf), effectif (trancheEffectif). Voir buildFilter.
 *
 * ─── Flow Lead Selector → enrichBatch → bootstrapSequence ───────────────────
 *
 * Entry point HTTP : POST /api/runLeadSelectorForConsultant
 *   body: { consultantId, batchSize, dryRun }
 *
 * 1. rebuildConsultantFromMem0(consultantId) : retrieveConsultant Mem0 →
 *    parse brief depuis memories
 * 2. enrichAndProfileBatchForConsultant({ brief, beneficiaryId, ... }) :
 *    a. selectCandidatesForConsultant → LeadBaseAdapter.queryLeads
 *       (mapping secteurs→NAF + effectif→tranche + zone→départements)
 *    b. Pour chaque candidat → leadExhauster.resolve (patterns/Dropcontact)
 *    c. Pour chaque lead enriché → profileProspect (DISC + accroche Sonnet)
 *       → mem0.storeProspect
 * 3. launchSequenceForConsultant({ consultant, brief, leads, context }) :
 *    Pour chaque lead →
 *    a. ensureOrg / ensurePerson Pipedrive
 *    b. checkLeadCooldown (opt_out_until / retry_available_after)
 *    c. resolveOrCreateDeal (dédup intra-pipe Prospérenne)
 *    d. agent.bootstrapSequence (martin ou mila selon brief.prospecteur ou
 *       alterné si "both")
 * 4. bootstrapSequence (shared/worker.js) :
 *    a. findExistingDealsAcrossAllPipes (skip si match clair, escalade flou)
 *    b. resolveMem0Enrichments (retrieveProspect + retrievePatterns)
 *    c. generateSequence Claude Sonnet (5 messages J0/J+4/J+10/J+18/J+28)
 *    d. Si J0 dans créneau ouvré 9-11h Paris → sendMail Graph + logEmailSent
 *       Sinon → scheduleRelance (queue mila-relances)
 *    e. Schedule J+4..J+28 dans queue avec offsets jours ouvrés
 *
 * Hooks Pipedrive : pipedrive.createDeal (resolveOrCreateDeal),
 *   pipedrive.logEmailSent (post-sendMail), pipedrive.logEmailOpened
 *   (via trackOpen pixel), pipedrive.updateDealStage (handle*Reply de David).
 *
 * ─── Choix du smoke (étape 3) ───────────────────────────────────────────────
 *
 * Option retenue : WRAPPER ONE-SHOT court-circuitant Lead Selector / exhauster /
 * profileProspect, qui appelle directement `launchSequenceForConsultant` avec
 * un brief minimal et un lead pré-construit.
 *
 * Justification :
 *  - Le but est de valider l'infra E2E (Pipedrive, Graph sendMail, queue,
 *    pixel, avatarProxy), pas la qualité de la séquence ou le matching brief
 *    ↔ LeadBase.
 *  - runLeadSelectorForConsultant exige un brief Mem0 préalable + une
 *    couverture LeadBase cohérente avec NAF/effectif/zone — bruit pour ce
 *    smoke.
 *  - leadExhauster appelle Dropcontact ($) — on évite.
 *  - profileProspect appelle deux LLM Anthropic ($, latence) — on évite.
 *  - L'option dryRun de runLeadSelectorForConsultant skippe ces coûts mais
 *    skippe aussi launchSequenceForConsultant — donc pas de mail, pas de deal.
 *
 * L'autorisation est donnée explicitement par l'utilisateur dans la consigne
 * (« Si runLeadSelectorForConsultant n'est pas exposé proprement, tu peux
 * écrire un wrapper one-shot qui appelle directement bootstrapSequence avec
 * un mock de lead. Documente le choix. »).
 *
 * Côté coût LLM : bootstrapSequence appelle quand même generateSequence
 * (Anthropic Sonnet, 1 call par lead pour générer les 5 messages). C'est un
 * coût indirect inévitable si on veut valider que le mail J0 part vraiment.
 * Le smoke envoie un seul lead, donc un seul call Anthropic.
 *
 * ─── Pitfall détecté pendant l'audit ────────────────────────────────────────
 *
 * `agents/martin/identity.json` et `agents/mila/identity.json` portent un
 * `tracking.pixel_endpoint` HARDCODÉ vers l'ancienne FA :
 *   https://oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net
 *
 * Conséquence : un mail J0 envoyé aujourd'hui aura son pixel pointant vers
 * l'ANCIENNE FA, pas vers pereneo-mail-sender. Le critère 3 (« Click pixel
 * → événement Pipedrive ») sera donc tracé sur l'ancienne FA tant que
 * l'ancienne FA reste vivante. À corriger post-bascule (PR séparée).
 *
 * Le critère 2 (avatar visible) utilise `FUNCTION_APP_URL` (env var, lue
 * dynamiquement) — le smoke override cette var pour pointer vers la nouvelle
 * FA, donc OK.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/smoke-david-e2e.js                # smoke complet (envoie mail)
 *   node scripts/smoke-david-e2e.js --dry-run      # validation env, pas d'envoi
 *   node scripts/smoke-david-e2e.js --cleanup      # supprime les objets [TEST]
 *   node scripts/smoke-david-e2e.js --include-onboarding
 *                                                  # ajoute test choixNiveau
 *
 * Variables d'env requises (lues depuis local.settings.json) :
 *   AzureWebJobsStorage, PIPEDRIVE_TOKEN, PIPEDRIVE_COMPANY_DOMAIN,
 *   PIPEDRIVE_PIPELINE_ID, PIPEDRIVE_STAGE_NEW, PIPEDRIVE_ORG_FIELD_SIREN,
 *   PIPEDRIVE_FIELD_AGENT_SENDER, PIPEDRIVE_FIELD_OPT_OUT_UNTIL,
 *   PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER, ANTHROPIC_API_KEY, MEM0_API_KEY,
 *   TENANT_ID, CLIENT_ID, CLIENT_SECRET, MARTIN_EMAIL, DAVID_EMAIL.
 *
 * Identifiants de test stockés dans `scripts/.smoke-david-state.json` (gitignored
 * via .gitignore racine — fichier de scratch local).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constantes du smoke ───────────────────────────────────────────────────
const SMOKE_TAG = '[TEST SMOKE 27-04]';
const SMOKE_SIREN = '852115740';
const SMOKE_DEPARTEMENT = '75';
const SMOKE_NAF = '70.22Z';
const SMOKE_TRANCHE = '11';
const SMOKE_CITY = 'PARIS';
const SMOKE_LAT = '48.8566';
const SMOKE_LON = '2.3522';
const PROSPECT_EMAIL = 'paul.rudler@oseys.fr';
const PROSPECT_FIRST = 'Paul';
const PROSPECT_LAST = 'Rudler';
const COMPANY_NAME = `OSEYS RESEAU SAS ${SMOKE_TAG}`;
const PEREENO_FA_URL = 'https://pereneo-mail-sender.azurewebsites.net';
const STATE_FILE = path.resolve(__dirname, '.smoke-david-state.json');

// ─── CLI parsing ───────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const FLAG_CLEANUP = args.has('--cleanup');
const FLAG_DRYRUN = args.has('--dry-run');
const FLAG_ONBOARDING = args.has('--include-onboarding');

// ─── Bootstrap env ─────────────────────────────────────────────────────────
function loadLocalSettings() {
  const p = path.resolve(__dirname, '..', 'local.settings.json');
  if (!fs.existsSync(p)) {
    fail(`local.settings.json introuvable (${p}). Récupère via: func azure functionapp fetch-app-settings pereneo-mail-sender`);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(cfg.Values || {})) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function applyEnvOverrides() {
  // Avatar pointe vers la nouvelle FA (testé dans worker.js → renderEmailHtml)
  process.env.FUNCTION_APP_URL = PEREENO_FA_URL;
  // Smoke n'utilise aucun BCC Pipedrive (consultant fictif)
  process.env.PIPEDRIVE_BCC_MORGANE = '';
  process.env.PIPEDRIVE_BCC_JOHNNY = '';
}

function fail(msg) {
  process.stderr.write(`\n[FAIL] ${msg}\n`);
  process.exit(2);
}

function info(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

// ─── Pré-vol checks ────────────────────────────────────────────────────────
function preflightEnv() {
  const required = [
    'AzureWebJobsStorage',
    'PIPEDRIVE_TOKEN',
    'PIPEDRIVE_COMPANY_DOMAIN',
    'PIPEDRIVE_PIPELINE_ID',
    'PIPEDRIVE_STAGE_NEW',
    'PIPEDRIVE_ORG_FIELD_SIREN',
    'TENANT_ID',
    'CLIENT_ID',
    'CLIENT_SECRET',
    'MARTIN_EMAIL',
    'DAVID_EMAIL',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    fail(`Variables d'env manquantes : ${missing.join(', ')}`);
  }
  if (FLAG_DRYRUN) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY manquant — bootstrapSequence ne pourra pas générer la séquence.");
  }
}

// ─── Pipedrive helpers (utilise le module shared) ──────────────────────────
async function setupPipedrive(pipedrive) {
  // Idempotent : si un state file existe avec orgId+personId, on les réutilise
  // (vérifie d'abord que les objets existent encore côté Pipedrive et n'ont
  // pas été archivés [CLEANED-UP]). Sinon création.
  const previous = readState();
  if (previous && previous.orgId && previous.personId) {
    try {
      const [org, person] = await Promise.all([
        pipedriveCall(`/organizations/${previous.orgId}`),
        pipedriveCall(`/persons/${previous.personId}`),
      ]);
      const orgUsable = org && org.active_flag !== false && !String(org.name || '').includes('[CLEANED-UP]');
      const personUsable = person && person.active_flag !== false && !String(person.name || '').includes('[CLEANED-UP]');
      if (orgUsable && personUsable) {
        info(`Setup Pipedrive : réutilise state existant org=${previous.orgId} person=${previous.personId}`);
        return { orgId: previous.orgId, personId: previous.personId };
      }
      info(`Setup Pipedrive : state file présent mais objets inutilisables (cleaned-up?), recréation`);
    } catch (e) {
      info(`Setup Pipedrive : state file présent mais lookup KO (${e.message}), recréation`);
    }
  }

  info(`Setup Pipedrive : création org + person ${SMOKE_TAG}`);
  const sirenFieldKey = process.env.PIPEDRIVE_ORG_FIELD_SIREN;

  // Crée l'org via call() bas niveau pour passer le custom field SIREN au
  // moment de la création (le helper `createOrganization` n'expose pas les
  // champs custom).
  const orgPayload = {
    name: COMPANY_NAME,
    address: `1 rue de Rivoli, ${SMOKE_CITY}`,
  };
  if (sirenFieldKey) orgPayload[sirenFieldKey] = SMOKE_SIREN;
  const org = await pipedriveCall('/organizations', 'POST', orgPayload);
  info(`  → org id=${org.id} name="${org.name}"`);

  const person = await pipedrive.createPerson({
    name: `${PROSPECT_FIRST} ${PROSPECT_LAST} ${SMOKE_TAG}`,
    email: PROSPECT_EMAIL,
    orgId: org.id,
  });
  info(`  → person id=${person.id} email=${PROSPECT_EMAIL}`);

  return { orgId: org.id, personId: person.id };
}

async function pipedriveCall(p, method = 'GET', body = null, query = {}) {
  const base = `https://${process.env.PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v1`;
  const url = new URL(`${base}${p}`);
  url.searchParams.set('api_token', process.env.PIPEDRIVE_TOKEN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url.toString(), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.error || data.error_info || `HTTP ${res.status}`;
    throw new Error(`Pipedrive ${method} ${p} → ${msg}`);
  }
  return data.data;
}

// ─── Build mocks (brief + lead) ────────────────────────────────────────────
function buildSmokeBrief() {
  // Tutoiement, ton direct cordial, prospecteur=martin (assignment forcé pour
  // que le smoke ait toujours le même agent expéditeur — on n'évalue pas l'A/B).
  return {
    nom: 'Smoke David Test',
    email: 'david-smoke@oseys.fr',
    offre: 'Test infra E2E post-bascule pereneo-mail-sender',
    ton: 'direct_cordial',
    tutoiement: true,
  };
}

function buildSmokeLead() {
  return {
    siren: SMOKE_SIREN,
    prenom: PROSPECT_FIRST,
    nom: PROSPECT_LAST,
    entreprise: COMPANY_NAME,
    email: PROSPECT_EMAIL,
    secteur: SMOKE_NAF,
    ville: SMOKE_CITY,
    contexte: `${COMPANY_NAME} · NAF ${SMOKE_NAF} · tranche ${SMOKE_TRANCHE} · ${SMOKE_CITY}`,
  };
}

// ─── Phase 1 — smoke principal ─────────────────────────────────────────────
async function runSmoke() {
  preflightEnv();
  applyEnvOverrides();

  // Lazy require après env apply
  const pipedrive = require('../shared/pipedrive');
  const { launchSequenceForConsultant } = require('../agents/david/orchestrator');

  // 1. Setup Pipedrive (org + person [TEST])
  const { orgId, personId } = await setupPipedrive(pipedrive);

  const state = {
    createdAt: new Date().toISOString(),
    orgId,
    personId,
    dealIds: [],
    tag: SMOKE_TAG,
    siren: SMOKE_SIREN,
    via: 'launchSequenceForConsultant_direct',
  };
  writeState(state);

  if (FLAG_DRYRUN) {
    info('--dry-run : Pipedrive setup OK, skip launchSequenceForConsultant.');
    info(`  state écrit dans ${STATE_FILE}`);
    printSummary({ dryRun: true, state });
    return;
  }

  // 2. Trigger launchSequenceForConsultant — single lead, prospecteur=martin
  const consultant = buildSmokeBrief();
  const brief = { prospecteur: 'martin' };
  const leads = [buildSmokeLead()];

  info('Appel launchSequenceForConsultant (1 lead, prospecteur=martin)…');
  const ctx = makeConsoleContext();
  let results;
  try {
    results = await launchSequenceForConsultant({ consultant, brief, leads, context: ctx });
  } catch (err) {
    info(`  launchSequenceForConsultant THROW: ${err.message}`);
    throw err;
  }
  info(`Résultats orchestrator : ${JSON.stringify(results, null, 2)}`);

  // 3. Récupère le dealId créé pour cleanup
  for (const r of results || []) {
    if (r && r.dealId) state.dealIds.push(r.dealId);
  }
  writeState(state);

  // 4. Onboarding (critère 4) si demandé
  let onboardingResult = null;
  if (FLAG_ONBOARDING) {
    onboardingResult = await triggerOnboarding();
    state.onboarding = onboardingResult;
    writeState(state);
  }

  printSummary({ results, state, onboardingResult });
}

function makeConsoleContext() {
  return {
    log: (...a) => console.log('  [ctx]', ...a),
    info: (...a) => console.log('  [ctx.info]', ...a),
    warn: (...a) => console.warn('  [ctx.warn]', ...a),
    error: (...a) => console.error('  [ctx.error]', ...a),
  };
}

// ─── Onboarding (critère 4) ─────────────────────────────────────────────────
async function triggerOnboarding() {
  // Appelle directement l'endpoint sendOnboarding sur la nouvelle FA pour
  // tester le flow choixNiveau (mail avec 3 boutons).
  // sendOnboarding est en authLevel=function → besoin d'une function key.
  const code = process.env.SEND_ONBOARDING_FUNC_CODE || '';
  const url = `${PEREENO_FA_URL}/api/sendOnboarding${code ? `?code=${code}` : ''}`;
  const urlMasked = code ? url.replace(code, code.slice(0, 8) + '…[redacted]') : url;
  info(`Trigger onboarding flow vers ${urlMasked}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prenom: PROSPECT_FIRST,
      nom: PROSPECT_LAST,
      email: PROSPECT_EMAIL,
    }),
  });
  const txt = await res.text();
  info(`  HTTP ${res.status} — ${txt.slice(0, 200)}`);
  return { status: res.status, body: txt.slice(0, 500) };
}

// ─── Cleanup ───────────────────────────────────────────────────────────────
async function runCleanup() {
  applyEnvOverrides();
  const state = readState();
  if (!state) {
    info(`Pas de state file (${STATE_FILE}) — rien à nettoyer.`);
    return;
  }
  info(`State chargé : ${JSON.stringify(state)}`);

  const errors = [];
  // Purge queue mila-relances pour les jobs dealId == state.dealIds
  if (state.dealIds && state.dealIds.length > 0) {
    try {
      const { purgeByDealId } = require('../shared/queue');
      for (const dealId of state.dealIds) {
        const r = await purgeByDealId(dealId);
        info(`  queue purged dealId=${dealId} → ${r.purged} message(s)`);
      }
    } catch (e) {
      errors.push(`queue purge: ${e.message}`);
    }
  }

  // NB : le token Pipedrive (rôle non-admin) ne permet ni DELETE ni
  // active_flag=false. On rabat sur un renommage [CLEANED-UP] pour
  // permettre à Paul de supprimer manuellement via l'UI Pipedrive.

  // Tente DELETE deals (les deals fermés = OK pour cleanup, parfois autorisé)
  for (const dealId of state.dealIds || []) {
    try {
      await pipedriveCall(`/deals/${dealId}`, 'DELETE');
      info(`  deal ${dealId} deleted`);
    } catch (e) {
      // Fallback : rename + tag pour identification
      try {
        await pipedriveCall(`/deals/${dealId}`, 'PUT', {
          title: `[CLEANED-UP] deal ${dealId}`,
          status: 'lost',
          lost_reason: 'smoke test cleanup',
        });
        info(`  deal ${dealId} marked lost+renamed (DELETE refusé)`);
      } catch (e2) {
        errors.push(`deal ${dealId}: ${e.message} / fallback ${e2.message}`);
      }
    }
  }

  if (state.personId) {
    try {
      await pipedriveCall(`/persons/${state.personId}`, 'DELETE');
      info(`  person ${state.personId} deleted`);
    } catch (e) {
      try {
        await pipedriveCall(`/persons/${state.personId}`, 'PUT', {
          name: `[CLEANED-UP] person ${state.personId}`,
        });
        info(`  person ${state.personId} renamed (DELETE refusé)`);
      } catch (e2) {
        errors.push(`person ${state.personId}: ${e.message} / fallback ${e2.message}`);
      }
    }
  }
  // Toutes les orgs (orgId historique + orgIds multiples si l'orchestrator
  // a créé un doublon malgré l'idempotence — peut arriver si search Pipedrive
  // a une latence d'indexation au moment du second run)
  const orgIds = Array.isArray(state.orgIds) && state.orgIds.length > 0
    ? state.orgIds
    : (state.orgId ? [state.orgId] : []);
  for (const orgId of orgIds) {
    try {
      await pipedriveCall(`/organizations/${orgId}`, 'DELETE');
      info(`  org ${orgId} deleted`);
    } catch (e) {
      try {
        await pipedriveCall(`/organizations/${orgId}`, 'PUT', {
          name: `[CLEANED-UP] org ${orgId}`,
        });
        info(`  org ${orgId} renamed (DELETE refusé)`);
      } catch (e2) {
        errors.push(`org ${orgId}: ${e.message} / fallback ${e2.message}`);
      }
    }
  }

  if (errors.length > 0) {
    info(`Cleanup partiel — ${errors.length} erreur(s) :`);
    for (const e of errors) info(`  ! ${e}`);
    info('Suppression manuelle via UI Pipedrive recommandée pour les objets [CLEANED-UP].');
  } else {
    info('Cleanup OK — objets supprimés ou renommés [CLEANED-UP].');
  }
  clearState();
}

// ─── Récap final ───────────────────────────────────────────────────────────
function printSummary({ results, state, dryRun, onboardingResult }) {
  const linesA = ['', '═══════════════════════════════════════════════════════════════════════'];
  linesA.push('SMOKE DAVID E2E — RÉCAP DES 4 CRITÈRES DE SORTIE');
  linesA.push('═══════════════════════════════════════════════════════════════════════');
  if (dryRun) {
    linesA.push('Mode --dry-run : seul le setup Pipedrive a été testé.');
    linesA.push(`  Pipedrive org=${state.orgId}, person=${state.personId}`);
    linesA.push('Pour le vrai smoke : retire --dry-run.');
    process.stdout.write(linesA.join('\n') + '\n\n');
    return;
  }

  // Critère 1 — mail envoyé (auto) : vrai si bootstrap a renvoyé sent: ['J0']
  const r0 = (results && results[0]) || {};
  const c1Auto = Array.isArray(r0.sent) && r0.sent.includes('J0');
  const c1Detail = c1Auto
    ? `Mail J0 envoyé via Graph (martin@oseys.fr → ${PROSPECT_EMAIL}).`
    : (r0.scheduled
        ? `Mail J0 scheduled (hors créneau 9h-11h Paris) — vérifier la queue.`
        : `Aucun envoi : ${r0.error || r0.reason || JSON.stringify(r0)}`);

  // Critères 2, 3, 4 — visuels, à confirmer par Paul
  process.stdout.write(linesA.join('\n') + '\n');
  process.stdout.write('\n');
  process.stdout.write(`Critère 1 (mail envoyé)  : ${c1Auto ? 'GO  ✓' : 'NO-GO ✗'}\n`);
  process.stdout.write(`  → ${c1Detail}\n`);
  process.stdout.write(`Critère 2 (avatar visible)         : VÉRIF VISUELLE PAUL\n`);
  process.stdout.write(`  → Ouvrir le mail dans Outlook ${PROSPECT_EMAIL}, vérifier l'avatar.\n`);
  process.stdout.write(`  → URL avatar: ${PEREENO_FA_URL}/api/avatarProxy?user=martin\n`);
  process.stdout.write(`Critère 3 (click pixel → Pipedrive): VÉRIF VISUELLE PAUL\n`);
  process.stdout.write(`  → ATTENTION : pixel_endpoint dans agents/martin/identity.json pointe\n`);
  process.stdout.write(`     encore vers l'ANCIENNE FA (oseys-mail-sender-c8...francecentral).\n`);
  process.stdout.write(`     Le tracking se fera donc sur l'ancienne FA, pas sur pereneo-mail-sender.\n`);
  process.stdout.write(`     → À corriger en post-bascule (PR séparée).\n`);
  if (FLAG_ONBOARDING) {
    const onboardingOk = onboardingResult && onboardingResult.status >= 200 && onboardingResult.status < 300;
    process.stdout.write(`Critère 4 (click choixNiveau)      : ${onboardingOk ? 'MAIL ENVOYÉ — VÉRIF VISUELLE' : 'ERREUR'}\n`);
    if (!onboardingOk) {
      process.stdout.write(`  → ${onboardingResult ? 'HTTP '+onboardingResult.status+' — '+(onboardingResult.body||'') : 'pas exécuté'}\n`);
    } else {
      process.stdout.write(`  → Ouvrir le mail d'onboarding ${PROSPECT_EMAIL}, cliquer un bouton niveau.\n`);
    }
  } else {
    process.stdout.write(`Critère 4 (click choixNiveau)      : NON TESTÉ (utilise --include-onboarding)\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(`State : ${STATE_FILE}\n`);
  process.stdout.write(`  org=${state.orgId} person=${state.personId} deals=[${(state.dealIds||[]).join(',')}]\n`);
  process.stdout.write('\n');
  process.stdout.write(`Cleanup : node scripts/smoke-david-e2e.js --cleanup\n`);
  process.stdout.write('═══════════════════════════════════════════════════════════════════════\n\n');
}

// ─── Entry point ───────────────────────────────────────────────────────────
async function main() {
  loadLocalSettings();
  if (FLAG_CLEANUP) {
    return runCleanup();
  }
  return runSmoke();
}

main().catch((err) => {
  process.stderr.write(`\n[FAIL] ${err.stack || err.message}\n`);
  process.exit(1);
});
