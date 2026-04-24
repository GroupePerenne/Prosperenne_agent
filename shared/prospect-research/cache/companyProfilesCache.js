'use strict';

/**
 * Cache Azure Table `ProspectCompanyProfiles`.
 *
 * Stocke la fiche entreprise produite par la couche A du prospect-profiler,
 * clé (siren, weekYear). TTL logique 30 jours : un get() ne retourne le cache
 * que si profiledAt > now - 30j. Aucun TTL physique (pas de cron de purge
 * en V0 — volume faible et Azure Table gratuit).
 *
 * Schéma :
 *   PartitionKey : siren (string)
 *   RowKey       : weekYear (ex. "2026-W17")
 *   profile      : JSON stringifié du companyProfile
 *   profiledAt   : ISO timestamp
 *   version      : "v0"
 *
 * Best effort : si AzureWebJobsStorage n'est pas configuré ou que le storage
 * est indisponible, toutes les opérations retournent null / false sans throw.
 * Le caller bascule en "cache off" (appels sources systématiques).
 *
 * Utilisation V0 : get avant appel sources, set après succès couche A.
 * Migration Postgres prévue sem 18 avec Mem0 self-hosted (cf. CLAUDE_PROFILER §7).
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.PROSPECT_COMPANY_PROFILES_TABLE || 'ProspectCompanyProfiles';
const TTL_DAYS = Number(process.env.PROSPECT_PROFILE_CACHE_TTL_DAYS || 30);
const CACHE_VERSION = 'v0';

let _client = null;
let _ensured = false;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_NAME);
    return _client;
  } catch {
    return null;
  }
}

async function ensureTable(client) {
  if (_ensured) return;
  try {
    await client.createTable();
  } catch (err) {
    // 409 TableAlreadyExists est le cas normal après le 1er appel
    if (!err || (err.statusCode !== 409 && !/TableAlreadyExists/i.test(err.message || ''))) {
      // autre erreur : on ne propage pas, best effort
    }
  } finally {
    _ensured = true;
  }
}

/**
 * Retourne la numérotation ISO 8601 "YYYY-Www" pour une date donnée.
 * Semaine 1 = celle contenant le 1er jeudi de l'année.
 */
function isoWeekYear(d = new Date()) {
  // Algorithme standard ISO 8601
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function sanitizeSiren(siren) {
  const s = String(siren || '').trim();
  if (!/^\d{9}$/.test(s)) throw new Error(`invalid siren: ${siren}`);
  return s;
}

/**
 * Lit un profil en cache. Retourne null si absent, expiré, ou storage off.
 *
 * @param {string} siren
 * @param {object} [opts]
 * @param {Date}   [opts.now]      Pour tests
 * @param {number} [opts.ttlDays]  Override TTL (défaut PROSPECT_PROFILE_CACHE_TTL_DAYS)
 * @returns {Promise<null|{profile, profiledAt, weekYear}>}
 */
async function getCachedCompanyProfile(siren, { now, ttlDays } = {}) {
  const client = getClient();
  if (!client) return null;
  let sanitized;
  try {
    sanitized = sanitizeSiren(siren);
  } catch {
    return null;
  }
  const nowDate = now instanceof Date ? now : new Date();
  const weekYear = isoWeekYear(nowDate);
  const ttl = Number.isFinite(ttlDays) ? ttlDays : TTL_DAYS;

  try {
    await ensureTable(client);
    const entity = await client.getEntity(sanitized, weekYear);
    if (!entity) return null;
    const profiledAt = entity.profiledAt ? new Date(entity.profiledAt) : null;
    if (!profiledAt) return null;
    const ageMs = nowDate.getTime() - profiledAt.getTime();
    if (ageMs > ttl * 86400 * 1000) return null;
    let profile = null;
    try {
      profile = entity.profile ? JSON.parse(entity.profile) : null;
    } catch {
      return null;
    }
    if (!profile) return null;
    return {
      profile,
      profiledAt: profiledAt.toISOString(),
      weekYear,
      version: entity.version || CACHE_VERSION,
    };
  } catch (err) {
    // 404 ResourceNotFound : cache miss normal
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
      return null;
    }
    // autre erreur : dégradation silencieuse
    return null;
  }
}

/**
 * Écrit un profil en cache. Retourne true si ok, false sinon.
 *
 * @param {string} siren
 * @param {object} profile       Payload companyProfile (sera JSON.stringify)
 * @param {object} [opts]
 * @param {Date}   [opts.now]    Pour tests
 */
async function setCachedCompanyProfile(siren, profile, { now } = {}) {
  const client = getClient();
  if (!client) return false;
  let sanitized;
  try {
    sanitized = sanitizeSiren(siren);
  } catch {
    return false;
  }
  if (!profile) return false;
  const nowDate = now instanceof Date ? now : new Date();
  const weekYear = isoWeekYear(nowDate);
  try {
    await ensureTable(client);
    await client.upsertEntity(
      {
        partitionKey: sanitized,
        rowKey: weekYear,
        profile: JSON.stringify(profile),
        profiledAt: nowDate.toISOString(),
        version: CACHE_VERSION,
      },
      'Replace',
    );
    return true;
  } catch {
    return false;
  }
}

function _resetForTests() {
  _client = null;
  _ensured = false;
}

module.exports = {
  getCachedCompanyProfile,
  setCachedCompanyProfile,
  isoWeekYear,
  TABLE_NAME,
  CACHE_VERSION,
  _resetForTests,
};
