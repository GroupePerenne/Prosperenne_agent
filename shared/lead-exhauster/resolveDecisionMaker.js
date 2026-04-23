'use strict';

/**
 * Résolution et rescore du décideur commercial.
 *
 * Contexte produit : les `dirigeantsInsee` de LeadBase donnent le dirigeant
 * **statutaire** (président, gérant). Pour les PME 20-49 salariés et plus,
 * ce n'est souvent pas le bon interlocuteur commercial — c'est le DG
 * opérationnel, le directeur commercial, ou parfois le DAF selon la
 * typologie de vente.
 *
 * Règle V1 (SPEC §3.5) :
 *   - Tranche INSEE < 21 (= <20 salariés) → on garde INSEE, pas de rescore
 *     nécessaire : le dirigeant statutaire est souvent le bon contact
 *   - Tranche INSEE ≥ 21 (≥20 salariés) → rescore systématique. Si un
 *     profil scrapé a un score de pertinence commerciale > score INSEE +
 *     0.2, on bascule sur le profil scrapé. Sinon on garde INSEE.
 *
 * Le scoring des profils scrapés est fait en amont par `scraping.js`
 * (`extractTeamProfiles` + `findRoleInSnippet`). Ce module se contente de :
 *   - normaliser les inputs
 *   - scorer le dirigeant INSEE avec une baseline (prior PME)
 *   - comparer et choisir le meilleur candidat
 *
 * L'output est consommé par `resolveEmail` comme cible pour l'application
 * des patterns.
 *
 * SPEC : SPEC_LEAD_EXHAUSTER §3.5 + ARCHITECTURE §7.13.
 */

const { normalizeNamePart } = require('./patterns');

/**
 * Tranches INSEE à partir desquelles on déclenche le rescore.
 *   '21' = 20-49 salariés
 *   '22' = 50-99
 *   '31' = 100-199
 *   '32' = 200-249
 *   '41' = 250-499
 *   ...
 * Tranches < 21 → on garde INSEE sans scraping.
 */
const RESCORE_TRANCHE_THRESHOLD = '21';

/**
 * Prior INSEE : un dirigeant statutaire a une valeur de pertinence
 * commerciale par défaut qui varie selon la tranche effectif :
 *   - TPE (<20) → 0.80 (c'est souvent LE bon contact)
 *   - PME (20-49) → 0.55 (probablement pas opérationnel seul)
 *   - PME (50+)   → 0.40 (typiquement pas le bon contact direct)
 */
function inseePriorScore(trancheEffectif) {
  const t = String(trancheEffectif || '').trim();
  if (!t) return 0.70;
  // TPE / micro
  if (t < '11' || t === '01' || t === '02' || t === '03') return 0.85;
  // petite équipe
  if (t === '11' || t === '12') return 0.80;
  // PME 20-49
  if (t === '21') return 0.55;
  // PME 50+
  return 0.40;
}

/**
 * Retourne true si la tranche déclenche un rescore systématique
 * (seuil par défaut SPEC §3.5 : tranche ≥ 21, soit ≥20 salariés).
 */
function shouldRescore(trancheEffectif) {
  const t = String(trancheEffectif || '').trim();
  if (!t) return false;
  return t >= RESCORE_TRANCHE_THRESHOLD;
}

/**
 * Score un profil scrapé. Combine :
 *   - roleScore venant de `scraping.findRoleInSnippet` (0.3 / 0.6 / 0.9)
 *   - bonus +0.05 si le rôle matche exactement un titre de direction attendu
 *   - léger malus si le firstName n'est pas parseable
 *
 * Retourne un score 0-1.
 */
function scoreTeamProfile(profile) {
  if (!profile || !profile.firstName || !profile.lastName) return 0;
  let score = Number(profile.roleScore) || 0;
  // bonus si le rôle inclut explicitement une mention de direction forte
  const role = String(profile.role || '').toLowerCase();
  if (/directeur général|directrice générale|pdg|p\.d\.g|ceo|fondateur|président/.test(role)) {
    score = Math.max(score, 0.9);
  }
  // clamp
  if (score > 1) score = 1;
  if (score < 0) score = 0;
  return score;
}

/**
 * Résout le décideur final à utiliser comme cible d'envoi mail.
 *
 * @param {Object} input
 * @param {string} [input.firstName]          Depuis INSEE / LeadBase
 * @param {string} [input.lastName]
 * @param {string} [input.inseeRole]          Ex. "Président", "Gérant" (optionnel)
 * @param {string} [input.trancheEffectif]    Code INSEE (ex. "11", "21")
 * @param {Array}  [input.teamProfiles]       Issu de scraping.extractTeamProfiles
 * @returns {{
 *   firstName:string,
 *   lastName:string,
 *   role:string,
 *   source:'insee'|'website'|'linkedin_entreprise'|'google',
 *   confidence:number,
 *   rescored:boolean,
 *   signals:string[]
 * }|null}
 */
function resolveDecisionMaker(input = {}) {
  const signals = [];
  const hasInsee = Boolean(input.firstName || input.lastName);
  const teamProfiles = Array.isArray(input.teamProfiles) ? input.teamProfiles : [];

  // Candidat INSEE
  const inseeCandidate = hasInsee
    ? {
        firstName: String(input.firstName || '').trim(),
        lastName: String(input.lastName || '').trim(),
        role: String(input.inseeRole || 'Dirigeant statutaire'),
        source: 'insee',
        confidence: inseePriorScore(input.trancheEffectif),
      }
    : null;

  // Cas 1 : pas INSEE et pas de profils scrapés → null
  if (!inseeCandidate && teamProfiles.length === 0) {
    signals.push('no_input_no_scrape');
    return null;
  }

  // Cas 2 : pas INSEE, profils scrapés → prend le meilleur scrapé
  if (!inseeCandidate && teamProfiles.length > 0) {
    const best = pickBestProfile(teamProfiles);
    if (!best || !best.profile) {
      signals.push('scraped_no_valid_profile');
      return null;
    }
    signals.push('used_scraped_no_insee');
    return {
      firstName: best.profile.firstName,
      lastName: best.profile.lastName,
      role: best.profile.role || (best.profile.roleKeyword || '').trim(),
      source: 'website',
      confidence: best.score,
      rescored: false,
      signals,
    };
  }

  // Cas 3 : INSEE + pas de profils scrapés → INSEE direct
  if (inseeCandidate && teamProfiles.length === 0) {
    signals.push('insee_only_no_team_profiles');
    return { ...inseeCandidate, rescored: false, signals };
  }

  // Cas 4 : INSEE + profils scrapés
  //   4a : tranche < seuil → garder INSEE sans rescore systématique
  //   4b : tranche ≥ seuil → rescore systématique, comparer INSEE vs meilleur scrapé
  const mustRescore = shouldRescore(input.trancheEffectif);
  signals.push(mustRescore ? 'rescore_triggered' : 'rescore_skipped_small_tranche');

  // Si un profil scrapé matche exactement l'INSEE par nom, on boost la
  // confidence INSEE (double source) et on garde INSEE même pour PME+.
  const inseeMatch = findInseeMatchInProfiles(inseeCandidate, teamProfiles);
  if (inseeMatch) {
    signals.push('insee_name_confirmed_on_website');
    const boostedConfidence = Math.min(
      0.95,
      Math.max(inseeCandidate.confidence, 0.75) + 0.10,
    );
    return {
      firstName: inseeCandidate.firstName,
      lastName: inseeCandidate.lastName,
      role: inseeMatch.role || inseeCandidate.role,
      source: 'insee',
      confidence: boostedConfidence,
      rescored: false,
      signals,
    };
  }

  if (!mustRescore) {
    return { ...inseeCandidate, rescored: false, signals };
  }

  const best = pickBestProfile(teamProfiles);
  if (!best || !best.profile) {
    signals.push('rescore_no_valid_candidate');
    return { ...inseeCandidate, rescored: false, signals };
  }

  const gap = best.score - inseeCandidate.confidence;
  if (gap > 0.2) {
    signals.push(`rescore_switched_gap_${gap.toFixed(2)}`);
    return {
      firstName: best.profile.firstName,
      lastName: best.profile.lastName,
      role: best.profile.role || (best.profile.roleKeyword || '').trim(),
      source: 'website',
      confidence: best.score,
      rescored: true,
      signals,
    };
  }

  signals.push(`rescore_kept_insee_gap_${gap.toFixed(2)}`);
  return { ...inseeCandidate, rescored: false, signals };
}

/**
 * Trouve le meilleur profil de l'équipe selon le score composite.
 * Retourne { profile, score } ou null.
 */
function pickBestProfile(teamProfiles) {
  let best = null;
  for (const p of teamProfiles) {
    const score = scoreTeamProfile(p);
    if (score === 0) continue;
    if (!best || score > best.score) best = { profile: p, score };
  }
  return best;
}

/**
 * Cherche dans les profils scrapés un match par nom avec l'INSEE. Un match
 * confirme que le dirigeant INSEE est bien présent sur le site, et permet
 * (a) de booster la confidence, (b) de récupérer son rôle opérationnel
 * s'il est renseigné à côté de son nom.
 */
function findInseeMatchInProfiles(inseeCandidate, teamProfiles) {
  if (!inseeCandidate) return null;
  const inseeFirst = normalizeNamePart(inseeCandidate.firstName);
  const inseeLast = normalizeNamePart(inseeCandidate.lastName);
  if (!inseeLast) return null;
  for (const p of teamProfiles) {
    const pFirst = normalizeNamePart(p.firstName);
    const pLast = normalizeNamePart(p.lastName);
    // match strict sur lastName, match tolérant sur firstName (prénoms
    // composés, initiales)
    if (pLast === inseeLast) {
      if (!inseeFirst || !pFirst) return p;
      if (pFirst === inseeFirst) return p;
      // tolère matching partiel (premier prénom de l'INSEE vs premier
      // prénom du profil scrapé)
      const inseeHead = inseeFirst.split('-')[0];
      const pHead = pFirst.split('-')[0];
      if (inseeHead === pHead) return p;
    }
  }
  return null;
}

module.exports = {
  resolveDecisionMaker,
  inseePriorScore,
  shouldRescore,
  scoreTeamProfile,
  pickBestProfile,
  findInseeMatchInProfiles,
  _constants: { RESCORE_TRANCHE_THRESHOLD },
};
