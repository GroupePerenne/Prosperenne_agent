'use strict';

/**
 * Patterns email maison — bootstrap V1 + helpers d'application.
 *
 * Fournit :
 *   - normalizeNamePart(raw)     → token normalisé lowercase sans accent
 *   - normalizeDomain(raw)       → domaine lowercase sans http/www/slash
 *   - applyPattern(pattern, ctx) → adresse email ou null si invariants KO
 *   - getBootstrapPatterns()     → 8 patterns V1 SPEC §6 avec poids
 *   - rankPatternsForContext(ctx)→ tri patterns (V1 : retourne bootstrap)
 *   - confidenceForPattern(p)    → mapping poids → confidence score
 *
 * Le module est pur (aucun I/O). L'apprentissage dynamique (lecture
 * EmailPatterns, mise à jour par patterns-learner) est assuré par le
 * job batch hebdo Jalon 4, non par ce fichier.
 */

// ─── Normalisation ─────────────────────────────────────────────────────────

/**
 * Normalise un token nom/prénom pour injection dans un pattern email :
 *   - trim
 *   - lowercase
 *   - NFD + suppression des accents (é → e, ç → c)
 *   - suppression des espaces et apostrophes internes
 *   - conservation des lettres latines et tirets uniquement
 *
 * Les noms composés (ex. "de la Fontaine") sont compactés sans séparateur
 * (→ "delafontaine") ce qui correspond à l'usage observé en entreprise FR.
 * Les noms à particule (ex. "d'Alembert") suivent la même règle (→ "dalembert").
 *
 * Retourne chaîne vide si l'entrée est falsy ou ne contient aucune lettre.
 */
function normalizeNamePart(raw) {
  if (!raw) return '';
  const nfd = String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const clean = nfd.toLowerCase().replace(/[^a-z-]/g, '');
  return clean.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Extrait le PREMIER prénom d'un champ RNE `prenoms` qui contient tous les
 * prénoms séparés par des espaces (ex. "Laurent Jean-Claude Marcel").
 *
 * Préserve les prénoms composés à tiret ("Jean-Pierre" reste tel quel) et
 * casse uniquement sur espace. La casse et les accents originaux sont
 * conservés (la normalisation pour patterns email / RowKey reste à la charge
 * de `normalizeNamePart`).
 *
 *   extractFirstName("Laurent Jean-Claude Marcel") → "Laurent"
 *   extractFirstName("Jean-Pierre")                → "Jean-Pierre"
 *   extractFirstName("")                           → ""
 *   extractFirstName("  Marie   Hélène ")          → "Marie"
 *
 * Bug observé en prod 8 mai 2026 : sans cette extraction, `prenoms` brut
 * traverse le pipeline et `normalizeNamePart` strippe les espaces internes
 * (ex. → "laurentjean-claudemarcel"), corrompant l'input Dropcontact.
 */
function extractFirstName(raw) {
  if (!raw) return '';
  const tokens = String(raw).trim().split(/\s+/);
  return tokens[0] || '';
}

/**
 * Nettoie un nom de famille en dédoublonnant les répétitions consécutives
 * IDENTIQUES (insensibles à la casse). Préserve les noms composés.
 *
 *   extractLastName("Dorchies Dorchies") → "Dorchies"
 *   extractLastName("Petit Petit")       → "Petit"
 *   extractLastName("Lancia Pin")        → "Lancia Pin"  (composé authentique)
 *   extractLastName("Lancia-Pin")        → "Lancia-Pin"
 *   extractLastName("Dupont")            → "Dupont"
 *
 * Bug observé en prod 8 mai 2026 : RowKeys `dorchiesdorchies`, `luzyluzy`,
 * `petitpetit` — RNE renvoie parfois nom_naissance + nom_usage identiques
 * concaténés dans le champ `nom`. La déduplication évite de présenter à
 * Dropcontact un nom irréel comme "Dorchiesdorchies".
 */
function extractLastName(raw) {
  if (!raw) return '';
  // S1bis (8 mai 2026 PM) — gestion format RNE avec parenthèses : nom d'usage
  // entre parenthèses différent du nom légal. Cas observés en prod 8 mai :
  //   "DORCHIES (DORCHIES)"  → "DORCHIES"   (parenthèse identique = doublon)
  //   "LANCIA (PIN)"         → "LANCIA-PIN" (parenthèse différente = composé)
  //   "LUZY (LUZY)"          → "LUZY"
  //   "ESCOFFIER (ESCOFFIER" → "ESCOFFIER"  (parenthèse mal fermée parfois)
  //
  // Stratégie : extraire le contenu entre parenthèses, comparer au nom hors
  // parenthèses. Si identique (case-insensitive) → strip parenthèses. Sinon
  // → fusionner avec tiret comme nom composé "Nom-Usage".
  let s = String(raw).trim();
  const parenMatch = s.match(/^([^(]+?)\s*\(([^)]*?)\)?\s*$/);
  if (parenMatch) {
    const outside = parenMatch[1].trim();
    const inside = parenMatch[2].trim();
    if (!inside) {
      // Parenthèse vide ou mal fermée : strip
      s = outside;
    } else if (outside.toLowerCase() === inside.toLowerCase()) {
      // Doublon identique : strip parenthèse, garder le nom unique
      s = outside;
    } else {
      // Composé authentique : fusionner avec tiret pour donner "Lancia-Pin"
      s = `${outside}-${inside}`;
    }
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  // Dédoublonne UNIQUEMENT les répétitions consécutives identiques (case-insensitive).
  // Ne pas dédoublonner partout : "Pierre Pierre Dupont" → "Pierre Dupont"
  // (un seul "Pierre"), mais "Pierre Dupont Pierre" reste "Pierre Dupont Pierre".
  const out = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].toLowerCase() !== out[out.length - 1].toLowerCase()) {
      out.push(tokens[i]);
    }
  }
  return out.join(' ');
}

/**
 * Normalise un domaine :
 *   - strip https?:// et ftp://
 *   - strip www. initial
 *   - strip chemin après le premier /
 *   - strip query/fragment
 *   - lowercase
 *   - vérification TLD minimale : au moins un point et TLD 2+ caractères
 *
 * Retourne null si non parseable ou sans TLD valide.
 */
function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0];
  s = s.split('?')[0];
  s = s.split('#')[0];
  s = s.replace(/:\d+$/, '');
  if (!s || !s.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  const tld = s.split('.').pop();
  if (!tld || tld.length < 2) return null;
  return s;
}

// ─── Bootstrap patterns V1 ──────────────────────────────────────────────────

/**
 * 8 patterns issus de l'observation PME FR (SPEC §6).
 *
 * Le "weight" correspond à la probabilité empirique d'observation sur le
 * marché français. `confidence` est l'output du leadExhauster quand ce
 * pattern est appliqué et qu'on n'a pas encore de vérification aval :
 *   - patterns nominatifs haute fréquence → 0.82-0.88
 *   - patterns structurants moins fréquents → 0.70-0.78
 *   - catch-all contact@ → 0.40 (sous seuil par défaut 0.70)
 *
 * La dérive de ces valeurs est assurée par patterns-learner (Jalon 4)
 * qui surcharge la table EmailPatterns.
 */
const BOOTSTRAP_PATTERNS = Object.freeze([
  { id: 'first.last', template: '{first}.{last}@{domain}', weight: 0.40, confidence: 0.88 },
  { id: 'first',      template: '{first}@{domain}',         weight: 0.20, confidence: 0.82 },
  { id: 'f.last',     template: '{f}.{last}@{domain}',      weight: 0.15, confidence: 0.80 },
  { id: 'firstlast',  template: '{first}{last}@{domain}',   weight: 0.08, confidence: 0.75 },
  { id: 'last',       template: '{last}@{domain}',          weight: 0.05, confidence: 0.72 },
  { id: 'first-last', template: '{first}-{last}@{domain}',  weight: 0.04, confidence: 0.70 },
  { id: 'first_last', template: '{first}_{last}@{domain}',  weight: 0.03, confidence: 0.70 },
  { id: 'contact',    template: 'contact@{domain}',         weight: 0.05, confidence: 0.40 },
]);

function getBootstrapPatterns() {
  // Retourne une copie pour éviter les mutations externes
  return BOOTSTRAP_PATTERNS.map((p) => ({ ...p }));
}

/**
 * Tri des patterns selon le contexte. V1 : retourne les patterns bootstrap
 * triés par poids décroissant (contact@ en dernier malgré son poids 0.05
 * car confidence trop basse pour être testé tôt).
 *
 * V2 (Jalon 4) : surcharge depuis table EmailPatterns avec naf/tranche.
 *
 * @param {Object} [context]
 * @param {string} [context.naf]       Code NAF complet (ex. "70.22Z")
 * @param {string} [context.tranche]   Tranche effectif INSEE (ex. "11")
 * @returns {Array<{id:string, template:string, weight:number, confidence:number}>}
 */
function rankPatternsForContext(/* context */) {
  const out = getBootstrapPatterns();
  // Trier par (confidence desc, weight desc), contact@ en queue
  out.sort((a, b) => {
    if (a.id === 'contact') return 1;
    if (b.id === 'contact') return -1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.weight - a.weight;
  });
  return out;
}

/**
 * Applique un pattern à un contexte (firstName, lastName, domain) et
 * retourne l'email candidat — OU null si le pattern est inapplicable
 * (token manquant nécessaire au template, domaine invalide, etc.).
 *
 *   applyPattern('{first}.{last}@{domain}',
 *     { firstName: 'Jean', lastName: 'Dupont', domain: 'acme.fr' })
 *     → 'jean.dupont@acme.fr'
 *
 *   applyPattern('{first}.{last}@{domain}',
 *     { firstName: 'Jean', lastName: '', domain: 'acme.fr' })
 *     → null (token {last} requis)
 *
 *   applyPattern('contact@{domain}', { domain: 'acme.fr' })
 *     → 'contact@acme.fr'
 *
 * @param {string} template         Ex. "{first}.{last}@{domain}"
 * @param {Object} ctx
 * @param {string} [ctx.firstName]
 * @param {string} [ctx.lastName]
 * @param {string} [ctx.domain]
 * @returns {string|null} email candidat normalisé, ou null
 */
function applyPattern(template, ctx = {}) {
  if (!template || typeof template !== 'string') return null;
  const first = normalizeNamePart(ctx.firstName);
  const last = normalizeNamePart(ctx.lastName);
  const domain = normalizeDomain(ctx.domain);
  if (!domain) return null;

  const tokens = {
    '{first}': first,
    '{last}': last,
    '{f}': first ? first.charAt(0) : '',
    '{l}': last ? last.charAt(0) : '',
    '{domain}': domain,
  };

  // Fail-safe : chaque token requis doit résoudre à non-vide (sauf domain
  // traité séparément). Si un token utilisé est vide, on retourne null
  // plutôt que de produire une adresse malformée type ".dupont@acme.fr".
  for (const [key, value] of Object.entries(tokens)) {
    if (template.includes(key) && key !== '{domain}' && !value) {
      return null;
    }
  }

  let email = template;
  for (const [key, value] of Object.entries(tokens)) {
    email = email.split(key).join(value);
  }

  // Validation finale : une seule @, local-part non vide, pas de doubles points
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) return null;
  if (email.includes('..')) return null;
  if (email.startsWith('.') || email.includes('.@')) return null;

  return email;
}

/**
 * Dérive une confidence pour un pattern donné. Utilisé par l'orchestrateur
 * quand un pattern est appliqué et vérifié (scraping match ou Google match).
 * Retourne la confidence du bootstrap si connue, sinon 0.5 (neutre).
 */
function confidenceForPattern(patternIdOrTemplate) {
  const p = BOOTSTRAP_PATTERNS.find(
    (x) => x.id === patternIdOrTemplate || x.template === patternIdOrTemplate,
  );
  return p ? p.confidence : 0.5;
}

module.exports = {
  normalizeNamePart,
  extractFirstName,
  extractLastName,
  normalizeDomain,
  getBootstrapPatterns,
  rankPatternsForContext,
  applyPattern,
  confidenceForPattern,
  // Exposé pour tests :
  _BOOTSTRAP_PATTERNS: BOOTSTRAP_PATTERNS,
};
