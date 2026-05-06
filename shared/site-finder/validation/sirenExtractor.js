'use strict';

/**
 * Extraction de SIREN depuis un texte arbitraire (HTML brut, mentions légales,
 * footer, page d'accueil…).
 *
 * Pierre angulaire de la validation site-finder. Les faux positifs sont une
 * catastrophe (un site validé à tort = un mail prospect envoyé à la mauvaise
 * adresse), donc on privilégie la précision sur le rappel : pas de SIREN
 * "isolé sans contexte" reconnu, sauf en début/fin de ligne avec espaces ou
 * ponctuation autour.
 *
 * Patterns reconnus :
 *   - Préfixe explicite (SIREN/SIRET/RCS/N° SIREN/N° d'identification…)
 *     suivi de 9 ou 14 chiffres, séparateurs souples.
 *   - Préfixe TVA intra FR (FR + 2 clé + 9 SIREN) → on extrait les 9 derniers.
 *   - SIREN sur ligne dédiée, isolé entre frontières non-numériques.
 *
 * Patterns rejetés (faux positifs interdits) :
 *   - 9 chiffres collés à d'autres chiffres (téléphone 0612345678, code postal
 *     suivi de numéro de rue, etc.)
 *   - 9 chiffres dans une URL ou un identifiant alphanumérique (slug, hash…)
 *
 * Validation supplémentaire : la clé de Luhn modifiée des SIREN n'est PAS
 * vérifiée en V1. Décision Paul : trop de SIREN historiques en France ne la
 * respectent plus (corrections INSEE). On compense par la double validation
 * croisée avec le SIREN cible attendu — la regex retourne tous les candidats,
 * c'est `siteValidator.js` qui décide par comparaison stricte.
 */

// Préfixes qui indiquent explicitement qu’un SIREN/SIRET suit. Ordre du plus
// long au plus court pour que l’alternance regex matche le plus spécifique.
// Liste fermée — pas d’extrapolation R-J6.
// Toutes les strings délimitées par guillemets doubles pour éviter toute
// confusion avec les apostrophes typographiques dans les patterns internes.
const SIREN_LABEL_PATTERNS = [
  // Formulations libres fréquentes sur les sites PME générés par CMS (Wix,
  // WordPress, OVHcloud site builder) qui n’utilisent pas les labels standard.
  "immatricul[eé]e?\\s+sous\\s+le\\s+num",
  "enregistr[eé]e?\\s+sous\\s+le\\s+num",
  "inscri[ts]e?\\s+au\\s+RCS",
  // Avec apostrophe : N° d’identification, n° d’identification (case-insensitive
  // dans la regex composée plus bas)
  "N°\\s*d[‘’]identification",
  "Numéro\\s*d[‘’]identification",
  // Avec espace dans "n° SIREN"
  "N°\\s*SIREN",
  "n°\\s*SIREN",
  "N°\\s*SIRET",
  "n°\\s*SIRET",
  // Préfixés "RCS Ville"
  "RCS(?:\\s+[A-ZÀ-Ÿa-zà-ÿ-]+)?",
  // Bruts
  "SIREN",
  "SIRET",
];

const LABEL_GROUP = SIREN_LABEL_PATTERNS.join('|');

// Séparateurs autorisés entre les chiffres : espace, point, tiret, espace
// insécable. Pas de virgule (jamais utilisé en pratique pour les SIREN).
const SEP = '[\\s.\\-\\u00A0]*';

// Pattern principal : un préfixe label, du whitespace/séparation, puis 9 ou 14
// chiffres avec séparateurs internes possibles.
const LABELED_SIREN_RE = new RegExp(
  `(?:${LABEL_GROUP})\\s*[:#]?\\s*((?:\\d${SEP}){8,13}\\d)`,
  'gi',
);

// TVA intracommunautaire FR : FR + 2 chiffres clé + 9 chiffres SIREN.
// Ex : FR82123456789, FR 82 123 456 789. La clé peut être [0-9A-Z]{2} pour les
// nouvelles entreprises (rare) — on prend permissif.
const TVA_FR_RE = /\bFR[\s.\- ]*[0-9A-Z][\s.\- ]*[0-9A-Z][\s.\- ]*((?:\d[\s.\- ]*){8,13}\d)\b/gi;

// SIREN "isolé" : 9 chiffres avec séparateurs souples, BORDÉS par des
// séparateurs non-numériques (début/fin de ligne, ponctuation, espace).
// Capture une chaîne qui, une fois nettoyée, fait exactement 9 chiffres.
// On exige des frontières strictes : (?<![\d\w]) avant et (?![\d\w]) après,
// sinon on confond avec téléphones, codes postaux+rue, etc.
const ISOLATED_SIREN_RE = /(?<![\w\d])((?:\d[\s.\- ]?){8}\d)(?![\w\d])/g;

// Contexte autour du match (caractères avant/après pour debug humain).
const CONTEXT_RADIUS = 30;

/**
 * Extrait tous les SIREN d'un texte. Retourne un tableau de candidats ordonné
 * par position dans le texte. Doublons (même SIREN à plusieurs endroits) sont
 * conservés — c'est utile pour signaler la fréquence.
 *
 * @param {string} text
 * @returns {Array<{ siren: string, context: string, source: string, position: number }>}
 *   - source: 'labeled' | 'tva_fr' | 'isolated'
 *   - position: index de début du match dans le texte (pour debug)
 */
function extractSirens(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const found = [];

  // Phase 1 : préfixes explicites (priorité haute)
  const labeledRanges = [];
  for (const m of text.matchAll(LABELED_SIREN_RE)) {
    const siren = takeNineDigits(m[1]);
    if (!siren) continue;
    found.push({
      siren,
      context: contextAround(text, m.index, m[0].length),
      source: 'labeled',
      position: m.index,
    });
    labeledRanges.push([m.index, m.index + m[0].length]);
  }

  // Phase 2 : TVA FR (priorité haute aussi, mais distinct pour le tagging)
  const tvaRanges = [];
  for (const m of text.matchAll(TVA_FR_RE)) {
    const siren = takeNineDigits(m[1]);
    if (!siren) continue;
    found.push({
      siren,
      context: contextAround(text, m.index, m[0].length),
      source: 'tva_fr',
      position: m.index,
    });
    tvaRanges.push([m.index, m.index + m[0].length]);
  }

  // Phase 3 : SIREN isolé. On exclut les zones déjà matchées par les phases 1
  // ou 2 pour ne pas re-capturer le même nombre.
  const occupied = labeledRanges.concat(tvaRanges);
  for (const m of text.matchAll(ISOLATED_SIREN_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (overlapsAny(start, end, occupied)) continue;
    const siren = takeNineDigits(m[1]);
    if (!siren) continue;
    found.push({
      siren,
      context: contextAround(text, start, m[0].length),
      source: 'isolated',
      position: start,
    });
  }

  found.sort((a, b) => a.position - b.position);
  return found;
}

/**
 * Vérifie si un texte contient au moins une occurrence d'un SIREN cible.
 * Plus précis que `extractSirens` quand on connaît déjà la valeur attendue.
 *
 * @param {string} text
 * @param {string} targetSiren — 9 chiffres
 * @returns {{ found: boolean, source?: string, context?: string }}
 */
function containsTargetSiren(text, targetSiren) {
  if (!/^\d{9}$/.test(String(targetSiren || ''))) {
    return { found: false };
  }
  const all = extractSirens(text);
  for (const c of all) {
    if (c.siren === targetSiren) {
      return { found: true, source: c.source, context: c.context };
    }
  }
  return { found: false };
}

// ─── Helpers privés ────────────────────────────────────────────────────────

function takeNineDigits(rawCapture) {
  if (!rawCapture) return null;
  const digits = String(rawCapture).replace(/[^\d]/g, '');
  if (digits.length !== 9 && digits.length !== 14) return null;
  // SIRET = SIREN (9) + NIC (5). On garde les 9 premiers.
  return digits.slice(0, 9);
}

function contextAround(text, start, length) {
  const from = Math.max(0, start - CONTEXT_RADIUS);
  const to = Math.min(text.length, start + length + CONTEXT_RADIUS);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

function overlapsAny(start, end, ranges) {
  for (const [rs, re] of ranges) {
    if (start < re && end > rs) return true;
  }
  return false;
}

module.exports = {
  extractSirens,
  containsTargetSiren,
  // Exposés pour tests :
  _internals: {
    LABELED_SIREN_RE,
    TVA_FR_RE,
    ISOLATED_SIREN_RE,
    takeNineDigits,
    CONTEXT_RADIUS,
  },
};
