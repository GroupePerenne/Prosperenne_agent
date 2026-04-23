'use strict';

/**
 * Couche B — fiche décideur.
 *
 * Orchestration :
 *   1. LinkedIn profil public (stub V0 → null, provider V1 à venir)
 *   2. Mentions presse via Google Search (stub V0 aussi)
 *   3. Signal de ton du site entreprise (passé en input depuis companyProfile)
 *   4. Extraction/inférence DISC via shared/disc-profiler (Haiku 4.5)
 *
 * Output stable (aligné SPEC §3.2) :
 *   {
 *     contactId: string,
 *     career: { currentRole, tenure?, previousRoles[] },
 *     tone: 'corporate'|'startup'|'technique'|'commercial'|'unknown',
 *     publications: string[],
 *     discScore: { primary, secondary?, confidence, signals[] },
 *     inferredPainPoints: string[],
 *     confidence: number,
 *     elapsedMs: number,
 *     costCents: number,
 *     sources: { linkedin: boolean, press: boolean, companyTone: boolean }
 *   }
 *
 * Dégradation gracieuse :
 *   - LinkedIn stub → career depuis input.role, pas de publications
 *   - Pas de signaux exploitables → discScore = { primary: 'unknown', confidence: 0 }
 *   - Pitch downstream lira discScore.confidence < 0.4 et basculera en ton neutre
 *
 * Tests : mocks LLM via opts.llmImpl injectable. Aucun appel Anthropic.
 */

const { fetchLinkedInProfile } = require('./sources/linkedinProfile');
const { searchRecentSignals } = require('./sources/googleSearch');
const { inferDISC } = require('../disc-profiler');

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * @param {object} input
 * @param {string} input.firstName
 * @param {string} input.lastName
 * @param {string} [input.role]
 * @param {string} [input.companyName]
 * @param {string} [input.decisionMakerLinkedInUrl]
 * @param {string} [input.contactId]                  défaut dérivé nom
 * @param {object} [input.companyTone]                { excerpt? } depuis companyProfile
 * @param {object} [opts]
 * @param {object}   [opts.context]
 * @param {Function} [opts.linkedinImpl]              (url) => fetchLinkedInProfile output
 * @param {Function} [opts.searchImpl]                (name) => searchRecentSignals output
 * @param {Function} [opts.discImpl]                  (input) => inferDISC output
 * @param {Function} [opts.llmImpl]                   passé à inferDISC si discImpl non fourni
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<object|null>}
 */
async function buildDecisionMakerProfile(input = {}, opts = {}) {
  const started = Date.now();
  const logger = makeLogger(opts.context);

  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

  if (!fullName) {
    logger.warn('profiler.decisionMaker.no_name');
    return null;
  }

  const contactId = input.contactId || deriveContactId({ firstName, lastName });
  const linkedinImpl = opts.linkedinImpl || fetchLinkedInProfile;
  const searchImpl = opts.searchImpl || searchRecentSignals;

  // 1. LinkedIn profil (stub V0)
  const linkedinRes = input.decisionMakerLinkedInUrl
    ? await withTimeout(
        linkedinImpl(input.decisionMakerLinkedInUrl),
        opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      ).catch(() => null)
    : null;

  // 2. Mentions presse ciblées (stub V0)
  const pressQuery = `"${fullName}"${input.companyName ? ` "${input.companyName}"` : ''}`;
  const pressRes = await withTimeout(
    searchImpl(pressQuery, { queryHints: ['interview', 'citation', 'témoignage'] }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  ).catch(() => null);

  const pressMentions = Array.isArray(pressRes && pressRes.results)
    ? pressRes.results.map((r) => r && r.snippet).filter(Boolean)
    : [];

  // 3. Inférence DISC
  const linkedinProfile = linkedinRes && linkedinRes.profile ? linkedinRes.profile : null;
  const discImpl = opts.discImpl || inferDISC;
  const discInput = {
    role: input.role || (linkedinProfile && linkedinProfile.currentRole),
    linkedin: linkedinProfile,
    companyTone: input.companyTone || null,
    pressMentions,
  };

  const discScore = await withTimeout(
    discImpl(discInput, {
      llmImpl: opts.llmImpl,
      context: opts.context,
    }),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS,
  ).catch((err) => {
    logger.warn('profiler.decisionMaker.disc_failed', { err: err && err.message });
    return {
      primary: 'unknown',
      secondary: null,
      confidence: 0,
      tone: 'unknown',
      signals: [],
      inferredPainPoints: [],
      costCents: 0,
    };
  });

  // 4. Construction payload final
  const payload = buildPayload({
    contactId,
    fullName,
    firstName,
    lastName,
    role: input.role,
    linkedinProfile,
    pressMentions,
    discScore,
  });

  payload.elapsedMs = Date.now() - started;
  payload.costCents = discScore.costCents || 0;
  payload.sources = {
    linkedin: !!(linkedinProfile),
    press: pressMentions.length > 0,
    companyTone: !!(input.companyTone && input.companyTone.excerpt),
  };

  // Si on n'a ni LinkedIn ni signaux DISC → on renvoie quand même (carrière
  // minimale déductible du rôle), mais confidence globale basse
  payload.confidence = computeOverallConfidence(payload);

  logger.info('profiler.decisionMaker.done', {
    contactId,
    disc: payload.discScore.primary,
    confidence: payload.confidence,
    ms: payload.elapsedMs,
  });

  return payload;
}

function buildPayload({
  contactId,
  fullName,
  firstName,
  lastName,
  role,
  linkedinProfile,
  pressMentions,
  discScore,
}) {
  const currentRole =
    (linkedinProfile && linkedinProfile.currentRole) ||
    role ||
    null;
  const tenure = linkedinProfile && linkedinProfile.tenure ? linkedinProfile.tenure : null;
  const previousRoles =
    linkedinProfile && Array.isArray(linkedinProfile.experiences)
      ? linkedinProfile.experiences
          .filter((x) => x && x.role)
          .map((x) => (x.company ? `${x.role} — ${x.company}` : x.role))
          .slice(0, 4)
      : [];

  const publications =
    linkedinProfile && Array.isArray(linkedinProfile.recentPosts)
      ? linkedinProfile.recentPosts
          .filter((p) => p && p.text)
          .map((p) => p.text)
          .slice(0, 5)
      : [];

  return {
    contactId,
    fullName,
    firstName: firstName || null,
    lastName: lastName || null,
    career: { currentRole, tenure, previousRoles },
    tone: discScore.tone || 'unknown',
    publications,
    pressMentions,
    discScore: {
      primary: discScore.primary,
      secondary: discScore.secondary,
      confidence: discScore.confidence,
      signals: discScore.signals || [],
    },
    inferredPainPoints: discScore.inferredPainPoints || [],
    version: 'v0',
  };
}

function computeOverallConfidence(profile) {
  let score = 0;
  if (profile.career && profile.career.currentRole) score += 0.25;
  if (profile.sources.linkedin) score += 0.35;
  if (profile.publications.length > 0) score += 0.1;
  if (profile.pressMentions.length > 0) score += 0.1;
  if (profile.discScore && profile.discScore.primary !== 'unknown') {
    score += 0.2 * (profile.discScore.confidence || 0);
  }
  return Math.min(1, Number(score.toFixed(2)));
}

function deriveContactId({ firstName, lastName }) {
  const slug = `${firstName}-${lastName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown-contact';
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let handle;
  const timer = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`decisionMakerProfile budget exceeded after ${ms}ms`);
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
  buildDecisionMakerProfile,
  _buildPayload: buildPayload,
  _computeOverallConfidence: computeOverallConfidence,
  _deriveContactId: deriveContactId,
};
