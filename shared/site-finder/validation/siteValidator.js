'use strict';

/**
 * Validation d'un candidat URL pour un SIREN cible donné.
 *
 * Logique :
 *   1. Fetch home + pages mentions/légales/CGV (via pageFetcher).
 *   2. Concatène le texte de toutes les pages, applique extractSirens.
 *   3. Si SIREN cible trouvé → confidence 0.99, proofType 'siren_match'.
 *   4. Si UN AUTRE SIREN trouvé (≠ cible) → confidence 0.0, proofType
 *      'siren_mismatch'. Rejet ferme : un site qui revendique un autre SIREN
 *      n'est pas le bon, point.
 *   5. Si aucun SIREN trouvé → cumul de signaux faibles.
 *      - Cas général (Option C) : max 0.80, jamais au-dessus du seuil 0.85.
 *      - Bonus combinatoire name_city : si domain_resembles_name + ville_in_text
 *        (ou domain_resembles_name + company_name_in_title), confidence = 0.87.
 *        Décision Paul : nom de société dans le domaine + localité confirmée =
 *        preuve suffisante pour alimenter Dropcontact. Faux positif → email
 *        non délivré, pas de dommage prospect.
 */

const { containsTargetSiren, extractSirens } = require('./sirenExtractor');
const { fetchPagesForValidation } = require('../utils/pageFetcher');

const BASE_WEAK_CONFIDENCE = 0.40;
const MAX_WEAK_CONFIDENCE = 0.80;
// Confidence accordée quand domain_resembles_name + ville_in_text (ou name_in_title).
// Au-dessus du seuil par défaut (0.85) → validé sans SIREN (Option C).
const NAME_CITY_MATCH_CONFIDENCE = 0.87;
const SIGNAL_WEIGHT_NAME_IN_TITLE = 0.15;
const SIGNAL_WEIGHT_VILLE = 0.10;
const SIGNAL_WEIGHT_CODE_POSTAL = 0.05;
const SIGNAL_WEIGHT_DOMAIN_LIKE_NAME = 0.10;

const SIREN_MATCH_CONFIDENCE = 0.99;
const SIREN_MISMATCH_CONFIDENCE = 0.0;

/**
 * Valide un candidat URL.
 *
 * @param {Object} input
 * @param {string} input.url                URL à valider (canonique)
 * @param {string} input.targetSiren         9 chiffres, obligatoire
 * @param {string} [input.companyName]
 * @param {string} [input.ville]
 * @param {string} [input.codePostal]
 * @param {Object} [opts]
 * @param {Function} [opts.fetcherImpl]     Override de fetchPagesForValidation
 * @param {number}   [opts.timeoutMs]       Total budget pour fetcher
 * @returns {Promise<{
 *   confidence: number,
 *   proofType: 'siren_match' | 'siren_mismatch' | 'weak_signals' | 'unverified' | null,
 *   proofDetails: { matchedSirenOn?: string, weakSignals?: string[], rejectedReason?: string },
 *   signals: string[],
 *   pagesFetched: Array<{ url: string, status: number }>
 * }>}
 */
async function validateCandidate(input = {}, opts = {}) {
  const url = input.url;
  const targetSiren = String(input.targetSiren || '');
  if (!url || !/^\d{9}$/.test(targetSiren)) {
    return {
      confidence: 0,
      proofType: null,
      proofDetails: { rejectedReason: 'invalid_input' },
      signals: ['invalid_input'],
      pagesFetched: [],
    };
  }

  const fetcher = opts.fetcherImpl || fetchPagesForValidation;
  const pages = await fetcher(url, {
    totalTimeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

  // Toutes les pages 0/4xx/5xx → site injoignable
  const reachable = pages.filter((p) => p && p.status >= 200 && p.status < 400 && p.text);
  if (reachable.length === 0) {
    const allTimedOut = pages.length > 0 && pages.every((p) => p.error === 'fetch_timeout');
    return {
      confidence: 0,
      proofType: null,
      proofDetails: {
        rejectedReason: allTimedOut ? 'fetch_timeout' : 'site_unreachable',
      },
      signals: [allTimedOut ? 'fetch_timeout' : 'site_unreachable'],
      pagesFetched: pages.map((p) => ({ url: p.url, status: p.status })),
    };
  }

  // Concat tout le texte pour la recherche SIREN
  const concatenated = reachable.map((p) => p.text).join('\n\n');
  const targetCheck = containsTargetSiren(concatenated, targetSiren);

  if (targetCheck.found) {
    // Localisation : on retrouve la page d'origine pour le proof
    const matchedOn = locateSirenOnPage(reachable, targetSiren);
    return {
      confidence: SIREN_MATCH_CONFIDENCE,
      proofType: 'siren_match',
      proofDetails: {
        matchedSirenOn: matchedOn || url,
      },
      signals: ['siren_match', `siren_source_${targetCheck.source || 'unknown'}`],
      pagesFetched: reachable.map((p) => ({ url: p.url, status: p.status })),
    };
  }

  // Cherche d'autres SIREN — si on en trouve, rejet ferme
  const otherSirens = extractSirens(concatenated).filter((s) => s.siren !== targetSiren);
  if (otherSirens.length > 0) {
    return {
      confidence: SIREN_MISMATCH_CONFIDENCE,
      proofType: 'siren_mismatch',
      proofDetails: {
        rejectedReason: 'siren_mismatch',
        weakSignals: [`mismatched_siren=${otherSirens[0].siren}`],
      },
      signals: ['siren_mismatch', `mismatched_siren_count_${otherSirens.length}`],
      pagesFetched: reachable.map((p) => ({ url: p.url, status: p.status })),
    };
  }

  // Pas de SIREN du tout → cumul de signaux faibles
  const weak = computeWeakSignals({
    concatenated,
    homePage: reachable[0],
    companyName: input.companyName,
    ville: input.ville,
    codePostal: input.codePostal,
    siteUrl: url,
  });

  return {
    confidence: weak.confidence,
    proofType: weak.nameCityMatch ? 'name_city_match' : 'weak_signals',
    proofDetails: { weakSignals: weak.signals },
    signals: ['no_siren_found', ...weak.signals],
    pagesFetched: reachable.map((p) => ({ url: p.url, status: p.status })),
  };
}

// ─── Helpers privés ────────────────────────────────────────────────────────

function locateSirenOnPage(pages, targetSiren) {
  for (const p of pages) {
    if (!p.text) continue;
    if (containsTargetSiren(p.text, targetSiren).found) {
      return p.url;
    }
  }
  return null;
}

function computeWeakSignals({ concatenated, homePage, companyName, ville, codePostal, siteUrl }) {
  let confidence = BASE_WEAK_CONFIDENCE;
  const signals = [];

  const nameInTitle = companyName && homePage && homePage.text
    && companyNameInTitleOrH1(homePage.text, companyName);
  if (nameInTitle) {
    confidence += SIGNAL_WEIGHT_NAME_IN_TITLE;
    signals.push('company_name_in_title');
  }

  const villeInText = ville && concatenated && textContainsTokenLoose(concatenated, ville);
  if (villeInText) {
    confidence += SIGNAL_WEIGHT_VILLE;
    signals.push('ville_in_text');
  }

  if (codePostal && concatenated) {
    if (concatenated.includes(String(codePostal))) {
      confidence += SIGNAL_WEIGHT_CODE_POSTAL;
      signals.push('code_postal_in_text');
    }
  }

  const domainMatches = companyName && siteUrl && domainResemblesName(siteUrl, companyName);
  if (domainMatches) {
    confidence += SIGNAL_WEIGHT_DOMAIN_LIKE_NAME;
    signals.push('domain_resembles_name');
  }

  // Bonus combinatoire Option C : domaine ressemble au nom + ancrage géo ou
  // nom dans le titre → preuve suffisante sans SIREN pour alimenter Dropcontact.
  const nameCityMatch = domainMatches && (villeInText || nameInTitle);
  if (nameCityMatch) {
    signals.push('name_city_match_bonus');
    return {
      confidence: NAME_CITY_MATCH_CONFIDENCE,
      signals,
      nameCityMatch: true,
    };
  }

  return {
    confidence: Math.min(confidence, MAX_WEAK_CONFIDENCE),
    signals,
    nameCityMatch: false,
  };
}

function companyNameInTitleOrH1(html, companyName) {
  const normalized = normalizeForCompare(companyName);
  if (!normalized) return false;
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  if (titleMatch && normalizeForCompare(titleMatch[1]).includes(normalized)) return true;
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1Match && normalizeForCompare(stripTags(h1Match[1])).includes(normalized)) return true;
  return false;
}

function textContainsTokenLoose(text, token) {
  const normalizedText = normalizeForCompare(text);
  const normalizedToken = normalizeForCompare(token);
  if (!normalizedToken) return false;
  return normalizedText.includes(normalizedToken);
}

function domainResemblesName(siteUrl, companyName) {
  let host;
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    return false;
  }
  const labelChunks = host.split('.');
  if (labelChunks.length < 2) return false;
  const domainLabel = labelChunks[0]; // SLD
  const normalizedLabel = normalizeForCompare(domainLabel);
  const normalizedName = normalizeForCompare(companyName).replace(/\s+/g, '');
  if (!normalizedLabel || !normalizedName) return false;
  // Inclusion mutuelle = ressemblance forte
  if (normalizedLabel.includes(normalizedName) || normalizedName.includes(normalizedLabel)) {
    return true;
  }
  // Levenshtein normalisée
  const dist = levenshtein(normalizedLabel, normalizedName);
  const maxLen = Math.max(normalizedLabel.length, normalizedName.length);
  if (maxLen === 0) return false;
  const ratio = 1 - dist / maxLen;
  return ratio >= 0.7;
}

function normalizeForCompare(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

module.exports = {
  validateCandidate,
  // Exposés pour tests :
  _internals: {
    computeWeakSignals,
    companyNameInTitleOrH1,
    domainResemblesName,
    normalizeForCompare,
    levenshtein,
    BASE_WEAK_CONFIDENCE,
    MAX_WEAK_CONFIDENCE,
    NAME_CITY_MATCH_CONFIDENCE,
    SIREN_MATCH_CONFIDENCE,
    SIREN_MISMATCH_CONFIDENCE,
  },
};
