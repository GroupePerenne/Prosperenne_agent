'use strict';

/**
 * Génération de l'accroche narrative (hook + angle + adaptation DISC).
 *
 * Modèle : Claude Sonnet 4.6 explicitement. Haiku est trop plat pour une
 * accroche narrative ; Sonnet justifie son surcoût sur ces 2-3 phrases.
 * C'est le seul appel Sonnet du chantier profiler — le reste (extraction
 * entreprise, inférence DISC) reste en Haiku pour la marge budgétaire.
 *
 * Coût estimé : input ~2500 tokens × 3€/1M + output ~400 tokens × 15€/1M ≈ 0.015€.
 * En-dessous du budget SPEC §6 (0.05€).
 *
 * Règles absolues (SPEC §6 + règle d'honneur David) :
 *   - Pas de "J'ai vu que vous étiez dans le secteur X" générique
 *   - Référencer un signal concret (recrutement, levée, clients, publication, rôle)
 *   - Si discScore.confidence >= 0.4 → adapter ton selon grille DISC
 *   - Sinon → ton neutre équilibré
 *   - Max 3 phrases pour hook, 1 phrase angle
 *   - Français impeccable, pas d'anglicismes startup
 *   - Pas d'invention (chiffres, benchmarks, cas clients non sourçables)
 *
 * Output stable (SPEC §3.2) :
 *   { hook: string, angle: string, discAdaptation: string, elapsedMs, costCents }
 *
 * Dégradation :
 *   - Pas de companyProfile ET pas de decisionMakerProfile → retourne null
 *     (le caller passe status='error', template mail neutre)
 *   - LLM échoue → retourne null avec error='llm_error'
 *   - JSON invalide → retourne null avec error='parse_error'
 */

const { callClaude, parseJson, MODEL_SONNET } = require('../anthropic');
const { shouldAdaptToneToDISC } = require('../disc-profiler');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_TOKENS = 700;

const SYSTEM_PROMPT = `Tu es un consultant commercial B2B français expérimenté. À partir d'une fiche entreprise et d'une fiche décideur, tu rédiges une ACCROCHE PERSONNALISÉE pour ouvrir un mail de prise de contact cold.

RÈGLES ABSOLUES (non négociables) :
- Pas de formule bateau ("j'espère que ce message vous trouve en forme", "Suite à nos échanges", "J'ai vu que vous étiez dans le secteur X").
- Référence OBLIGATOIRE d'un signal concret issu des fiches : recrutement récent, levée, clients visibles, publication, parcours, rôle.
- Max 3 phrases pour le hook. 1 phrase pour l'angle. Français impeccable, pas d'anglicismes startup ("disrupter", "scaler", "growth hacker").
- Tu n'inventes RIEN. Aucun chiffre, benchmark, cas client ou nom qui ne soit pas explicitement dans les fiches fournies.
- Tu ne promets RIEN : pas de garantie de résultat, de délai, de taux.
- Si le décideur a été identifié avec un profil DISC >= 0.4 confidence, tu adaptes le ton selon la grille :
    D (Dominant)  : direct, orienté résultat, phrases courtes, pas de small talk.
    I (Influent)  : storytelling, reconnaissance, ton chaleureux, créer du lien.
    S (Stable)    : ton rassurant, pragmatique, références solides, rythme posé.
    C (Conforme)  : données, méthodologie, rigueur, structure visible.
  Si confidence < 0.4 OU primary = unknown → ton NEUTRE ÉQUILIBRÉ, sans marqueurs DISC.
- Le champ discAdaptation explique en une phrase COMMENT tu as adapté (ou pourquoi tu es resté neutre), pour traçabilité commerciale.

Tu réponds UNIQUEMENT en JSON valide, sans texte autour, sans fences.

SCHÉMA :
{
  "hook": string,
  "angle": string,
  "discAdaptation": string
}`;

/**
 * Génère l'accroche.
 *
 * @param {object} input
 * @param {object} [input.companyProfile]         output couche A
 * @param {object} [input.decisionMakerProfile]   output couche B
 * @param {object} [opts]
 * @param {Function} [opts.llmImpl]
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.context]
 * @returns {Promise<{hook, angle, discAdaptation, elapsedMs, costCents, discApplied, tone}|null>}
 */
async function buildPitch(input = {}, opts = {}) {
  const started = Date.now();
  const logger = makeLogger(opts.context);

  const company = input.companyProfile || null;
  const decisionMaker = input.decisionMakerProfile || null;

  if (!company && !decisionMaker) {
    logger.warn('profiler.pitch.no_input');
    return null;
  }

  const discApplied = shouldAdaptToneToDISC(decisionMaker && decisionMaker.discScore);
  const userPrompt = buildUserPrompt({ company, decisionMaker, discApplied });

  const impl = opts.llmImpl || callClaude;
  let raw;
  try {
    raw = await withTimeout(
      impl({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        model: MODEL_SONNET,
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: 0.7,
      }),
      opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    logger.warn('profiler.pitch.llm_error', { err: err && err.message });
    return {
      hook: null,
      angle: null,
      discAdaptation: null,
      elapsedMs: Date.now() - started,
      costCents: 0,
      discApplied,
      tone: null,
      error: 'llm_error',
    };
  }

  let parsed;
  try {
    parsed = parseJson(raw.text);
  } catch (err) {
    logger.warn('profiler.pitch.parse_error', {
      err: err && err.message,
      sample: String(raw.text || '').slice(0, 120),
    });
    return {
      hook: null,
      angle: null,
      discAdaptation: null,
      elapsedMs: Date.now() - started,
      costCents: 0,
      discApplied,
      tone: null,
      error: 'parse_error',
    };
  }

  const hook = typeof parsed.hook === 'string' && parsed.hook.trim() ? parsed.hook.trim() : null;
  const angle = typeof parsed.angle === 'string' && parsed.angle.trim() ? parsed.angle.trim() : null;
  const discAdaptation =
    typeof parsed.discAdaptation === 'string' && parsed.discAdaptation.trim()
      ? parsed.discAdaptation.trim()
      : null;

  if (!hook || !angle) {
    logger.warn('profiler.pitch.incomplete', { hasHook: !!hook, hasAngle: !!angle });
    return {
      hook,
      angle,
      discAdaptation,
      elapsedMs: Date.now() - started,
      costCents: estimateCost(userPrompt, raw.text),
      discApplied,
      tone: (decisionMaker && decisionMaker.tone) || null,
      error: 'incomplete_output',
    };
  }

  return {
    hook,
    angle,
    discAdaptation: discAdaptation || (discApplied ? 'Adaptation DISC appliquée' : 'Ton neutre (DISC non fiable)'),
    elapsedMs: Date.now() - started,
    costCents: estimateCost(userPrompt, raw.text),
    discApplied,
    tone: (decisionMaker && decisionMaker.tone) || null,
  };
}

// ─── construction du prompt utilisateur ──────────────────────────────────

function buildUserPrompt({ company, decisionMaker, discApplied }) {
  const companyBlock = company
    ? `
[FICHE ENTREPRISE]
Nom : ${safe(company.nomEntreprise)}
SIREN : ${safe(company.siren)}
Activité : ${safe(company.activity)}
Spécialités : ${listOrNone(company.specialties)}
Clients visibles : ${listOrNone(company.mainClients)}
Signaux actualité : ${signalsBlock(company.recentSignals)}
Commune : ${safe(company.commune)}
`
    : '[FICHE ENTREPRISE non disponible]';

  const dmBlock = decisionMaker
    ? `
[FICHE DÉCIDEUR]
Nom : ${safe(decisionMaker.fullName)}
Rôle : ${safe(decisionMaker.career && decisionMaker.career.currentRole)}
Ancienneté poste : ${safe(decisionMaker.career && decisionMaker.career.tenure)}
Parcours récent : ${listOrNone(decisionMaker.career && decisionMaker.career.previousRoles)}
Publications : ${listOrNone(decisionMaker.publications)}
Pain points inférés : ${listOrNone(decisionMaker.inferredPainPoints)}
Ton perçu : ${safe(decisionMaker.tone)}
Profil DISC : ${formatDISC(decisionMaker.discScore)}
`
    : '[FICHE DÉCIDEUR non disponible — bascule ton neutre obligatoire]';

  const adaptationDirective = discApplied
    ? 'ADAPTATION DISC ACTIVE : applique la grille selon le profil ci-dessus.'
    : 'ADAPTATION DISC INACTIVE : garde un ton neutre équilibré.';

  return `${companyBlock}
${dmBlock}

${adaptationDirective}

Rédige l'accroche en JSON strict (hook + angle + discAdaptation).`;
}

function safe(v) {
  if (v === null || v === undefined) return '(non renseigné)';
  const s = String(v).trim();
  return s || '(non renseigné)';
}

function listOrNone(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '(aucun)';
  return arr.map((x) => `- ${x}`).join(' ');
}

function signalsBlock(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return '(aucun)';
  return signals
    .map((s) => `[${s.type || 'other'}] ${s.description || ''}${s.date ? ` (${s.date})` : ''}`)
    .join(' ; ');
}

function formatDISC(disc) {
  if (!disc) return '(non inféré)';
  if (disc.primary === 'unknown') return 'unknown (confidence 0)';
  const conf = typeof disc.confidence === 'number' ? disc.confidence.toFixed(2) : '?';
  const secondary = disc.secondary ? `/${disc.secondary}` : '';
  return `${disc.primary}${secondary} confidence=${conf}`;
}

function estimateCost(userPrompt, outputText) {
  // Sonnet 4.6 pricing ~3€/1M input, 15€/1M output. 4 chars ≈ 1 token.
  const inputTokens = Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4);
  const outputTokens = Math.ceil((outputText || '').length / 4);
  return Math.round((inputTokens * 3 + outputTokens * 15) / 1000);
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let handle;
  const timer = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`pitch generation timed out after ${ms}ms`);
      e.name = 'AbortError';
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(handle));
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
  buildPitch,
  _buildUserPrompt: buildUserPrompt,
  _formatDISC: formatDISC,
  SYSTEM_PROMPT,
};
