'use strict';

/**
 * Kill-switch distant pour workers locaux (AirWorker, futurs Mac Pro / autres
 * postes). Lecture d'un flag Storage Table à chaque itération du worker —
 * si flag actif, le worker entre en pause au lieu de continuer son cycle.
 *
 * Contexte (BL-43 résiduel + incident 9 mai 2026) :
 *   AirWorker tourne en LaunchAgent macOS sur Mac Air dédié, IP locale
 *   192.168.1.128. Quand Paul est hors LAN bureau (weekend, déplacements),
 *   il n'a aucun moyen de stopper AirWorker à distance (pas de SSH, Tailscale
 *   et ZeroTier incompatibles macOS 26.3). Le 9 mai matin, AirWorker en
 *   ban Google a continué à hammer pendant 13h sans qu'on puisse couper,
 *   prolongeant le ban. Paul a dû rentrer au bureau samedi pour
 *   `launchctl unload` manuellement.
 *
 *   Cf. mémoire feedback_kill_switch_distant_workers_locaux.md.
 *
 * Mécanisme :
 *   - Storage Table `WorkersControl`
 *   - PartitionKey : 'control'
 *   - RowKey      : `kill-{workerId}` (ex: 'kill-airworker')
 *   - killed      : boolean (true = pause demandée)
 *   - updatedAt   : ISO datetime
 *   - updatedBy   : qui a posé/levé le flag (charli, paul, system...)
 *   - reason      : raison optionnelle (texte court)
 *
 *   Le worker lit ce flag à chaque itération de sa boucle principale.
 *   Si killed=true, il SLEEP au lieu de cycle (pas d'exit pour ne pas
 *   déclencher LaunchAgent restart). Au prochain check, si killed=false,
 *   il reprend son cycle normal.
 *
 *   Activation distante :
 *     az storage entity merge --table-name WorkersControl --connection-string $CS \
 *       --entity PartitionKey=control RowKey=kill-airworker \
 *       killed=true updatedBy=charli reason="diag prod 11 mai"
 *
 *   Désactivation :
 *     idem avec killed=false
 *
 * Mode dégradé :
 *   Si storage indisponible (AzureWebJobsStorage absent, throttle, etc.),
 *   isWorkerKilled retourne false (le worker continue) — préférable à un
 *   blocage. Le worker peut être stoppé "à l'ancienne" via SIGTERM
 *   (launchctl unload, kill) en mode dégradé.
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.WORKERS_CONTROL_TABLE || 'WorkersControl';

function makeKillKey(workerId) {
  return `kill-${String(workerId || '').trim().toLowerCase()}`;
}

/**
 * Vérifie si un worker est en mode pause (kill-switch activé).
 *
 * Best effort : retourne false en cas d'erreur storage (le worker continue
 * son cycle plutôt que de s'arrêter sur un faux positif).
 *
 * @param {string} workerId  Identifiant du worker (ex: 'airworker')
 * @returns {Promise<boolean>}
 */
async function isWorkerKilled(workerId) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return false;
  const rowKey = makeKillKey(workerId);
  try {
    const entity = await client.getEntity('control', rowKey);
    return entity.killed === true || entity.killed === 'true';
  } catch (err) {
    if (err && err.statusCode === 404) return false;
    return false;
  }
}

/**
 * Pose ou lève le kill-switch d'un worker. Utilisé par Charli en remote ops
 * ou par un opérateur humain (Paul/Constantin) via az CLI / PWA dashboard.
 *
 * @param {Object} args
 * @param {string} args.workerId
 * @param {boolean} args.killed
 * @param {string} [args.updatedBy]
 * @param {string} [args.reason]
 */
async function setWorkerKilled({ workerId, killed, updatedBy, reason }) {
  const client = getTableClient(TABLE_NAME);
  if (!client) throw new Error('Storage indisponible — impossible de set kill-switch');
  await ensureTable(client, TABLE_NAME);
  const rowKey = makeKillKey(workerId);
  await client.upsertEntity({
    partitionKey: 'control',
    rowKey,
    killed: Boolean(killed),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'unknown'),
    reason: reason ? String(reason).slice(0, 500) : null,
  }, 'Replace');
  return { workerId, killed, rowKey };
}

/**
 * Lit l'état complet du flag (utile pour observabilité / digest / PWA).
 */
async function getWorkerControlState(workerId) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return null;
  const rowKey = makeKillKey(workerId);
  try {
    return await client.getEntity('control', rowKey);
  } catch (err) {
    if (err && err.statusCode === 404) return null;
    return null;
  }
}

module.exports = {
  isWorkerKilled,
  setWorkerKilled,
  getWorkerControlState,
  makeKillKey,
  _TABLE_NAME: TABLE_NAME,
};
