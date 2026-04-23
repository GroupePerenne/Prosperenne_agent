'use strict';

/**
 * Inférence DISC via LLM Haiku 4.5.
 *
 * Consomme la sortie de `signals.extractSignals()` et demande à Haiku
 * un classement DISC (D/I/S/C) en JSON strict avec :
 *   - primary       : 'D' | 'I' | 'S' | 'C' | 'unknown'
 *   - secondary     : 'D' | 'I' | 'S' | 'C' | null
 *   - confidence    : 0.0 à 1.0
 *   - signals       : extraits textuels courts justifiant la classification
 *   - inferredPainPoints : douleurs probables du décideur selon le profil
 *   - tone          : 'corporate' | 'startup' | 'technique' | 'commercial' | 'unknown'
 *
 * Règle de confidence :
 *   - >= 0.7  signal fort, adaptation DISC pleine
 *   - >= 0.4  signal moyen, adaptation DISC prudente (cf. STRATEGY §4.11.3)
 *   - <  0.4  fallback ton neutre (pas d'adaptation)
 *
 * Grille DISC (STRATEGY §4.11.3 / ARCHITECTURE §4.3) :
 *   D — Dominant  : parcours décideur, direct, ROI
 *   I — Influent  : storytelling, social, reconnaissance
 *   S — Stable    : pragmatique, opérationnel, long terme
 *   C — Conforme  : technique, chiffres, détails méthodologiques
 *
 * Règle d'honneur : si signaux insuffisants → primary='unknown',
 * confidence=0 explicitement. Jamais d'invention.
 *
 * Tests : pas d'appel Anthropic. `opts.llmImpl` injectable.
 *
 * Modèle : Haiku 4.5 (extraction factuelle, cheap, rapide). Sonnet
 * réservé aux tâches narratives (pitch.js).
 */

const { callClaude, parseJson, MODEL_HAIKU } = require('../anthropic');
const { extractSignals, hasEnoughSignalsForInference } = require('./signals');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_TOKENS = 600;

const SYSTEM_PROMPT = `Tu es un analyste comportemental B2B français. À partir de signaux textuels (parcours, publications, ton, rôle), tu infères le profil DISC d'un décideur : D (Dominant), I (Influent), S (Stable), C (Conforme).

GRILLE DE RÉFÉRENCE (STRATEGY §4.11.3) :
- D — Dominant : parcours de décideur, ton direct, orientation résultat, ROI, pas de small talk. Fonctions typiques : CEO pragmatique, directeur général, fondateur en lancement commercial.
- I — Influent : présence sociale forte, storytelling, storytelling client, reconnaissance, ton chaleureux. Fonctions typiques : marketing, commercial terrain, communication, event.
- S — Stable : parcours long en place, opérationnel, pragmatique, rythme posé, structure et processus. Fonctions typiques : COO, directeur d'exploitation, directeur de production, DRH opérationnel.
- C — Conforme : profil technique ou financier, chiffres, méthodologie, rigueur. Fonctions typiques : CTO, DAF, directeur qualité, ingénieur senior, avocat.

RÈGLES ABSOLUES :
- Tu n'inventes RIEN. Tu ne cites aucune info absente des signaux.
- Si les signaux sont trop pauvres pour trancher, primary = "unknown", confidence = 0, signals = [], inferredPainPoints = [], tone = "unknown".
- Tu réponds UNIQUEMENT en JSON valide, sans texte autour, sans fences.
- Les champs inferredPainPoints sont des pains probables du décideur compte tenu de son profil ET de son rôle. Maximum 3 items. En français.
- Le champ signals liste les fragments (verbatim ou paraphrasés courts) qui justifient ta classification.

SCHÉMA :
{
  "primary": "D" | "I" | "S" | "C" | "unknown",
  "secondary": "D" | "I" | "S" | "C" | null,
  "confidence": 0.0 à 1.0,
  "tone": "corporate" | "startup" | "technique" | "commercial" | "unknown",
  "signals": string[],
  "inferredPainPoints": string[]
}`;

const VALID_PRIMARY = new Set(['D', 'I', 'S', 'C', 'unknown']);
const VALID_SECONDARY = new Set(['D', 'I', 'S', 'C']);
const VALID_TONE = new Set(['corporate', 'startup', 'technique', 'commercial', 'unknown']);

/**
 * @param {object} input        voir signals.extractSignals
 * @param {object} [opts]
 * @param {Function} [opts.llmImpl]   Injection tests, signature callClaude
 * @param {number}   [opts.timeoutMs]
 * @param {object}   [opts.context]   Logger Azure
 * @returns {Promise<{
 *   primary: 'D'|'I'|'S'|'C'|'unknown',
 *   secondary: 'D'|'I'|'S'|'C'|null,
 *   confidence: number,
 *   tone: string,
 *   signals: string[],
 *   inferredPainPoints: string[],
 *   elapsedMs: number,
 *   costCents: number
 * }>}
 */
async function inferDISC(input = {}, opts = {}) {
  const started = Date.now();
  const logger = makeLogger(opts.context);

  const signals = extractSignals(input);

  if (!hasEnoughSignalsForInference(signals)) {
    logger.info('profiler.disc.insufficient_signals', { count: signals.length });
    return {
      primary: 'unknown',
      secondary: null,
      confidence: 0,
      tone: 'unknown',
      signals: [],
      inferredPainPoints: [],
      elapsedMs: Date.now() - started,
      costCents: 0,
    };
  }

  const userPrompt = buildUserPrompt(input, signals);

  const impl = opts.llmImpl || callClaude;
  let raw;
  try {
    raw = await withTimeout(
      impl({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        model: MODEL_HAIKU,
        maxTokens: DEFAULT_MAX_TOKENS,
        temperature: 0,
      }),
      opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    logger.warn('profiler.disc.llm_error', { err: err && err.message });
    return {
      primary: 'unknown',
      secondary: null,
      confidence: 0,
      tone: 'unknown',
      signals: [],
      inferredPainPoints: [],
      elapsedMs: Date.now() - started,
      costCents: 0,
      error: 'llm_error',
    };
  }

  let parsed;
  try {
    parsed = parseJson(raw.text);
  } catch (err) {
    logger.warn('profiler.disc.parse_error', {
      err: err && err.message,
      sample: String(raw.text || '').slice(0, 120),
    });
    return {
      primary: 'unknown',
      secondary: null,
      confidence: 0,
      tone: 'unknown',
      signals: [],
      inferredPainPoints: [],
      elapsedMs: Date.now() - started,
      costCents: 0,
      error: 'parse_error',
    };
  }

  const normalized = normalizeDISC(parsed);
  normalized.elapsedMs = Date.now() - started;
  normalized.costCents = estimateCostCents(userPrompt, raw.text);
  return normalized;
}

function buildUserPrompt(input, signals) {
  const summary = [];
  if (input.role) summary.push(`Rôle cible : ${input.role}`);
  if (input.linkedin && input.linkedin.currentCompany) {
    summary.push(`Entreprise actuelle : ${input.linkedin.currentCompany}`);
  }
  const signalsBlock = signals
    .map((s) => `- [${s.type}] ${s.text}`)
    .join('\n');
  return `${summary.length ? summary.join('\n') + '\n\n' : ''}SIGNAUX COLLECTÉS :
${signalsBlock}

Classe le décideur en JSON strict.`;
}

function normalizeDISC(parsed) {
  const primary = VALID_PRIMARY.has(parsed && parsed.primary) ? parsed.primary : 'unknown';
  const secondary =
    parsed && VALID_SECONDARY.has(parsed.secondary) ? parsed.secondary : null;

  let confidence = 0;
  if (typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }
  // Règle de cohérence : primary unknown → confidence forcée à 0
  if (primary === 'unknown') confidence = 0;

  const tone = VALID_TONE.has(parsed && parsed.tone) ? parsed.tone : 'unknown';

  const signals = Array.isArray(parsed.signals)
    ? parsed.signals
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim())
        .slice(0, 8)
    : [];

  const inferredPainPoints = Array.isArray(parsed.inferredPainPoints)
    ? parsed.inferredPainPoints
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim())
        .slice(0, 3)
    : [];

  return { primary, secondary, confidence, tone, signals, inferredPainPoints };
}

function estimateCostCents(userPrompt, outputText) {
  // Haiku 4.5 pricing estimatif (0.08€/1M input, 0.4€/1M output).
  // 4 chars ≈ 1 token. Arrondi à l'unité en centièmes d'euros.
  const inputTokens = Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4);
  const outputTokens = Math.ceil((outputText || '').length / 4);
  return Math.round((inputTokens * 0.08 + outputTokens * 0.4) / 1000);
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let handle;
  const timer = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`DISC inference timed out after ${ms}ms`);
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
  inferDISC,
  _normalizeDISC: normalizeDISC,
  _buildUserPrompt: buildUserPrompt,
  SYSTEM_PROMPT,
};
