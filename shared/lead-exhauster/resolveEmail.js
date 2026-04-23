'use strict';

/**
 * Résolution d'email interne (étapes 3a-d du pipeline SPEC §3.3).
 *
 * Ce module orchestre les signaux internes gratuits : patterns maison,
 * scraping ciblé du site, signal LinkedIn. Il NE fait PAS appel à
 * Dropcontact (étape 4 du pipeline, géré par l'orchestrateur index.js).
 *
 * Philosophie "pas d'invention" :
 *   - Un pattern seul, sans aucune vérification (pas d'email scrapé, pas
 *     de signal LinkedIn, pas de match nom dans site), **ne peut pas**
 *     atteindre le seuil de confidence par défaut (0.80). Il sera donc
 *     classé unresolvable et relayé à la cascade Dropcontact.
 *   - Un email scrapé avec nom qui matche (local-part ou contexte proche)
 *     peut passer le seuil à lui seul (scoreEmailAgainstName jusqu'à 0.90).
 *   - Un pattern cross-checké par scraping (email pattern-généré présent
 *     dans le HTML) atteint la confidence bootstrap du pattern (0.88 pour
 *     first.last), ce qui passe largement le seuil.
 *
 * La cascade externe (Dropcontact) vient en étape 4 côté orchestrateur
 * pour les cas où ce module retourne unresolvable avec un candidat hint
 * que Dropcontact pourra vérifier.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §3.3 + §3.4 "on n'invente jamais".
 */

const {
  applyPattern,
  rankPatternsForContext,
  confidenceForPattern,
  normalizeNamePart,
} = require('./patterns');
const { scrapeDomain, isJunkEmail } = require('./scraping');
const { probeLinkedIn } = require('./linkedin');
const { DEFAULT_CONFIDENCE_THRESHOLD, SOURCES } = require('./schemas');

/**
 * @typedef {Object} ResolveEmailInput
 * @property {string} domain                  Domaine normalisé (obligatoire)
 * @property {string} [firstName]
 * @property {string} [lastName]
 * @property {string} [companyName]
 * @property {string} [siren]
 * @property {string} [companyLinkedInUrl]
 * @property {string} [profileLinkedInUrl]
 * @property {string} [naf]                    Pour rankPatternsForContext
 * @property {string} [trancheEffectif]
 * @property {number} [confidenceThreshold]    Défaut SPEC §1 = 0.80
 */

/**
 * @typedef {Object} ResolveEmailOutput
 * @property {'ok'|'unresolvable'} status
 * @property {string|null} email
 * @property {number}      confidence
 * @property {'internal_patterns'|'internal_scraping'|'linkedin_signal'|'none'} source
 * @property {string[]}    signals
 * @property {string|null} [candidateHint]     Pattern suggéré pour cascade Dropcontact
 * @property {Array}       [scrapedEmailsSeen] Observés pour trace (debug)
 * @property {Array}       [teamProfilesSeen]  Observés pour resolveDecisionMaker
 * @property {number}      elapsedMs
 */

/**
 * Résout l'email d'un décideur via les canaux internes.
 *
 * @param {ResolveEmailInput} input
 * @param {Object} [opts]
 * @param {Function} [opts.scraper]          scrapeDomain injectable (tests)
 * @param {Function} [opts.linkedinProber]   probeLinkedIn injectable (tests)
 * @param {Function} [opts.fetchImpl]        Propagé au scraper si pas injecté
 * @param {Function|Object} [opts.logger]
 * @returns {Promise<ResolveEmailOutput>}
 */
async function resolveEmail(input = {}, opts = {}) {
  const started = Date.now();
  const signals = [];
  const threshold = Number.isFinite(input.confidenceThreshold)
    ? input.confidenceThreshold
    : DEFAULT_CONFIDENCE_THRESHOLD;

  // Pas de domaine → on ne peut rien faire côté interne.
  if (!input.domain) {
    return buildResult({
      status: 'unresolvable',
      signals: ['no_domain'],
      elapsedMs: Date.now() - started,
    });
  }

  const firstName = String(input.firstName || '').trim();
  const lastName = String(input.lastName || '').trim();
  const firstNorm = normalizeNamePart(firstName);
  const lastNorm = normalizeNamePart(lastName);

  // ─── Étape 3b : scraping ciblé site entreprise ──────────────────────────
  const scraper = opts.scraper || scrapeDomain;
  const scrape = await scraper(
    { domain: input.domain, firstName, lastName },
    { fetchImpl: opts.fetchImpl, logger: opts.logger },
  ).catch((err) => {
    signals.push('scraping_error');
    return { emails: [], teamProfiles: [], pagesVisited: [], pagesFailed: [], signals: [`err:${err && err.message}`] };
  });
  signals.push(`scraped_${scrape.pagesVisited.length}_pages`);
  if (scrape.pagesFailed && scrape.pagesFailed.length > 0) {
    signals.push(`scraped_${scrape.pagesFailed.length}_pages_failed`);
  }

  const scrapedEmails = Array.isArray(scrape.emails) ? scrape.emails : [];
  const scrapedSet = new Map(scrapedEmails.map((e) => [e.email, e]));

  // ─── Étape 3a : patterns maison + cross-check scraping (priorité) ───────
  // Un pattern qui matche un email scrapé est le signal le plus fort du
  // pipeline interne : deux sources indépendantes convergent. On évalue
  // donc les patterns AVANT la recherche de match brut — si le résultat
  // scrapé coïncide avec un pattern connu, on préfère l'annoter
  // `internal_patterns` (plus stable analytiquement pour patterns-learner).
  const rankedPatterns = rankPatternsForContext({
    naf: input.naf,
    tranche: input.trancheEffectif,
  });

  let bestPatternHit = null;
  let patternHint = null;

  for (const p of rankedPatterns) {
    const candidate = applyPattern(p.template, {
      firstName,
      lastName,
      domain: input.domain,
    });
    if (!candidate) continue;
    if (!patternHint && p.id !== 'contact') patternHint = candidate;

    const scraped = scrapedSet.get(candidate);
    if (scraped) {
      const combined = Math.max(p.confidence, scraped.confidence);
      if (!bestPatternHit || combined > bestPatternHit.confidence) {
        bestPatternHit = {
          email: candidate,
          confidence: combined,
          patternId: p.id,
          scrapedConfidence: scraped.confidence,
        };
      }
    }
  }

  if (bestPatternHit && bestPatternHit.confidence >= threshold) {
    signals.push(`pattern_${bestPatternHit.patternId}_cross_checked_scraping`);
    return buildResult({
      status: 'ok',
      email: bestPatternHit.email,
      confidence: bestPatternHit.confidence,
      source: SOURCES.INTERNAL_PATTERNS,
      signals,
      scrapedEmailsSeen: scrapedEmails,
      teamProfilesSeen: scrape.teamProfiles,
      elapsedMs: Date.now() - started,
    });
  }
  if (bestPatternHit) {
    // pattern matched scraping mais confidence < seuil (catch-all 0.40
    // typiquement). On ne retourne PAS ok et on N'ÉCRASE PAS patternHint
    // existant : on veut pousser en priorité un hint nominatif
    // (first.last) à Dropcontact, pas un catch-all qui ne vaut rien.
    signals.push(`pattern_${bestPatternHit.patternId}_under_threshold`);
    if (!patternHint) patternHint = bestPatternHit.email;
  }

  // ─── Étape 3b bis : scraped email name-matched (fallback sans pattern) ──
  // Si le scraping a trouvé un email dont le local-part matche le nom par
  // une forme qu'aucun bootstrap pattern ne couvre (ex. j-dupont), on
  // l'accepte si son score contextuel dépasse le seuil.
  if (firstNorm && lastNorm) {
    for (const e of scrapedEmails) {
      if (isJunkEmail(e.email)) continue;
      if (e.confidence >= threshold) {
        signals.push('scraping_name_matched_no_pattern');
        return buildResult({
          status: 'ok',
          email: e.email,
          confidence: e.confidence,
          source: SOURCES.INTERNAL_SCRAPING,
          signals,
          scrapedEmailsSeen: scrapedEmails,
          teamProfilesSeen: scrape.teamProfiles,
          elapsedMs: Date.now() - started,
        });
      }
    }
  }

  // ─── Étape 3d : signal LinkedIn (confirmation de nom, pas d'email) ──────
  // LinkedIn ne donne jamais l'email en V1 (ToS). Son signal confirme
  // que le décideur existe et ajoute éventuellement un prior à un pattern.
  let linkedinMatched = false;
  if (opts.linkedinProber || (input.profileLinkedInUrl || input.companyLinkedInUrl)) {
    const prober = opts.linkedinProber || probeLinkedIn;
    const probe = await prober(
      {
        profileLinkedInUrl: input.profileLinkedInUrl,
        companyLinkedInUrl: input.companyLinkedInUrl,
        firstName,
        lastName,
      },
      { fetchImpl: opts.fetchImpl },
    ).catch(() => ({ matched: false, signals: ['linkedin_error'] }));
    if (probe.matched) {
      linkedinMatched = true;
      signals.push('linkedin_name_confirmed');
    } else if (Array.isArray(probe.signals) && probe.signals.length > 0) {
      signals.push(`linkedin_${probe.signals[0]}`);
    }
  }

  // ─── Pas assez de signaux — unresolvable ────────────────────────────────
  // Principe V1 "pas d'invention" : un pattern non vérifié (aucun match
  // scraping, aucun email trouvé sur le site) n'atteint pas le seuil 0.80.
  // L'orchestrateur tentera Dropcontact en étape 4 avec `candidateHint`
  // si les patterns maison ont produit un candidat plausible.
  //
  // Exception catch-all : contact@{domain} est systématiquement applicable
  // mais reste à confidence 0.40 → jamais accepté seul (seuil 0.80).
  const catchAll = applyPattern('contact@{domain}', { domain: input.domain });
  const hasCandidateHint = Boolean(patternHint);

  signals.push(hasCandidateHint ? 'pattern_hint_available' : 'no_pattern_hint');
  if (linkedinMatched && hasCandidateHint) {
    // Même avec LinkedIn confirmé, on ne passe pas seul : on a le nom mais
    // pas l'email. Le hint reste disponible pour Dropcontact. Signal
    // conservé pour qu'un tenant avec threshold plus bas puisse décider.
    signals.push('linkedin_confirms_name_but_email_not_verified');
  }

  return buildResult({
    status: 'unresolvable',
    signals,
    candidateHint: patternHint || catchAll || null,
    scrapedEmailsSeen: scrapedEmails,
    teamProfilesSeen: scrape.teamProfiles,
    elapsedMs: Date.now() - started,
  });
}

function buildResult(partial) {
  return {
    status: partial.status || 'unresolvable',
    email: partial.email || null,
    confidence: typeof partial.confidence === 'number' ? partial.confidence : 0,
    source: partial.source || SOURCES.NONE || 'none',
    signals: Array.isArray(partial.signals) ? partial.signals.slice() : [],
    candidateHint: partial.candidateHint || null,
    scrapedEmailsSeen: Array.isArray(partial.scrapedEmailsSeen) ? partial.scrapedEmailsSeen : [],
    teamProfilesSeen: Array.isArray(partial.teamProfilesSeen) ? partial.teamProfilesSeen : [],
    elapsedMs: Number.isFinite(partial.elapsedMs) ? partial.elapsedMs : 0,
  };
}

module.exports = {
  resolveEmail,
  // exposé pour tests :
  _internals: { buildResult },
};
