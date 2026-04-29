'use strict';

/**
 * Cache Azure Table `WebsitePatterns` pour les résolutions site-finder.
 *
 * Schéma :
 *   PartitionKey : 'validated' | 'unverified' | 'failed'
 *   RowKey       : <siren> pour 'validated', <siren>_<timestamp> pour les autres
 *                  (permet plusieurs tentatives infructueuses dans la fenêtre TTL).
 *   payload      : JSON.stringify(FindWebsiteOutput)
 *   cachedAt     : ISO timestamp
 *   version      : 'v1'
 *
 * TTL applicatif (pas de cron physique, on filtre à la lecture) :
 *   - validated  : 90 jours par défaut (env SITE_FINDER_CACHE_TTL_VALIDATED_DAYS)
 *   - unverified : 30 jours (env SITE_FINDER_CACHE_TTL_UNVERIFIED_DAYS)
 *   - failed     : 30 jours (idem unverified)
 *
 * Cascade connection string (pattern Sprint 1 leadbase-table) :
 *   1. WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING (KV ref en prod)
 *   2. AzureWebJobsStorage (fallback compat)
 *
 * Best effort : si pas de connection string ou storage indisponible, toutes les
 * opérations retournent null/false sans throw. Le caller bascule en mode
 * "cache off" → appels source systématiques.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.WEBSITE_PATTERNS_TABLE || 'WebsitePatterns';
const CACHE_VERSION = 'v1';
const TTL_VALIDATED_DAYS = Number(process.env.SITE_FINDER_CACHE_TTL_VALIDATED_DAYS || 90);
const TTL_UNVERIFIED_DAYS = Number(process.env.SITE_FINDER_CACHE_TTL_UNVERIFIED_DAYS || 30);

const PARTITION_VALIDATED = 'validated';
const PARTITION_UNVERIFIED = 'unverified';
const PARTITION_FAILED = 'failed';

let _client = null;
let _ensured = false;
let _injectedClient = null;

function getClient() {
  if (_injectedClient) return _injectedClient;
  if (_client) return _client;
  const conn = process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING
    || process.env.AzureWebJobsStorage;
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
    if (!err || (err.statusCode !== 409 && !/TableAlreadyExists/i.test(err.message || ''))) {
      // autre erreur : on ne propage pas, best effort
    }
  } finally {
    _ensured = true;
  }
}

function sanitizeSiren(siren) {
  const s = String(siren || '').trim();
  if (!/^\d{9}$/.test(s)) return null;
  return s;
}

/**
 * Lit l'entrée `validated` la plus récente pour un SIREN. Retourne null si
 * absent, expiré, ou storage off.
 *
 * @param {string} siren
 * @param {Object} [opts]
 * @param {Date}   [opts.now]                Pour tests
 * @param {number} [opts.ttlValidatedDays]   Override TTL validated
 * @returns {Promise<null | Object>}         Le payload (FindWebsiteOutput) restitué
 */
async function get(siren, { now, ttlValidatedDays } = {}) {
  const client = getClient();
  if (!client) return null;
  const sanitized = sanitizeSiren(siren);
  if (!sanitized) return null;

  const nowDate = now instanceof Date ? now : new Date();
  const ttl = Number.isFinite(ttlValidatedDays) ? ttlValidatedDays : TTL_VALIDATED_DAYS;

  try {
    await ensureTable(client);
    const entity = await client.getEntity(PARTITION_VALIDATED, sanitized);
    if (!entity) return null;
    const cachedAt = entity.cachedAt ? new Date(entity.cachedAt) : null;
    if (!cachedAt) return null;
    const ageMs = nowDate.getTime() - cachedAt.getTime();
    if (ageMs > ttl * 86400 * 1000) return null;
    let payload = null;
    try {
      payload = entity.payload ? JSON.parse(entity.payload) : null;
    } catch {
      return null;
    }
    if (!payload) return null;
    return {
      ...payload,
      cachedAt: cachedAt.toISOString(),
    };
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
      return null;
    }
    return null;
  }
}

/**
 * Écrit une résolution validée en cache.
 *
 * @param {string} siren
 * @param {Object} entry — FindWebsiteOutput
 * @param {Object} [opts]
 * @param {Date}   [opts.now]
 * @returns {Promise<boolean>}
 */
async function put(siren, entry, { now } = {}) {
  const client = getClient();
  if (!client) return false;
  const sanitized = sanitizeSiren(siren);
  if (!sanitized || !entry) return false;
  const nowDate = now instanceof Date ? now : new Date();
  try {
    await ensureTable(client);
    await client.upsertEntity(
      {
        partitionKey: PARTITION_VALIDATED,
        rowKey: sanitized,
        payload: JSON.stringify(entry),
        cachedAt: nowDate.toISOString(),
        version: CACHE_VERSION,
      },
      'Replace',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Enregistre une tentative non-validée (failed ou unverified). RowKey inclut
 * le timestamp pour conserver plusieurs tentatives dans la fenêtre TTL.
 *
 * @param {string} siren
 * @param {Object} attempt — FindWebsiteOutput (siteUrl peut être null)
 * @param {Object} [opts]
 * @param {Date}   [opts.now]
 * @param {string} [opts.partition]   'failed' (défaut) ou 'unverified'
 * @returns {Promise<boolean>}
 */
async function recordFailure(siren, attempt, { now, partition } = {}) {
  const client = getClient();
  if (!client) return false;
  const sanitized = sanitizeSiren(siren);
  if (!sanitized) return false;
  const nowDate = now instanceof Date ? now : new Date();
  const part = partition === PARTITION_UNVERIFIED ? PARTITION_UNVERIFIED : PARTITION_FAILED;
  const rowKey = `${sanitized}_${nowDate.getTime()}`;
  try {
    await ensureTable(client);
    await client.upsertEntity(
      {
        partitionKey: part,
        rowKey,
        payload: JSON.stringify(attempt || {}),
        cachedAt: nowDate.toISOString(),
        version: CACHE_VERSION,
      },
      'Replace',
    );
    return true;
  } catch {
    return false;
  }
}

function _setClientForTests(client) {
  _injectedClient = client;
  _ensured = false;
}

function _resetForTests() {
  _client = null;
  _ensured = false;
  _injectedClient = null;
}

module.exports = {
  get,
  put,
  recordFailure,
  TABLE_NAME,
  CACHE_VERSION,
  // Exposés pour tests :
  _setClientForTests,
  _resetForTests,
  _internals: {
    PARTITION_VALIDATED,
    PARTITION_UNVERIFIED,
    PARTITION_FAILED,
    TTL_VALIDATED_DAYS,
    TTL_UNVERIFIED_DAYS,
  },
};
