'use strict';

/**
 * Factory commune pour les TableClient @azure/data-tables utilisés par les
 * traces et états cross-invocation côté FA David. Best effort : pas de throw
 * si AzureWebJobsStorage absent ou storage indisponible (le caller gère).
 *
 * Pattern identique à shared/leadSelectorTrace.js, factorisé pour les nouvelles
 * tables consultantOnboarding et davidActions (PWA-M Cycle 1).
 */

const { TableClient } = require('@azure/data-tables');

const _clients = new Map();
const _ensured = new Set();

function getTableClient(tableName) {
  if (_clients.has(tableName)) return _clients.get(tableName);
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) {
    _clients.set(tableName, null);
    return null;
  }
  try {
    const client = TableClient.fromConnectionString(conn, tableName);
    _clients.set(tableName, client);
    return client;
  } catch {
    _clients.set(tableName, null);
    return null;
  }
}

async function ensureTable(client, tableName) {
  if (_ensured.has(tableName)) return;
  try {
    await client.createTable();
  } catch (err) {
    if (err && (err.statusCode === 409 || /TableAlreadyExists/i.test(err.message || ''))) {
      // déjà là
    }
  } finally {
    _ensured.add(tableName);
  }
}

function _resetForTests() {
  _clients.clear();
  _ensured.clear();
}

module.exports = { getTableClient, ensureTable, _resetForTests };
