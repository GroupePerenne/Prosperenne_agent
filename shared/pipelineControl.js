'use strict';

/**
 * Kill-switch FA pipeline David — lecture rapide table Storage `PipelineControl`.
 *
 * Permet à un opérateur (Paul, Charli, COMEX) de pauser INSTANTANÉMENT
 * l'envoi de mails en posant une entité :
 *
 *   PartitionKey : 'control'
 *   RowKey       : 'kill-pipeline'
 *   killed       : true|false
 *   killUntil    : ISO (optionnel — si présent et future, kill actif jusqu'à
 *                  cette date ; si absent et killed=true, kill permanent
 *                  jusqu'à update manuel)
 *   reason       : string (audit)
 *   updatedAt    : ISO
 *
 * Stratégie cache : TTL 5s côté process pour éviter de saturer Storage à
 * chaque envoi de mail (le scheduler peut tirer 30+ mails/min). 5s est un
 * compromis acceptable entre réactivité (pause prend effet en <5s côté
 * tous les processes) et coût Storage.
 *
 * Graceful degradation : si Storage indisponible, retourne false (le
 * pipeline continue de tourner). Discipline : un kill-switch ne doit
 * JAMAIS bloquer le pipeline par défaut — sinon une panne Storage =
 * pause sauvage du business. Le kill doit être EXPLICITE.
 *
 * Plan v3.1 Pilier 1 — kill-switch FA rapide.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.PIPELINE_CONTROL_TABLE || 'PipelineControl';
const CACHE_TTL_MS = 5_000;

let _client = null;
let _cache = { value: null, fetchedAt: 0 };

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

function _resetForTests() {
  _client = null;
  _cache = { value: null, fetchedAt: 0 };
}

/**
 * Override pour tests : injecte un client Storage mocké et reset le cache.
 * @param {Object} client TableClient-compatible { getEntity }
 */
function _setClientForTests(client) {
  _client = client;
  _cache = { value: null, fetchedAt: 0 };
}

/**
 * Retourne true si le kill-switch est actif (pipeline en pause).
 *
 * Stratégie :
 *   - Cache TTL 5s : si lecture récente, retourne cache
 *   - Lecture table Storage PK='control' RK='kill-pipeline'
 *   - Si entity absente → false (default: pipeline vivant)
 *   - Si entity.killed !== true → false
 *   - Si entity.killUntil présent → comparer à now
 *     - killUntil <= now → kill expiré → false
 *     - killUntil > now → kill actif → true
 *   - Si entity.killed === true et pas de killUntil → kill permanent → true
 *
 * Graceful degradation : Storage indisponible → false (défaut "vie").
 *
 * @param {Object} [opts]
 * @param {Date} [opts.now]            Pour tests
 * @param {number} [opts.cacheTtlMs]   Override TTL pour tests
 * @returns {Promise<boolean>}
 */
async function isPipelineKilled(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ttl = Number.isFinite(opts.cacheTtlMs) ? opts.cacheTtlMs : CACHE_TTL_MS;

  if (_cache.fetchedAt > 0 && now.getTime() - _cache.fetchedAt < ttl) {
    return _cache.value === true;
  }

  const client = getClient();
  if (!client) {
    _cache = { value: false, fetchedAt: now.getTime() };
    return false;
  }

  let entity = null;
  try {
    entity = await client.getEntity('control', 'kill-pipeline');
  } catch (err) {
    // 404 = pas de kill-switch posé = pipeline vivant. Autres erreurs
    // (5xx, throttle) = graceful, retourne false par défaut.
    _cache = { value: false, fetchedAt: now.getTime() };
    return false;
  }

  if (!entity || entity.killed !== true) {
    _cache = { value: false, fetchedAt: now.getTime() };
    return false;
  }

  // killUntil optionnel : si présent, le kill expire automatiquement
  if (entity.killUntil) {
    const until = new Date(entity.killUntil);
    if (!Number.isNaN(until.getTime()) && until <= now) {
      _cache = { value: false, fetchedAt: now.getTime() };
      return false;
    }
  }

  _cache = { value: true, fetchedAt: now.getTime() };
  return true;
}

/**
 * Retourne le détail courant du kill-switch (utilitaire pour log + audit).
 * Ne s'appuie pas sur le cache : lecture directe Storage.
 *
 * @returns {Promise<{killed:boolean, killUntil?:string, reason?:string, updatedAt?:string} | null>}
 */
async function getPipelineControlSnapshot() {
  const client = getClient();
  if (!client) return null;
  try {
    const entity = await client.getEntity('control', 'kill-pipeline');
    return {
      killed: entity.killed === true,
      killUntil: entity.killUntil || null,
      reason: entity.reason || null,
      updatedAt: entity.updatedAt || null,
    };
  } catch {
    return null;
  }
}

module.exports = {
  isPipelineKilled,
  getPipelineControlSnapshot,
  TABLE_NAME,
  CACHE_TTL_MS,
  _resetForTests,
  _setClientForTests,
};
