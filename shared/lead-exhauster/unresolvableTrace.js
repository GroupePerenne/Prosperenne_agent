'use strict';

/**
 * Writer Azure Table `EmailUnresolvable` — file des prospects non résolus.
 *
 * Schéma (schemas.js) :
 *   PartitionKey : beneficiaryId
 *   RowKey       : `{reverseTimestamp}_{siren}` — antichronologique naturel
 *   Champs       : siren, reason, signalsExhausted (JSON), lastAttemptedAt,
 *                  firstName, lastName, companyName
 *
 * Consommée par Charli pour review manuelle ou retry différé. Best effort
 * d'écriture : aucune erreur n'est propagée au caller.
 */

const { TableClient } = require('@azure/data-tables');
const { TABLE_EMAIL_UNRESOLVABLE } = require('./schemas');

let _client = null;
let _ensured = false;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_EMAIL_UNRESOLVABLE);
    return _client;
  } catch {
    return null;
  }
}

async function ensureTable(client) {
  if (_ensured) return;
  try {
    await client.createTable();
  } catch {
    // already exists or other error — swallow
  } finally {
    _ensured = true;
  }
}

function rowKey() {
  const ts = Date.now();
  const reverse = (9999999999999 - ts).toString().padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${reverse}_${rand}`;
}

/**
 * Enregistre un prospect unresolvable.
 *
 * @param {Object} row
 * @param {string} row.beneficiaryId
 * @param {string} row.siren
 * @param {string} [row.reason]
 * @param {string[]} [row.signalsExhausted]
 * @param {string} [row.firstName]
 * @param {string} [row.lastName]
 * @param {string} [row.companyName]
 * @returns {Promise<boolean>}
 */
async function recordUnresolvable(row = {}) {
  const client = getClient();
  if (!client) return false;
  if (!row.beneficiaryId || !row.siren) return false;
  try {
    await ensureTable(client);
    await client.createEntity({
      partitionKey: String(row.beneficiaryId),
      rowKey: `${rowKey()}_${row.siren}`,
      siren: String(row.siren),
      reason: String(row.reason || 'unresolvable'),
      signalsExhausted: JSON.stringify(Array.isArray(row.signalsExhausted) ? row.signalsExhausted : []),
      lastAttemptedAt: new Date().toISOString(),
      firstName: String(row.firstName || ''),
      lastName: String(row.lastName || ''),
      companyName: String(row.companyName || ''),
    });
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
  recordUnresolvable,
  _resetForTests,
};
