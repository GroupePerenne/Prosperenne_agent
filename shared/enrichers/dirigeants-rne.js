'use strict';

/**
 * Enricher dirigeants via API gouvernement Recherche d'Entreprises
 * (https://recherche-entreprises.api.gouv.fr).
 *
 * Permet de combler le trou structurel de la LeadBase Constantin où la
 * majorité des entités ont `dirigeants: null` (observation 4 mai 2026 :
 * 1810/2000 candidats sans dirigeant pour le brief Morgane).
 *
 * Source : Registre National des Entreprises (RNE) consolidé via api.gouv.fr.
 * - Free, no auth, public
 * - Latence ~150-500ms par siren
 * - Rate limit non documenté mais raisonnable (10+ req/s observé)
 * - Format dirigeants : array de personne physique avec prenoms/nom/qualite
 *
 * Cache : Storage Table DirigeantsCache (PartitionKey = 2 premiers chiffres
 * du siren, RowKey = siren) avec TTL 30 jours (frais) via fetchedAt et
 * TTL 365 jours dégradé en mode fallback.
 *
 * Résilience I-4 (multi-source via fallback dégradé) :
 *   - Circuit breaker : 5 échecs consécutifs en 60s → ouvre 5 min.
 *     Pendant ce temps, on bypass l'API et on lit le cache dégradé.
 *   - Cache dégradé : TTL 365j (CACHE_TTL_DEGRADED_DAYS) accepté en lecture
 *     quand RNE est down. Cohérent invariant V (donnée potentiellement
 *     obsolète mais disponible > pas de donnée), pattern aligné avec
 *     SIRENE downloader fallback snapshot local TTL 35j (cf.
 *     `feedback_fallback_snapshot_local_vs_api_tierce.md` 7 mai 2026).
 *
 * Le scraping HTML annuaire-entreprises.data.gouv.fr est volontairement
 * écarté (Mac Paul ban Incapsula, parsing HTML fragile, risque ban
 * dynamique côté worker Mac Air sur volume). Reportable en follow-up
 * dédié testé in-situ sur Mac Air si la couverture s'avère insuffisante.
 */

const { TableClient } = require('@azure/data-tables');

const RNE_API_BASE = 'https://recherche-entreprises.api.gouv.fr';
const TABLE_NAME = process.env.DIRIGEANTS_CACHE_TABLE || 'DirigeantsCache';
const CACHE_TTL_DAYS = Number(process.env.DIRIGEANTS_CACHE_TTL_DAYS || 30);
const CACHE_TTL_DEGRADED_DAYS = Number(
  process.env.DIRIGEANTS_CACHE_TTL_DEGRADED_DAYS || 365,
);
const FETCH_TIMEOUT_MS = 5000;

// ─── Circuit breaker (I-4 résilience) ───────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const CIRCUIT_BREAKER_OPEN_MS = 300_000; // 5 min

let _failureTimestamps = [];
let _circuitOpenedAt = null;

function _isCircuitOpen() {
  if (_circuitOpenedAt === null) return false;
  if (Date.now() - _circuitOpenedAt > CIRCUIT_BREAKER_OPEN_MS) {
    _circuitOpenedAt = null;
    _failureTimestamps = [];
    return false;
  }
  return true;
}

function _recordFailure() {
  const now = Date.now();
  _failureTimestamps = _failureTimestamps.filter(
    (t) => now - t < CIRCUIT_BREAKER_WINDOW_MS,
  );
  _failureTimestamps.push(now);
  if (_failureTimestamps.length >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitOpenedAt = now;
  }
}

function _recordSuccess() {
  _failureTimestamps = [];
  _circuitOpenedAt = null;
}

function _resetCircuitForTests() {
  _failureTimestamps = [];
  _circuitOpenedAt = null;
}

let _client = null;

function getClient() {
  if (_client) return _client;
  const cs = process.env.LEADBASE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!cs) return null;
  try {
    _client = TableClient.fromConnectionString(cs, TABLE_NAME);
    return _client;
  } catch {
    return null;
  }
}

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (err) {
    if (err && (err.statusCode === 409 || /TableAlreadyExists/i.test(err.message || ''))) return;
  }
}

function partitionKeyFor(siren) {
  return String(siren).slice(0, 2).padStart(2, '0');
}

function isExpired(fetchedAt) {
  if (!fetchedAt) return true;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs > CACHE_TTL_DAYS * 24 * 3600 * 1000;
}

function isExpiredDegraded(fetchedAt) {
  if (!fetchedAt) return true;
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  return ageMs > CACHE_TTL_DEGRADED_DAYS * 24 * 3600 * 1000;
}

/**
 * Récupère les dirigeants d'un siren depuis le cache ou via l'API RNE.
 * Retourne un array de dirigeants au format LeadBase (prenoms, nom, qualite,
 * fonction, role, email) ou null si rien trouvé.
 *
 * Stratégie :
 *   1. Cache frais (≤ TTL) : retour immédiat.
 *   2. Circuit breaker ouvert : skip API, lecture cache dégradé (TTL 365j).
 *   3. Fetch RNE. Si succès → cache + retour. Si échec → record failure,
 *      lecture cache dégradé en fallback.
 */
async function getDirigeantsForSiren(siren, opts = {}) {
  if (!siren || !/^\d{9}$/.test(String(siren))) return null;
  const sirenStr = String(siren);

  // 1. Cache frais
  if (!opts.skipCache) {
    const cached = await readFromCache(sirenStr);
    if (cached) return cached;
  }

  // 2. Circuit breaker ouvert : bypass API, fallback dégradé direct
  if (_isCircuitOpen()) {
    return await readFromCache(sirenStr, { degraded: true });
  }

  // 3. Fetch RNE avec gestion d'échec → fallback dégradé
  let dirigeants = null;
  let fetchOk = false;
  try {
    dirigeants = await fetchFromRNE(sirenStr);
    fetchOk = dirigeants !== null;
  } catch {
    fetchOk = false;
  }

  if (!fetchOk) {
    _recordFailure();
    return await readFromCache(sirenStr, { degraded: true });
  }

  _recordSuccess();
  await writeToCache(sirenStr, dirigeants);
  return dirigeants;
}

/**
 * Lecture du cache.
 *   - Mode normal (defaut) : refuse les entrées expirées (> CACHE_TTL_DAYS).
 *   - Mode degraded : accepte jusqu'à CACHE_TTL_DEGRADED_DAYS, utilisé en
 *     fallback I-4 quand le primaire RNE est indisponible.
 */
async function readFromCache(siren, opts = {}) {
  const client = getClient();
  if (!client) return null;
  try {
    const entity = await client.getEntity(partitionKeyFor(siren), siren);
    if (opts.degraded) {
      if (isExpiredDegraded(entity.fetchedAt)) return null;
    } else if (isExpired(entity.fetchedAt)) {
      return null;
    }
    if (!entity.dirigeantsJson) return [];
    try {
      return JSON.parse(entity.dirigeantsJson);
    } catch {
      return null;
    }
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) return null;
    return null;
  }
}

async function writeToCache(siren, dirigeants) {
  const client = getClient();
  if (!client) return;
  try {
    await ensureTable(client);
    const entity = {
      partitionKey: partitionKeyFor(siren),
      rowKey: siren,
      siren,
      dirigeantsJson: JSON.stringify(dirigeants || []),
      dirigeantsCount: Array.isArray(dirigeants) ? dirigeants.length : 0,
      fetchedAt: new Date().toISOString(),
      source: 'recherche-entreprises.api.gouv.fr',
    };
    await client.upsertEntity(entity, 'Replace');
  } catch {
    // best effort
  }
}

async function fetchFromRNE(siren) {
  let res;
  try {
    res = await fetch(
      `${RNE_API_BASE}/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }

  const r = (data.results || [])[0];
  if (!r || String(r.siren) !== siren) return [];

  // Filtre : ne garder que les personnes physiques avec prenoms ou nom
  const pp = (r.dirigeants || []).filter(
    (d) => d.type_dirigeant === 'personne physique' && (d.prenoms || d.nom),
  );

  // Mapping vers le format attendu par leadSelector parseFirstDirigeant
  return pp.map((d) => ({
    prenoms: String(d.prenoms || '').trim(),
    nom: String(d.nom || '').trim(),
    qualite: String(d.qualite || '').trim(),
    fonction: String(d.qualite || '').trim(), // alias
    role: String(d.qualite || '').trim(), // alias
    type_dirigeant: 'personne physique',
    annee_de_naissance: d.annee_de_naissance,
  }));
}

/**
 * Enrichit en parallèle un batch d'entités sans dirigeants. Mute en place
 * et retourne le compteur d'entités effectivement enrichies.
 *
 * @param {Array<Object>} entities - rawCandidates LeadBase
 * @param {Object} [opts]
 * @param {number} [opts.concurrency=10] - max parallèle
 */
async function enrichBatchInPlace(entities, opts = {}) {
  if (!Array.isArray(entities) || entities.length === 0) return 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency || 10, 20));
  const toEnrich = entities.filter((e) => {
    if (!e || !e.siren) return false;
    if (!e.dirigeants || e.dirigeants === 'null' || e.dirigeants === '[]') return true;
    try {
      const parsed = JSON.parse(e.dirigeants);
      return !Array.isArray(parsed) || parsed.length === 0;
    } catch {
      return true;
    }
  });

  let enriched = 0;
  for (let i = 0; i < toEnrich.length; i += concurrency) {
    const slice = toEnrich.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async (entity) => {
        const dirigeants = await getDirigeantsForSiren(entity.siren).catch(() => null);
        if (dirigeants && dirigeants.length > 0) {
          entity.dirigeants = JSON.stringify(dirigeants);
          enriched++;
        }
      }),
    );
  }
  return enriched;
}

function _resetForTests() {
  _client = null;
  _resetCircuitForTests();
}

module.exports = {
  getDirigeantsForSiren,
  enrichBatchInPlace,
  _resetForTests,
  _resetCircuitForTests,
  _constants: {
    CACHE_TTL_DAYS,
    CACHE_TTL_DEGRADED_DAYS,
    CIRCUIT_BREAKER_THRESHOLD,
    CIRCUIT_BREAKER_WINDOW_MS,
    CIRCUIT_BREAKER_OPEN_MS,
  },
  _internals: {
    isExpired,
    isExpiredDegraded,
    _isCircuitOpen,
    _recordFailure,
    _recordSuccess,
  },
};
