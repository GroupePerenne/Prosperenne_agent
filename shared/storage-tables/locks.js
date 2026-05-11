'use strict';

/**
 * Mutex distribué léger via Azure Storage Table.
 *
 * Contexte (BL-52 incident 11 mai 2026, root cause TOCTOU race) :
 *   resolveOrCreateDeal() lit Pipedrive ("findOpenDealsForPersonInOurPipe"),
 *   décide de créer un deal, puis appelle Pipedrive createDeal. Entre les deux,
 *   un handler concurrent peut faire la même séquence et créer un 2e deal pour
 *   la même personne. La latence d'indexation Pipedrive (200-500ms) garantit
 *   que les deux handlers concurrents voient "0 deals" et créent chacun un deal.
 *
 * Pattern :
 *   Avant Pipedrive createDeal, acquérir un lease atomique sur la personne via
 *   createEntity (409 si déjà tenu). Le détenteur du lease re-checke
 *   findOpenDeals (atomique sous lock) puis crée ou réutilise. À la fin, libère
 *   le lease via deleteEntity.
 *
 * Atomicité :
 *   Azure Storage Table garantit que createEntity sur une PartitionKey+RowKey
 *   donnée échoue avec 409 Conflict si l'entité existe déjà. C'est la primitive
 *   atomique sur laquelle on construit le mutex.
 *
 * TTL stale :
 *   Un lease plus vieux que LOCK_STALE_MS est considéré abandonné (handler
 *   crashé sans cleanup), et un nouveau handler peut le récupérer via Replace.
 *
 * Schéma :
 *   PartitionKey : 'lock'
 *   RowKey       : `{namespace}-{key}` (ex: 'person-53802', 'brief-job-1778...')
 *   acquiredAt   : ISO datetime
 *   holder       : identifiant du process / job qui détient le lock
 *   namespace    : libellé pour observabilité
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.LOCKS_TABLE || 'DistributedLocks';
const LOCK_STALE_MS = Number(process.env.LOCK_STALE_MS || 5 * 60 * 1000);

function makeLockKey(namespace, key) {
  return `${String(namespace || '').trim()}-${String(key || '').trim()}`.slice(0, 250);
}

/**
 * Tente d'acquérir un lock. Retourne { acquired, lockKey, reclaimed? }.
 * Si non acquis et `waitMs > 0`, retry une fois après attente.
 *
 * Best effort fallback : si storage indisponible, retourne acquired=true
 * avec reason='no_storage' — on accepte de perdre la protection plutôt que
 * de bloquer le pipeline. Le caller doit traiter ça comme degraded mode.
 */
async function tryAcquireLock({ namespace, key, holder, waitMs = 0 }) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return { acquired: true, reason: 'no_storage_fallback', lockKey: makeLockKey(namespace, key) };
  await ensureTable(client, TABLE_NAME);

  const rowKey = makeLockKey(namespace, key);
  const now = new Date().toISOString();
  const tryOnce = async () => {
    try {
      await client.createEntity({
        partitionKey: 'lock',
        rowKey,
        acquiredAt: now,
        holder: String(holder || 'unknown'),
        namespace: String(namespace || ''),
      });
      return { acquired: true, lockKey: rowKey };
    } catch (err) {
      if (err && err.statusCode === 409) {
        // Lock déjà tenu — check stale
        try {
          const existing = await client.getEntity('lock', rowKey);
          const acquiredMs = Date.parse(existing.acquiredAt || '');
          const ageMs = Date.now() - acquiredMs;
          if (Number.isFinite(acquiredMs) && ageMs > LOCK_STALE_MS) {
            // Stale → take over via Replace (atomique via ETag)
            try {
              await client.updateEntity({
                partitionKey: 'lock',
                rowKey,
                acquiredAt: now,
                holder: String(holder || 'unknown'),
                namespace: String(namespace || ''),
                reclaimedFromHolder: existing.holder,
                staleAgeMs: ageMs,
              }, 'Replace', { etag: existing.etag });
              return { acquired: true, lockKey: rowKey, reclaimed: true };
            } catch (replaceErr) {
              if (replaceErr && replaceErr.statusCode === 412) {
                // ETag conflict — un autre handler a réussi à le reclaim
                return { acquired: false, reason: 'reclaim_etag_conflict', lockKey: rowKey };
              }
              throw replaceErr;
            }
          }
          return { acquired: false, reason: 'held_by_other', heldBy: existing.holder, lockKey: rowKey };
        } catch {
          return { acquired: false, reason: 'race_check_failed', lockKey: rowKey };
        }
      }
      // Erreur réseau / autre — fallback dégradé : on autorise
      return { acquired: true, reason: 'storage_error_fallback', lockKey: rowKey, error: err.message };
    }
  };

  const first = await tryOnce();
  if (first.acquired || waitMs <= 0) return first;
  await new Promise((r) => setTimeout(r, waitMs));
  return tryOnce();
}

/**
 * Libère un lock détenu. Best effort, ne throw pas.
 */
async function releaseLock(lockKey) {
  const client = getTableClient(TABLE_NAME);
  if (!client || !lockKey) return;
  try {
    await client.deleteEntity('lock', lockKey);
  } catch {
    // Best effort
  }
}

/**
 * Helper d'usage typique : exécute fn() sous lock, release garanti même en throw.
 *
 *   const result = await withLock({ namespace: 'person', key: personId, holder }, async () => {
 *     // section critique
 *   });
 *
 * Si le lock n'est pas acquis (held_by_other non stale), throw `LockHeldError`.
 */
class LockHeldError extends Error {
  constructor(reason, lockKey) {
    super(`Lock held: ${reason} on ${lockKey}`);
    this.name = 'LockHeldError';
    this.reason = reason;
    this.lockKey = lockKey;
  }
}

async function withLock({ namespace, key, holder, waitMs = 500 }, fn) {
  const lock = await tryAcquireLock({ namespace, key, holder, waitMs });
  if (!lock.acquired) {
    throw new LockHeldError(lock.reason, lock.lockKey);
  }
  try {
    return await fn(lock);
  } finally {
    await releaseLock(lock.lockKey);
  }
}

module.exports = {
  tryAcquireLock,
  releaseLock,
  withLock,
  makeLockKey,
  LockHeldError,
  _LOCK_STALE_MS: LOCK_STALE_MS,
  _TABLE_NAME: TABLE_NAME,
};
