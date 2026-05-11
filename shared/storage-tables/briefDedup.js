'use strict';

/**
 * Dédup atomique des briefs consultants soumis via onQualification.
 *
 * Contexte (BL-52 incident 11 mai 2026, cofacteur BUG #2 audit) :
 *   POST /api/onQualification n'a aucune protection contre les soumissions
 *   dupliquées (double-clic formulaire, retry réseau client, replay HTTP).
 *   Deux briefs identiques → deux jobs queue → cascade de doublons en aval.
 *
 * Mécanisme :
 *   Header HTTP `Idempotency-Key` (RFC 7807 inspired) optionnel côté client.
 *   À défaut, on calcule un hash déterministe de (consultantId, briefId payload).
 *   Avant de poster le job queue, on tente createEntity. 409 → replay, return
 *   le résultat précédemment enregistré.
 *
 * Schéma :
 *   PartitionKey : 'brief'
 *   RowKey       : idempKey (16 chars min)
 *   consultantId : email lowercase
 *   submittedAt  : ISO datetime
 *   jobId        : ID du job queue posté (pour traçabilité)
 *   responseSnapshot : JSON.stringify de la réponse renvoyée au client (pour replay)
 *
 * TTL :
 *   Pas de TTL automatique côté Azure Table. Les replays valides sont rares ;
 *   on accepte que la table grossisse. Une purge mensuelle est envisageable
 *   ultérieurement si volume excessif.
 */

const crypto = require('node:crypto');
const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.BRIEF_DEDUP_TABLE || 'BriefDedup';
const MIN_KEY_LENGTH = 8;

/**
 * Calcule une clé d'idempotence déterministe pour un brief.
 * Si le client fournit `Idempotency-Key` (header), on l'utilise (sanitized).
 * Sinon fallback : sha256(consultantId + briefId + sentAt).slice(0,32)
 */
function computeIdempotencyKey({ headerKey, consultantId, briefId, sentAt }) {
  if (headerKey && typeof headerKey === 'string') {
    const sanitized = headerKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (sanitized.length >= MIN_KEY_LENGTH) return sanitized;
  }
  const seed = `${String(consultantId || '').toLowerCase()}|${String(briefId || '')}|${String(sentAt || '')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/**
 * Tente de réserver un brief pour traitement.
 * Retourne :
 *   { acquired: true, idempKey } si nouveau brief
 *   { acquired: false, replay: true, snapshot } si déjà traité (replay détecté)
 *   { acquired: true, reason: 'no_storage' } si storage indisponible (degraded)
 */
async function tryReserveBrief({ headerKey, consultantId, briefId, sentAt, jobId }) {
  const client = getTableClient(TABLE_NAME);
  const idempKey = computeIdempotencyKey({ headerKey, consultantId, briefId, sentAt });

  if (!client) {
    return { acquired: true, reason: 'no_storage_fallback', idempKey };
  }
  await ensureTable(client, TABLE_NAME);

  try {
    await client.createEntity({
      partitionKey: 'brief',
      rowKey: idempKey,
      consultantId: String(consultantId || ''),
      briefId: String(briefId || ''),
      submittedAt: new Date().toISOString(),
      jobId: String(jobId || ''),
      responseSnapshot: null,
    });
    return { acquired: true, idempKey };
  } catch (err) {
    if (err && err.statusCode === 409) {
      // Replay détecté — récupère le snapshot pour le renvoyer au client
      try {
        const existing = await client.getEntity('brief', idempKey);
        let snapshot = null;
        try {
          snapshot = existing.responseSnapshot ? JSON.parse(existing.responseSnapshot) : null;
        } catch {
          snapshot = null;
        }
        return {
          acquired: false,
          replay: true,
          idempKey,
          snapshot,
          originalSubmittedAt: existing.submittedAt,
          originalJobId: existing.jobId,
        };
      } catch {
        return { acquired: false, replay: true, idempKey, snapshot: null };
      }
    }
    // Erreur réseau / autre — fallback dégradé : on autorise
    return { acquired: true, reason: 'storage_error_fallback', idempKey, error: err.message };
  }
}

/**
 * Stocke le snapshot de réponse pour qu'un replay puisse la restituer.
 * Best effort, ne throw pas.
 */
async function recordResponseSnapshot({ idempKey, snapshot }) {
  const client = getTableClient(TABLE_NAME);
  if (!client || !idempKey) return;
  try {
    await client.updateEntity({
      partitionKey: 'brief',
      rowKey: idempKey,
      responseSnapshot: JSON.stringify(snapshot || {}).slice(0, 32 * 1024),
    }, 'Merge');
  } catch {
    // Best effort
  }
}

module.exports = {
  tryReserveBrief,
  recordResponseSnapshot,
  computeIdempotencyKey,
  _TABLE_NAME: TABLE_NAME,
};
