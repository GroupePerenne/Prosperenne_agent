'use strict';

/**
 * Orchestrateur public — prospect-profiler V0.
 *
 * Transforme un SIREN + email résolu en briefing d'approche structuré :
 *   - companyProfile         (couche A) — fiche entreprise  [Jalon 1]
 *   - decisionMakerProfile   (couche B) — fiche décideur    [Jalon 2]
 *   - discScore              — profil comportemental         [Jalon 2, inclus dans B]
 *   - accroche (hook/angle)  — via Sonnet 4.6                [Jalon 2]
 *
 * Orchestration :
 *   1. Couche A et Couche B lancées en parallèle (Promise.all).
 *   2. Couche B consomme optionnellement companyTone issu du scraper de A
 *      — pour préserver la parallelisation, on passe un extrait stocké
 *      côté input si déjà connu, sinon companyTone reste null.
 *   3. Pitch appelé à la fin, reçoit companyProfile et decisionMakerProfile.
 *   4. Stockage Mem0 prospect:{siren} via storeProspect — Jalon 3.
 *
 * Fallback gracieux :
 *   - A null + B null → status 'error', accroche null
 *   - A ok XOR B ok → status 'partial', accroche générée sur ce qui est dispo
 *   - A ok AND B ok → status 'ok'
 *
 * Tests : 4 scénarios SPEC §10.2 couverts via integration/full-pipeline.test.js.
 */

const { buildCompanyProfile } = require('./companyProfile');
const { buildDecisionMakerProfile } = require('./decisionMakerProfile');
const { buildPitch } = require('./pitch');

// ─── API publique ──────────────────────────────────────────────────────────

/**
 * @param {object} input                               SPEC §3.2
 * @param {string} input.siren                         (requis)
 * @param {string} [input.firstName]
 * @param {string} [input.lastName]
 * @param {string} [input.role]
 * @param {string} [input.email]
 * @param {string} [input.companyName]
 * @param {string} [input.companyDomain]
 * @param {string} [input.companyLinkedInUrl]
 * @param {string} [input.decisionMakerLinkedInUrl]
 * @param {string} [input.beneficiaryId]
 * @param {object} [input.experimentsContext]          consumed Jalon 3
 * @param {object} [opts]
 * @param {object} [opts.context]                      Azure InvocationContext
 * @param {number} [opts.companyTimeoutMs]             Défaut 30s (SPEC §4.3)
 * @param {number} [opts.decisionMakerTimeoutMs]       Défaut 30s (SPEC §5)
 * @param {number} [opts.pitchTimeoutMs]               Défaut 20s
 * @param {boolean} [opts.skipCache]                   Forcer rebuild couche A
 * @param {boolean} [opts.simulated]                   Mode dryRun — skip tous les appels
 *                                                     LLM / scraping, retourne un stub
 *                                                     marqué simulated:true (Jalon 3)
 * @param {Function} [opts.apiGouvImpl]
 * @param {Function} [opts.scraperImpl]
 * @param {Function} [opts.searchImpl]
 * @param {Function} [opts.linkedinCompanyImpl]
 * @param {Function} [opts.linkedinProfileImpl]
 * @param {Function} [opts.discImpl]
 * @param {Function} [opts.companyLlmImpl]             LLM Haiku pour extraction A
 * @param {Function} [opts.discLlmImpl]                LLM Haiku pour DISC
 * @param {Function} [opts.pitchLlmImpl]               LLM Sonnet pour pitch
 * @returns {Promise<ProfilerOutput>}
 */
async function profileProspect(input = {}, opts = {}) {
  const started = Date.now();
  const siren = String(input.siren || '').trim();

  if (!/^\d{9}$/.test(siren)) {
    return buildErrorOutput({ siren, reason: 'invalid_siren', started });
  }

  // Mode dryRun — court-circuite tous les appels facturables (LLM Haiku
  // companyProfile, LLM Haiku DISC, LLM Sonnet pitch, Proxycurl, scraping,
  // API gouv). Sert aux smoke tests du pipeline en dev et aux tests
  // d'intégration Jalon 3. Le digest simulated reste exploitable par
  // storeProspect si on le souhaite, mais enrichAndProfileBatch skip
  // volontairement le store en dryRun pour ne pas polluer Mem0.
  if (opts.simulated) {
    return buildSimulatedOutput({ siren, input, started });
  }

  const logger = makeLogger(opts.context);
  logger.info('profiler.profileProspect.start', {
    siren,
    hasDomain: !!input.companyDomain,
    hasLinkedIn: !!input.decisionMakerLinkedInUrl,
  });

  // Couches A et B en parallèle
  const [companyProfile, decisionMakerProfile] = await Promise.all([
    buildCompanyProfile(
      {
        siren,
        companyName: input.companyName,
        companyDomain: input.companyDomain,
      },
      {
        context: opts.context,
        apiGouvImpl: opts.apiGouvImpl,
        scraperImpl: opts.scraperImpl,
        searchImpl: opts.searchImpl,
        llmImpl: opts.companyLlmImpl,
        skipCache: opts.skipCache,
        timeoutMs: opts.companyTimeoutMs,
      },
    ).catch((err) => {
      logger.warn('profiler.profileProspect.company_failed', { err: err && err.message });
      return null;
    }),
    buildDecisionMakerProfile(
      {
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        companyName: input.companyName,
        decisionMakerLinkedInUrl: input.decisionMakerLinkedInUrl,
        contactId: input.contactId,
        // companyTone n'est pas encore disponible (couches parallèles) ; V0 ok,
        // un run ultérieur pourra enrichir via storeProspect + re-run.
        companyTone: null,
      },
      {
        context: opts.context,
        linkedinImpl: opts.linkedinProfileImpl,
        searchImpl: opts.searchImpl,
        discImpl: opts.discImpl,
        llmImpl: opts.discLlmImpl,
        timeoutMs: opts.decisionMakerTimeoutMs,
      },
    ).catch((err) => {
      logger.warn('profiler.profileProspect.decisionMaker_failed', { err: err && err.message });
      return null;
    }),
  ]);

  // Pitch — uniquement si au moins une couche a ramené quelque chose
  let accroche = null;
  let pitchCost = 0;
  if (companyProfile || decisionMakerProfile) {
    const pitchRes = await buildPitch(
      {
        companyProfile,
        decisionMakerProfile,
      },
      {
        context: opts.context,
        llmImpl: opts.pitchLlmImpl,
        timeoutMs: opts.pitchTimeoutMs,
      },
    ).catch((err) => {
      logger.warn('profiler.profileProspect.pitch_failed', { err: err && err.message });
      return null;
    });
    if (pitchRes) {
      pitchCost = pitchRes.costCents || 0;
      // Si le pitch a réussi (pas d'error), on l'expose tel quel.
      // Si error → on expose quand même mais avec hook/angle null (le mail
      // downstream ignorera l'accroche et utilisera un template neutre).
      accroche = pitchRes.error
        ? null
        : {
            hook: pitchRes.hook,
            angle: pitchRes.angle,
            discAdaptation: pitchRes.discAdaptation,
            discApplied: pitchRes.discApplied,
            tone: pitchRes.tone,
          };
    }
  }

  const status = deriveStatus({ companyProfile, decisionMakerProfile });

  const companyCost = (companyProfile && companyProfile.costCents) || 0;
  const dmCost = (decisionMakerProfile && decisionMakerProfile.costCents) || 0;
  const totalCost = companyCost + dmCost + pitchCost;

  const output = {
    status,
    siren,
    companyProfile: companyProfile || null,
    decisionMakerProfile: decisionMakerProfile || null,
    accroche,
    elapsedMs: Date.now() - started,
    cost_cents: totalCost,
    experimentsApplied: extractExperimentsApplied(input),
    version: 'v0',
  };

  logger.info('profiler.profileProspect.done', {
    siren,
    status,
    hasAccroche: !!accroche,
    cost_cents: totalCost,
    ms: output.elapsedMs,
  });

  return output;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function deriveStatus({ companyProfile, decisionMakerProfile }) {
  const hasA = !!companyProfile;
  const hasB = !!decisionMakerProfile;
  if (!hasA && !hasB) return 'error';
  if (hasA && hasB) return 'ok';
  return 'partial';
}

function extractExperimentsApplied(input) {
  const ctx = input && input.experimentsContext;
  if (!ctx || !Array.isArray(ctx.applied)) return [];
  return ctx.applied
    .filter((x) => x && typeof x.experiment_id === 'string' && typeof x.variant === 'string')
    .map((x) => ({ experiment_id: x.experiment_id, variant: x.variant }));
}

function buildErrorOutput({ siren, reason, started }) {
  return {
    status: 'error',
    siren,
    companyProfile: null,
    decisionMakerProfile: null,
    accroche: null,
    elapsedMs: Date.now() - started,
    cost_cents: 0,
    experimentsApplied: [],
    version: 'v0',
    error: reason,
  };
}

/**
 * Stub dryRun — retourne la forme normale du profileProspect output avec
 * tous les champs sentinelles à 0/null, sauf `simulated:true` et les champs
 * propagés depuis l'input pour que les traces aval restent lisibles.
 */
function buildSimulatedOutput({ siren, input, started }) {
  const companyName = input && input.companyName;
  return {
    status: 'ok',
    siren,
    simulated: true,
    companyProfile: {
      siren,
      nomEntreprise: companyName || null,
      simulated: true,
    },
    decisionMakerProfile: {
      firstName: input && input.firstName,
      lastName: input && input.lastName,
      currentRole: input && input.role,
      discScore: {
        primary: 'unknown',
        secondary: null,
        confidence: 0,
        tone: 'unknown',
        signals: [],
        inferredPainPoints: [],
      },
      simulated: true,
    },
    accroche: null,
    elapsedMs: Date.now() - started,
    cost_cents: 0,
    experimentsApplied: extractExperimentsApplied(input),
    version: 'v0',
  };
}

function makeLogger(context) {
  if (!context) return { info: () => {}, warn: () => {} };
  const info = context.info || (context.log && context.log.info) || context.log || (() => {});
  const warn = context.warn || (context.log && context.log.warn) || info;
  return {
    info: (msg, payload) => { try { info(msg, payload); } catch { /* noop */ } },
    warn: (msg, payload) => { try { warn(msg, payload); } catch { /* noop */ } },
  };
}

module.exports = {
  profileProspect,
  // Exposés pour tests uniquement
  _deriveStatus: deriveStatus,
  _extractExperimentsApplied: extractExperimentsApplied,
};
