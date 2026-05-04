'use strict';

/**
 * Compteur quota Brave Search API — Storage Table BraveApiQuota.
 *
 * Schéma :
 *   PartitionKey = '<YYYY-MM>' (mois UTC courant)
 *   RowKey       = 'count'
 *   count        = nombre de requêtes Brave envoyées ce mois-ci
 *
 * Reset implicite par changement de mois (PartitionKey différent → row vide
 * → count = 0 à la première lecture).
 *
 * Cascade connection string :
 *   1. BRAVE_QUOTA_STORAGE_CONNECTION_STRING (KV ref en prod)
 *   2. WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING (mutualisation table cache)
 *   3. AzureWebJobsStorage (fallback)
 *
 * Best effort : si pas de connection string ou storage indisponible, toutes
 * les opérations retournent 0/false sans throw. Le backend Brave continue
 * sans kill-switch (régression vers comportement sans quota tracking).
 *
 * Note race condition : on fait read-then-write non atomique. En mode pilote
 * Lead Selector queue séquentielle, le risque de sous-comptage est marginal
 * (≤ 5 requêtes loupées), bien dans le buffer de 50 entre 950 et 1000.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.SITE_FINDER_BRAVE_QUOTA_TABLE || 'BraveApiQuota';
const ROW_KEY = 'count';

let _client = null;
let _ensured = false;
let _injectedClient = null;

function getClient() {
  if (_injectedClient) return _injectedClient;
  if (_client) return _client;
  const conn = process.env.BRAVE_QUOTA_STORAGE_CONNECTION_STRING
    || process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING
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
      // autre erreur, best effort
    }
  } finally {
    _ensured = true;
  }
}

function getCurrentMonth(now = new Date()) {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

/**
 * Retourne le compteur courant pour le mois en cours. 0 si pas d'entrée
 * (premier appel du mois) ou storage off.
 *
 * @param {Object} [opts]
 * @param {string} [opts.month]   Override mois pour tests (format YYYY-MM)
 * @returns {Promise<number>}
 */
async function getCurrentCount(opts = {}) {
  const client = getClient();
  if (!client) return 0;
  try {
    await ensureTable(client);
  } catch {
    return 0;
  }
  const partitionKey = opts.month || getCurrentMonth();
  try {
    const entity = await client.getEntity(partitionKey, ROW_KEY);
    return Number(entity.count) || 0;
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.code || ''))) {
      return 0;
    }
    return 0; // best effort
  }
}

/**
 * Incrémente le compteur. Best effort — retourne false si storage off ou
 * échec, sans throw.
 *
 * @param {Object} [opts]
 * @param {string} [opts.month]   Override mois pour tests
 * @returns {Promise<boolean>}
 */
async function increment(opts = {}) {
  const client = getClient();
  if (!client) return false;
  try {
    await ensureTable(client);
  } catch {
    return false;
  }
  const partitionKey = opts.month || getCurrentMonth();
  try {
    let current = 0;
    try {
      const entity = await client.getEntity(partitionKey, ROW_KEY);
      current = Number(entity.count) || 0;
    } catch (err) {
      if (!(err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.code || '')))) {
        return false;
      }
    }
    await client.upsertEntity(
      { partitionKey, rowKey: ROW_KEY, count: current + 1 },
      'Merge',
    );
    return true;
  } catch {
    return false;
  }
}

function _setClientForTests(client) {
  _injectedClient = client;
  _ensured = client != null; // skip ensureTable en tests
}

function _resetForTests() {
  _client = null;
  _ensured = false;
  _injectedClient = null;
}

module.exports = {
  getCurrentCount,
  increment,
  getCurrentMonth,
  TABLE_NAME,
  ROW_KEY,
  // Exposés pour tests :
  _setClientForTests,
  _resetForTests,
};
