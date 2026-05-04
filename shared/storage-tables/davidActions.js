'use strict';

/**
 * Timeline des actions opérationnelles David — append-only, 1 row par action.
 * Couvre BL-41 (escalations + bounces + opt_outs jamais trackés en table dédiée
 * jusqu'au 4 mai 2026).
 *
 * Schéma :
 *   PartitionKey : consultantEmail lowercase  (filtre par consultant rapide)
 *   RowKey       : (9999... - timestamp ms).padded + ':' + actionType + ':' + rand
 *                  (RowKey antichronologique ordonné côté listEntities)
 *   type         : 'daily_brief_sent' | 'reply_classified' | 'escalation_sent'
 *                  | 'bounce_received' | 'opt_out_recorded' | 'onboarding_sent'
 *                  | 'onboarding_completed'
 *   summary      : libellé court (1 ligne) pour timeline UI
 *   metadata     : JSON stringifié (champs spécifiques à l'action)
 *   actorAgent   : 'david' (futur : 'martin' / 'mila' si on étend)
 *   at           : ISO datetime de l'action
 *
 * Best effort. Pas de throw côté caller.
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.DAVID_ACTIONS_TABLE || 'davidActions';

const KNOWN_TYPES = new Set([
  'daily_brief_sent',
  'reply_classified',
  'escalation_sent',
  'bounce_received',
  'opt_out_recorded',
  'onboarding_sent',
  'onboarding_completed',
]);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function rowKey(actionType, at) {
  const ts = at instanceof Date ? at.getTime() : Date.parse(at) || Date.now();
  const inverted = (9999999999999 - ts).toString().padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${inverted}:${actionType}:${rand}`;
}

/**
 * Enregistre une action David. Best effort.
 *
 * @param {Object} action
 * @param {string} action.consultantEmail   email consultant concerné (PK)
 * @param {string} action.type              cf. KNOWN_TYPES
 * @param {string} [action.summary]
 * @param {Object} [action.metadata]
 * @param {string} [action.at]              ISO datetime, default now
 * @param {string} [action.actorAgent]      default 'david'
 */
async function recordAction(action = {}) {
  const consultantEmail = normalizeEmail(action.consultantEmail);
  const type = String(action.type || '').slice(0, 64);
  if (!consultantEmail || !type) return null;

  const client = getTableClient(TABLE_NAME);
  if (!client) return null;

  const at = action.at || new Date().toISOString();
  const entity = {
    partitionKey: consultantEmail,
    rowKey: rowKey(type, at),
    type,
    summary: String(action.summary || '').slice(0, 1024),
    metadata: action.metadata ? JSON.stringify(action.metadata).slice(0, 32000) : '',
    actorAgent: action.actorAgent || 'david',
    at,
    knownType: KNOWN_TYPES.has(type),
  };

  try {
    await ensureTable(client, TABLE_NAME);
    await client.createEntity(entity);
    return entity;
  } catch {
    return null;
  }
}

/**
 * Liste les actions d'un consultant, antichronologique (RowKey naturel).
 *
 * @param {string} consultantEmail
 * @param {Object} [opts]
 * @param {number} [opts.limit=200]
 */
async function listActionsByConsultant(consultantEmail, opts = {}) {
  const email = normalizeEmail(consultantEmail);
  if (!email) return [];
  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;

  const client = getTableClient(TABLE_NAME);
  if (!client) return [];

  try {
    await ensureTable(client, TABLE_NAME);
    const out = [];
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${email}'` },
    });
    for await (const e of iterator) {
      out.push(_serialize(e));
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

function _serialize(entity) {
  let parsedMetadata = null;
  if (entity.metadata) {
    try {
      parsedMetadata = JSON.parse(entity.metadata);
    } catch {
      parsedMetadata = entity.metadata;
    }
  }
  return {
    consultantEmail: entity.partitionKey,
    type: entity.type,
    summary: entity.summary || '',
    metadata: parsedMetadata,
    actorAgent: entity.actorAgent || 'david',
    at: entity.at || '',
  };
}

module.exports = {
  recordAction,
  listActionsByConsultant,
  KNOWN_TYPES,
};
