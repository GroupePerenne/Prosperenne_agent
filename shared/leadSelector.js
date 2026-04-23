'use strict';

/**
 * Lead Selector v1.0 — chantier 1.
 *
 * Transforme un brief consultant (issu du formulaire ou relu depuis Mem0) en
 * un batch de leads prêt pour `launchSequenceForConsultant`. Pur producteur :
 * neutre vis-à-vis de l'agent (Martin/Mila), aucune écriture Pipedrive (la
 * dédup et le routage agent sont gérés en aval par david/orchestrator.js).
 *
 * Points d'entrée :
 *   - selectLeadsForConsultant({ brief, batchSize?, adapters?, context? })
 *   - selectLeadsForConsultantById({ consultantId, batchSize?, adapters?, context? })
 *
 * Format du SelectorResult retourné : voir SPEC §1.1.
 */

const { LeadBaseAdapter } = require('./adapters/leadbase/leadbase-table');
const {
  geocodeAddress,
  haversineKm,
  departementCentroid,
  DEPARTEMENT_CENTROIDS,
  CENTRE_FRANCE_METROPOLITAINE,
} = require('./geocoding');
const { getMem0 } = require('./adapters/memory/mem0');
const { recordLeadSelectorEvent } = require('./leadSelectorTrace');

const SECTORS_TO_NAF = require('./mappings/secteurs-to-naf.json');
const EFFECTIF_TO_TRANCHE = require('./mappings/effectif-to-tranche-insee.json');
const NAF_EXCLUSIONS = require('./mappings/naf-exclusions.json');

const DEFAULT_BATCH_SIZE = Number(process.env.LEAD_SELECTOR_BATCH_SIZE || 10);
const DEFAULT_HARD_LIMIT = Number(process.env.LEAD_SELECTOR_HARD_LIMIT || 2000);
const DEFAULT_EFFECTIF_FALLBACK = ['11', '12', '21'];
const NAF_CODE_REGEX = /^\d{2}\.\d{2}[A-Z]$/;

const EXCLUSION_CODES = new Set((NAF_EXCLUSIONS.exclusions || []).map((e) => e.code));

// ─── Helpers internes ──────────────────────────────────────────────────────

function splitCsv(s) {
  if (!s) return [];
  return String(s)
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort();
}

function logWarn(context, message) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(message);
  else if (typeof context.log === 'function') context.log(`[warn] ${message}`);
}

function logInfo(context, message, payload) {
  if (!context) return;
  if (typeof context.info === 'function') context.info(message, payload);
  else if (typeof context.log === 'function') context.log(message, payload);
}

// ─── mapBriefToFilters ─────────────────────────────────────────────────────

/**
 * Déduit les filtres LeadBase d'un brief consultant. Logique tolérante :
 * tags inconnus → warn + ignore, codes NAF invalides → warn + ignore.
 */
function mapBriefToFilters(brief, { context } = {}) {
  const nafSet = new Set();

  // 1. Tags secteurs → NAF
  for (const tag of splitCsv(brief.secteurs)) {
    const codes = SECTORS_TO_NAF[tag];
    if (!Array.isArray(codes)) {
      logWarn(context, `[leadSelector] unknown secteur tag: ${tag}`);
      continue;
    }
    for (const c of codes) nafSet.add(c);
  }

  // 2. secteurs_autres : codes NAF saisis directement (autocomplete)
  for (const raw of splitCsv(brief.secteurs_autres)) {
    if (!NAF_CODE_REGEX.test(raw)) {
      logWarn(context, `[leadSelector] invalid NAF code: ${raw}`);
      continue;
    }
    nafSet.add(raw);
  }

  // 3. Effectif
  const effectifSet = new Set();
  for (const tranche of splitCsv(brief.effectif)) {
    const codes = EFFECTIF_TO_TRANCHE[tranche];
    if (!Array.isArray(codes)) {
      logWarn(context, `[leadSelector] unknown effectif tranche: ${tranche}`);
      continue;
    }
    for (const c of codes) effectifSet.add(c);
  }
  let effectifCodes = uniqSorted([...effectifSet]);
  if (effectifCodes.length === 0) {
    logWarn(context, `[leadSelector] no effectif mapped → fallback ${DEFAULT_EFFECTIF_FALLBACK.join(',')}`);
    effectifCodes = [...DEFAULT_EFFECTIF_FALLBACK];
  }

  return {
    nafCodes: uniqSorted([...nafSet]),
    effectifCodes,
    departements: deduceDepartements(brief, { context }),
    hardLimit: DEFAULT_HARD_LIMIT,
  };
}

// ─── Régions métropolitaines → départements INSEE ──────────────────────────
// Source : référentiel INSEE post-réforme 2016 (13 régions métropolitaines).
// Les DOM (Guadeloupe, Martinique, Guyane, Réunion, Mayotte) sont volontairement
// hors scope V1 : les consultants OSEYS ciblent la France métropolitaine, et
// la LeadBase n'a pas de couverture DOM équilibrée. Fallback pour un dep DOM :
// retourner [dep] (on reste limité au département unique).
const REGION_TO_DEPARTEMENTS = {
  ARA: ['01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74'],
  BFC: ['21', '25', '39', '58', '70', '71', '89', '90'],
  BRE: ['22', '29', '35', '56'],
  CVL: ['18', '28', '36', '37', '41', '45'],
  COR: ['2A', '2B'],
  GES: ['08', '10', '51', '52', '54', '55', '57', '67', '68', '88'],
  HDF: ['02', '59', '60', '62', '80'],
  IDF: ['75', '77', '78', '91', '92', '93', '94', '95'],
  NOR: ['14', '27', '50', '61', '76'],
  NAQ: ['16', '17', '19', '23', '24', '33', '40', '47', '64', '79', '86', '87'],
  OCC: ['09', '11', '12', '30', '31', '32', '34', '46', '48', '65', '66', '81', '82'],
  PDL: ['44', '49', '53', '72', '85'],
  PAC: ['04', '05', '06', '13', '83', '84'],
};
const DEPARTEMENT_TO_REGION = (() => {
  const out = {};
  for (const [region, deps] of Object.entries(REGION_TO_DEPARTEMENTS)) {
    for (const d of deps) out[d] = region;
  }
  return out;
})();

/**
 * Approximation v1 du filtre département à partir du brief.
 *  - zone='france' → []  (pas de filtre)
 *  - zone='region' → départements de la région du consultant déduite via
 *    son CP (table REGION_TO_DEPARTEMENTS). Si CP non exploitable → [].
 *  - zone='adresse' / 'custom' / 'default' / chaîne libre → liste des
 *    départements dont le centroïde est à <= (rayon + 100km) du center
 *    issu de l'adresse du consultant. Si on ne peut pas géocoder, [].
 *
 * Note : la précision finale se fait au tri haversine post-query, ce filtre
 * département sert juste à éviter de scanner toute la France quand on cible
 * une zone locale.
 */
function deduceDepartements(brief, { context } = {}) {
  const zone = String(brief.zone || 'default').toLowerCase();
  if (zone === 'france') return [];
  if (zone === 'region') {
    const dep = inferDepartementFromBrief(brief);
    if (!dep) return [];
    const region = DEPARTEMENT_TO_REGION[dep];
    if (!region) return [dep]; // DOM hors cible v1 ou dép inconnu → fallback au dep seul
    return [...REGION_TO_DEPARTEMENTS[region]];
  }

  // Zones locales : on a besoin d'un center. Si pas géocodable, on laisse
  // ouvert (pas de filtre PartitionKey) plutôt que de vider la query.
  // Note : on ne géocode PAS ici (sync). Le vrai filtrage par distance se
  // fait au tri haversine en aval. Ici, on tente un ratrapage rapide via
  // le département inféré du code postal présent dans l'adresse/ville.
  const dep = inferDepartementFromBrief(brief);
  if (!dep) return [];

  const rayon = Number(brief.zone_rayon) || 25;
  const center = departementCentroid(dep);
  if (!center) return [dep];

  const radius = rayon + 100;
  const out = [];
  for (const [d, c] of Object.entries(DEPARTEMENT_CENTROIDS)) {
    if (haversineKm(center, c) <= radius) out.push(d);
  }
  // Garde-fou : si le calcul renvoie tout le pays, on supprime le filtre
  if (out.length >= 90) return [];
  return out.length > 0 ? out : [dep];
}

function inferDepartementFromBrief(brief) {
  const fields = [brief.adresse, brief.ville];
  for (const f of fields) {
    if (!f) continue;
    const m = String(f).match(/\b(\d{5})\b/);
    if (m) {
      const cp = m[1];
      // CP DOM : 971xx-976xx → dep 971/972/973/974/976
      if (cp.startsWith('97')) return cp.slice(0, 3);
      // Corse : 200xx-201xx → 2A, 202xx-206xx → 2B (approximation usuelle)
      if (cp.startsWith('20')) {
        const n = Number(cp);
        return n < 20200 ? '2A' : '2B';
      }
      return cp.slice(0, 2);
    }
  }
  return null;
}

// ─── Exclusions produit (NAF) ──────────────────────────────────────────────

function applyExclusions(entities) {
  const kept = [];
  const excluded = [];
  for (const e of entities) {
    if (e && EXCLUSION_CODES.has(e.codeNaf)) excluded.push(e);
    else kept.push(e);
  }
  return { kept, excluded };
}

// ─── Format de sortie ──────────────────────────────────────────────────────

function buildContexte(entity, dirigeant) {
  const parts = [];
  if (entity.nom) parts.push(entity.nom);
  if (entity.codeNaf) parts.push(`NAF ${entity.codeNaf}`);
  if (entity.trancheEffectif) parts.push(`tranche ${entity.trancheEffectif}`);
  if (entity.ville) parts.push(entity.ville);
  return parts.join(' · ');
}

/**
 * Convertit une entité LeadBase en lead au format launchSequenceForConsultant.
 * V1 stricte : pas d'email exploitable → null (le caller filtre).
 *
 * Jalon 3 extension (Path additif b') : ajout du `siren` dans le DTO pour
 * que les consommateurs aval (lead-exhauster notamment) puissent appeler
 * l'API de résolution d'email à partir du SIREN. Extension non-breaking :
 * les tests existants qui ne lisent pas ce champ restent verts.
 */
function extractLeadFromEntity(entity) {
  if (!entity) return null;
  const parsed = parseFirstDirigeant(entity);
  const firstDirigeant = parsed.dirigeant;
  const email = firstDirigeant && firstDirigeant.email ? String(firstDirigeant.email).trim() : null;
  if (!email) return null;
  return {
    siren: String(entity.siren || ''),
    prenom: ((firstDirigeant && (firstDirigeant.prenoms || firstDirigeant.prenom)) || '').trim(),
    nom: ((firstDirigeant && firstDirigeant.nom) || '').trim(),
    entreprise: entity.nom || '',
    email,
    secteur: entity.codeNaf || '',
    ville: entity.ville || '',
    contexte: buildContexte(entity, firstDirigeant),
  };
}

/**
 * Extrait un "candidate" d'une entité LeadBase — sans exiger d'email.
 * Utilisé par `selectCandidatesForConsultant` pour alimenter leadExhauster,
 * qui résoudra l'email en aval via ses propres sources (patterns, scraping,
 * Dropcontact cascade).
 *
 * Format candidate :
 *   {
 *     siren, firstName, lastName, companyName,
 *     ville, codeNaf, trancheEffectif,
 *     latitude, longitude,
 *     inseeRole,  // "Président", "Gérant" selon INSEE (si renseigné)
 *     contexte,
 *     // email éventuellement présent dans l'entité (facultatif, servira
 *     // d'indice pour la cache LeadContacts)
 *     hintedEmail,
 *   }
 *
 * Retourne null si entité invalide OU si aucun dirigeant identifiable
 * (pas de prénom ni nom ni raison sociale exploitable). Dans ce dernier
 * cas, exhauster ne pourrait pas faire son travail non plus.
 */
function extractCandidateFromEntity(entity) {
  if (!entity || !entity.siren) return null;
  const parsed = parseFirstDirigeant(entity);
  const firstDirigeant = parsed.dirigeant;

  const firstName = ((firstDirigeant && (firstDirigeant.prenoms || firstDirigeant.prenom)) || '').trim();
  const lastName = ((firstDirigeant && firstDirigeant.nom) || '').trim();
  const companyName = entity.nom || '';

  // Au minimum : nom d'entreprise + (firstName OU lastName) pour permettre
  // la résolution exhauster. Sinon on skip silencieusement.
  if (!companyName || (!firstName && !lastName)) return null;

  const hintedEmail = firstDirigeant && firstDirigeant.email
    ? String(firstDirigeant.email).trim()
    : null;

  return {
    siren: String(entity.siren),
    firstName,
    lastName,
    companyName,
    ville: entity.ville || '',
    codeNaf: entity.codeNaf || '',
    trancheEffectif: entity.trancheEffectif || '',
    latitude: entity.latitude || null,
    longitude: entity.longitude || null,
    inseeRole: ((firstDirigeant && (firstDirigeant.fonction || firstDirigeant.role)) || '').trim(),
    contexte: buildContexte(entity, firstDirigeant),
    hintedEmail,
  };
}

function parseFirstDirigeant(entity) {
  let dirigeant = null;
  try {
    const dirs = JSON.parse(entity.dirigeants || '[]');
    if (Array.isArray(dirs) && dirs.length > 0) dirigeant = dirs[0];
  } catch {
    dirigeant = null;
  }
  return { dirigeant };
}

// ─── Géocodage du center pour le tri distance ───────────────────────────────

async function computeZoneCenter(brief, { context, geocode = geocodeAddress } = {}) {
  const zone = String(brief.zone || 'default').toLowerCase();

  // France entière → centre géographique
  if (zone === 'france') return { ...CENTRE_FRANCE_METROPOLITAINE, source: 'centre_france' };

  // Zones locales et région : tenter dans l'ordre
  // 1. brief.adresse complète
  if (brief.adresse) {
    const r = await geocode(brief.adresse).catch(() => null);
    if (r) return r;
  }

  // 2. brief.ville (souvent juste le nom de ville sans code postal)
  if (brief.ville) {
    const r = await geocode(brief.ville).catch(() => null);
    if (r) return r;
  }

  // 3. Fallback département inféré
  const dep = inferDepartementFromBrief(brief);
  if (dep) {
    const c = departementCentroid(dep);
    if (c) return { ...c, source: `centroid_${dep}` };
  }

  // 4. Centre France
  return { ...CENTRE_FRANCE_METROPOLITAINE, source: 'centre_france_fallback' };
}

// ─── Tri par distance décroissante ──────────────────────────────────────────

function entityCoords(entity) {
  if (!entity) return null;
  const lat = parseFloat(entity.latitude);
  const lon = parseFloat(entity.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * Tri décroissant par distance haversine au center. Entités sans GPS
 * placées en queue, triées entre elles par ville (alphabétique stable).
 *
 * Décroissant = règle produit Paul : démarrer par les leads les plus éloignés
 * (faible enjeu) pour laisser les agents apprendre avant d'approcher du local.
 */
function sortByDistanceDesc(entities, center) {
  const withGps = [];
  const withoutGps = [];
  for (const e of entities) {
    if (entityCoords(e)) withGps.push(e);
    else withoutGps.push(e);
  }
  withGps.sort((a, b) => {
    const da = haversineKm(center, entityCoords(a));
    const db = haversineKm(center, entityCoords(b));
    return db - da;
  });
  withoutGps.sort((a, b) => String(a.ville || '').localeCompare(String(b.ville || '')));
  return [...withGps, ...withoutGps];
}

// ─── Flow principal ─────────────────────────────────────────────────────────

async function selectLeadsForConsultant(params = {}) {
  const started = Date.now();
  const {
    brief = {},
    batchSize = DEFAULT_BATCH_SIZE,
    adapters = {},
    context,
    briefId,
    consultantId,
  } = params;

  const leadBase = adapters.leadBase || new LeadBaseAdapter({ logger: context && context.log });
  const trace = adapters.trace || recordLeadSelectorEvent;

  try {
    const filters = mapBriefToFilters(brief, { context });

    if (filters.nafCodes.length === 0) {
      const empty = {
        status: 'empty',
        leads: [],
        meta: {
          requested: batchSize,
          candidatesCount: 0,
          excludedByRules: 0,
          excludedNoEmail: 0,
          excludedNoGps: 0,
          returned: 0,
          nafCodesQueried: [],
          effectifCodesQueried: filters.effectifCodes,
          zoneFilter: { type: brief.zone || 'default', center: null, radiusKm: Number(brief.zone_rayon) || null },
          reason: 'no_sector_mapped',
          elapsedMs: Date.now() - started,
        },
      };
      Promise.resolve(trace({ status: empty.status, meta: empty.meta, briefId, consultantId })).catch(() => {});
      return empty;
    }

    const candidates = await leadBase.queryLeads({
      nafCodes: filters.nafCodes,
      effectifCodes: filters.effectifCodes,
      departements: filters.departements,
      hardLimit: filters.hardLimit,
    });
    const candidatesCount = candidates.length;

    const { kept: afterExclusions, excluded } = applyExclusions(candidates);

    let excludedNoEmail = 0;
    const enriched = [];
    for (const e of afterExclusions) {
      const lead = extractLeadFromEntity(e);
      if (!lead) {
        excludedNoEmail++;
        continue;
      }
      enriched.push({ entity: e, lead });
    }

    const center = await computeZoneCenter(brief, { context });

    const sortedEntities = sortByDistanceDesc(enriched.map((x) => x.entity), center);
    const entityToLead = new Map();
    for (const x of enriched) entityToLead.set(x.entity, x.lead);

    const sortedLeads = sortedEntities.map((e) => entityToLead.get(e)).filter(Boolean);
    const excludedNoGps = sortedEntities.filter((e) => !entityCoords(e)).length;

    const selected = sortedLeads.slice(0, batchSize);

    const status =
      selected.length === 0
        ? 'empty'
        : selected.length < batchSize
          ? 'insufficient'
          : 'ok';

    const result = {
      status,
      leads: selected,
      meta: {
        requested: batchSize,
        candidatesCount,
        excludedByRules: excluded.length,
        excludedNoEmail,
        excludedNoGps,
        returned: selected.length,
        nafCodesQueried: filters.nafCodes,
        effectifCodesQueried: filters.effectifCodes,
        zoneFilter: {
          type: brief.zone || 'default',
          center,
          radiusKm: Number(brief.zone_rayon) || null,
        },
        elapsedMs: Date.now() - started,
      },
    };

    logInfo(context, '[leadSelector] selectLeadsForConsultant', {
      status,
      requested: batchSize,
      candidatesCount,
      returned: selected.length,
      ms: result.meta.elapsedMs,
    });

    Promise.resolve(trace({ status: result.status, meta: result.meta, briefId, consultantId })).catch(() => {});
    return result;
  } catch (err) {
    if (context && typeof context.error === 'function') context.error('[leadSelector] failed', err);
    const errResult = {
      status: 'error',
      leads: [],
      meta: {
        errorCode: err && err.code ? err.code : 'unknown',
        errorMessage: err && err.message ? err.message : String(err),
        elapsedMs: Date.now() - started,
      },
    };
    Promise.resolve(trace({ status: errResult.status, meta: errResult.meta, briefId, consultantId })).catch(() => {});
    return errResult;
  }
}

// ─── selectCandidatesForConsultant (Path additif Jalon 3) ──────────────────

const DEFAULT_CANDIDATE_MULTIPLIER = Number(process.env.LEAD_SELECTOR_CANDIDATE_MULTIPLIER || 3);

/**
 * Variante "candidates" de `selectLeadsForConsultant` — extension autorisée
 * du scope SPEC §5 validée par Paul (Path additif b').
 *
 * Diff vs `selectLeadsForConsultant` :
 *   - Applique `extractCandidateFromEntity` au lieu de `extractLeadFromEntity`
 *     → aucun filtre sur la présence d'email (c'est le job de lead-exhauster)
 *   - Retourne jusqu'à `batchSize * candidateMultiplier` candidats (3x par
 *     défaut) pour donner de la marge au pipeline exhauster : chaque candidat
 *     sera passé à leadExhauster ; certains seront résolus, d'autres tomberont
 *     en unresolvable ; le caller itère jusqu'à avoir `batchSize` enriched
 *   - Meta distinct : pas de `excludedNoEmail` (c'est LeadContacts qui tracera
 *     les unresolvable, SPEC §9.3) ; ajout `excludedNoDirigeant` pour les
 *     entités sans nom/prénom ni raison sociale exploitables
 *   - Trace source marquée `source: 'candidates'` dans le meta pour que
 *     dailyReport puisse distinguer les 2 flows (point Paul #3 Jalon 3)
 *
 * `selectLeadsForConsultant` (legacy) reste intact et testé non-régression.
 *
 * @param {Object} params
 * @param {Object} params.brief
 * @param {number} [params.batchSize]              Nombre cible d'enriched
 * @param {number} [params.candidateMultiplier]   Défaut 3, override possible
 * @param {Object} [params.adapters]
 * @param {Object} [params.context]
 * @param {string} [params.briefId]
 * @param {string} [params.consultantId]
 * @returns {Promise<{ status, candidates, meta }>}
 */
async function selectCandidatesForConsultant(params = {}) {
  const started = Date.now();
  const {
    brief = {},
    batchSize = DEFAULT_BATCH_SIZE,
    candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER,
    adapters = {},
    context,
    briefId,
    consultantId,
  } = params;

  const leadBase = adapters.leadBase || new LeadBaseAdapter({ logger: context && context.log });
  const trace = adapters.trace || recordLeadSelectorEvent;

  const maxCandidates = Math.max(batchSize, batchSize * candidateMultiplier);

  try {
    const filters = mapBriefToFilters(brief, { context });

    if (filters.nafCodes.length === 0) {
      const empty = {
        status: 'empty',
        candidates: [],
        meta: {
          requested: batchSize,
          candidatesCount: 0,
          excludedByRules: 0,
          excludedNoDirigeant: 0,
          excludedNoGps: 0,
          returned: 0,
          nafCodesQueried: [],
          effectifCodesQueried: filters.effectifCodes,
          zoneFilter: { type: brief.zone || 'default', center: null, radiusKm: Number(brief.zone_rayon) || null },
          reason: 'no_sector_mapped',
          source: 'candidates',
          elapsedMs: Date.now() - started,
        },
      };
      Promise.resolve(trace({ status: empty.status, meta: empty.meta, briefId, consultantId })).catch(() => {});
      return empty;
    }

    const rawCandidates = await leadBase.queryLeads({
      nafCodes: filters.nafCodes,
      effectifCodes: filters.effectifCodes,
      departements: filters.departements,
      hardLimit: filters.hardLimit,
    });
    const candidatesCount = rawCandidates.length;

    const { kept: afterExclusions, excluded } = applyExclusions(rawCandidates);

    // Extraction candidate (sans filtre email)
    let excludedNoDirigeant = 0;
    const enriched = [];
    for (const e of afterExclusions) {
      const cand = extractCandidateFromEntity(e);
      if (!cand) {
        excludedNoDirigeant++;
        continue;
      }
      enriched.push({ entity: e, candidate: cand });
    }

    const center = await computeZoneCenter(brief, { context });

    const sortedEntities = sortByDistanceDesc(enriched.map((x) => x.entity), center);
    const entityToCandidate = new Map();
    for (const x of enriched) entityToCandidate.set(x.entity, x.candidate);

    const sortedCandidates = sortedEntities.map((e) => entityToCandidate.get(e)).filter(Boolean);
    const excludedNoGps = sortedEntities.filter((e) => !entityCoords(e)).length;

    const selected = sortedCandidates.slice(0, maxCandidates);

    const status = selected.length === 0
      ? 'empty'
      : selected.length < batchSize
        ? 'insufficient'
        : 'ok';

    const result = {
      status,
      candidates: selected,
      meta: {
        requested: batchSize,
        maxCandidates,
        candidatesCount,
        excludedByRules: excluded.length,
        excludedNoDirigeant,
        excludedNoGps,
        returned: selected.length,
        nafCodesQueried: filters.nafCodes,
        effectifCodesQueried: filters.effectifCodes,
        zoneFilter: {
          type: brief.zone || 'default',
          center,
          radiusKm: Number(brief.zone_rayon) || null,
        },
        source: 'candidates',
        elapsedMs: Date.now() - started,
      },
    };

    logInfo(context, '[leadSelector] selectCandidatesForConsultant', {
      status,
      requested: batchSize,
      maxCandidates,
      candidatesCount,
      returned: selected.length,
      ms: result.meta.elapsedMs,
    });

    Promise.resolve(trace({ status: result.status, meta: result.meta, briefId, consultantId })).catch(() => {});
    return result;
  } catch (err) {
    if (context && typeof context.error === 'function') context.error('[leadSelector] selectCandidates failed', err);
    const errResult = {
      status: 'error',
      candidates: [],
      meta: {
        errorCode: err && err.code ? err.code : 'unknown',
        errorMessage: err && err.message ? err.message : String(err),
        source: 'candidates',
        elapsedMs: Date.now() - started,
      },
    };
    Promise.resolve(trace({ status: errResult.status, meta: errResult.meta, briefId, consultantId })).catch(() => {});
    return errResult;
  }
}

// ─── selectLeadsForConsultantById (Mem0) ───────────────────────────────────

async function selectLeadsForConsultantById(params = {}) {
  const { consultantId, batchSize, adapters = {}, context } = params;
  if (!consultantId) {
    return {
      status: 'error',
      leads: [],
      meta: { errorCode: 'consultant_id_required', elapsedMs: 0 },
    };
  }

  const mem0 = adapters.mem0 || getMem0(context);
  if (!mem0) {
    return { status: 'error', leads: [], meta: { errorCode: 'mem0_off', elapsedMs: 0 } };
  }

  let memories;
  try {
    memories = await mem0.retrieveConsultant(consultantId);
  } catch (err) {
    return {
      status: 'error',
      leads: [],
      meta: { errorCode: 'mem0_retrieve_failed', errorMessage: err && err.message, elapsedMs: 0 },
    };
  }

  if (!memories || memories.length === 0) {
    return { status: 'error', leads: [], meta: { errorCode: 'consultant_not_found', elapsedMs: 0 } };
  }

  const brief = parseBriefFromMemories(memories);
  if (!brief) {
    return { status: 'error', leads: [], meta: { errorCode: 'brief_parse_failed', elapsedMs: 0 } };
  }

  return selectLeadsForConsultant({ brief, batchSize, adapters, context });
}

/**
 * Variante Mem0-by-id de `selectCandidatesForConsultant`. Mirror exact de
 * `selectLeadsForConsultantById` mais pour le flow candidates (Jalon 3).
 */
async function selectCandidatesForConsultantById(params = {}) {
  const { consultantId, batchSize, candidateMultiplier, adapters = {}, context } = params;
  if (!consultantId) {
    return {
      status: 'error',
      candidates: [],
      meta: { errorCode: 'consultant_id_required', elapsedMs: 0 },
    };
  }

  const mem0 = adapters.mem0 || getMem0(context);
  if (!mem0) {
    return { status: 'error', candidates: [], meta: { errorCode: 'mem0_off', elapsedMs: 0 } };
  }

  let memories;
  try {
    memories = await mem0.retrieveConsultant(consultantId);
  } catch (err) {
    return {
      status: 'error',
      candidates: [],
      meta: { errorCode: 'mem0_retrieve_failed', errorMessage: err && err.message, elapsedMs: 0 },
    };
  }

  if (!memories || memories.length === 0) {
    return { status: 'error', candidates: [], meta: { errorCode: 'consultant_not_found', elapsedMs: 0 } };
  }

  const brief = parseBriefFromMemories(memories);
  if (!brief) {
    return { status: 'error', candidates: [], meta: { errorCode: 'brief_parse_failed', elapsedMs: 0 } };
  }

  return selectCandidatesForConsultant({ brief, batchSize, candidateMultiplier, adapters, context });
}

function parseBriefFromMemories(memories) {
  // Cherche la mémoire la plus complète (avec display_name) parmi les hits.
  // Le SDK mem0ai range le contenu dans m.memory (string JSON) ou m.data.memory.
  for (const m of memories) {
    const raw = (m && (m.memory || (m.data && m.data.memory) || m.text)) || '';
    if (!raw || typeof raw !== 'string') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.display_name) return reviveBriefFromConsultantMemory(parsed);
    } catch {
      /* try next */
    }
  }
  return null;
}

function reviveBriefFromConsultantMemory(cm) {
  return {
    nom: cm.display_name,
    email: cm.email || '',
    secteurs: Array.isArray(cm.favorite_sectors) ? cm.favorite_sectors.join(',') : '',
    secteurs_autres: cm.secteurs_autres || '',
    effectif: cm.effectif || '',
    zone: cm.zone || 'default',
    zone_rayon: cm.zone_rayon || null,
    adresse: cm.adresse || '',
    ville: cm.ville || '',
    offre: cm.commercial_strategy || '',
    registre: cm.preferred_tone || '',
    vouvoiement: cm.tutoiement ? 'tu' : 'vous',
    prospecteur: cm.prospecteur || 'both',
    niveau_autonomie: cm.autonomy_level || 'autonome',
  };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  selectLeadsForConsultant,
  selectLeadsForConsultantById,
  selectCandidatesForConsultant,
  selectCandidatesForConsultantById,
  // exposés pour tests :
  mapBriefToFilters,
  applyExclusions,
  applyEmailFilter: (entities) => {
    // Helper public pour les tests : applique extractLeadFromEntity et
    // retourne { kept, excludedNoEmail }.
    const kept = [];
    let excludedNoEmail = 0;
    for (const e of entities) {
      const lead = extractLeadFromEntity(e);
      if (lead) kept.push({ entity: e, lead });
      else excludedNoEmail++;
    }
    return { kept, excludedNoEmail };
  },
  extractLeadFromEntity,
  extractCandidateFromEntity,
  computeZoneCenter,
  sortByDistanceDesc,
  parseBriefFromMemories,
  reviveBriefFromConsultantMemory,
  inferDepartementFromBrief,
  deduceDepartements,
};
