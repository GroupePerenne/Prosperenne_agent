'use strict';

/**
 * Trace + cache persistant des résolutions email (table Azure `LeadContacts`).
 *
 * Cette table est la source de vérité des résolutions produites par
 * shared/lead-exhauster. Elle sert :
 *   - de cache : re-demande du même (siren, firstName, lastName) → hit direct
 *   - d'audit : chaque résolution conserve ses signaux et son coût
 *   - de rétroaction : le feedback downstream (delivered/bounced/replied)
 *     est écrit via updateFeedback() pour alimenter patterns-learner (Jalon 4)
 *   - de pivot RGPD : purgeBySiren() pour honorer les droits à l'oubli
 *
 * Pattern inspiré de shared/leadSelectorTrace.js : best effort, toute
 * erreur est loggée et swallowée. Si AzureWebJobsStorage est absent, les
 * writers no-op. Les readers retournent null.
 *
 * Schéma complet : voir shared/lead-exhauster/schemas.js typedef LeadContactRow.
 */

const { TableClient } = require('@azure/data-tables');
const { normalizeNamePart } = require('./patterns');
const { TABLE_LEAD_CONTACTS } = require('./schemas');

let _client = null;
let _ensured = false;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_LEAD_CONTACTS);
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
    if (err && (err.statusCode === 409 || /TableAlreadyExists/i.test(err.message || ''))) {
      // déjà là
    }
    // autres erreurs : on continue, le caller gère
  } finally {
    _ensured = true;
  }
}

/**
 * Construit la RowKey d'une résolution. `email_` préfixe stable + normFirst
 * + `_` + normLast. Si first/last vides (résolution catch-all contact@), RowKey
 * devient `email__` — une seule ligne par SIREN pour ce cas.
 */
function buildRowKey(firstName, lastName) {
  const f = normalizeNamePart(firstName) || '';
  const l = normalizeNamePart(lastName) || '';
  return `email_${f}_${l}`;
}

/**
 * Upsert d'une LeadContactRow. Best effort, retourne true/false selon succès.
 *
 * Comportement "upsert replace" (Merge Mode) pour que les re-résolutions
 * écrasent proprement les anciennes valeurs (confidence, signals, source…).
 * Le champ feedbackStatus n'est PAS écrasé par les résolutions — il a sa
 * propre mutation via updateFeedback() (voir plus bas).
 *
 * @param {Object} row
 * @param {string} row.siren
 * @param {string|null} row.email
 * @param {number} row.confidence
 * @param {string} row.source
 * @param {string[]} [row.signals]
 * @param {number} [row.cost_cents]
 * @param {string} [row.firstName]
 * @param {string} [row.lastName]
 * @param {string} [row.role]
 * @param {string} [row.roleSource]
 * @param {number} [row.roleConfidence]
 * @param {string|null} [row.domain]
 * @param {string} [row.domainSource]
 * @param {string[]} [row.experimentsApplied] Array de {experiment_id, variant}
 * @param {string} [row.beneficiaryId]
 * @returns {Promise<boolean>}
 */
async function upsertLeadContact(row = {}) {
  const client = getClient();
  if (!client) return false;
  if (!row.siren || !/^\d{9}$/.test(String(row.siren))) return false;
  try {
    await ensureTable(client);
    const now = new Date().toISOString();
    const entity = {
      partitionKey: String(row.siren),
      rowKey: buildRowKey(row.firstName, row.lastName),
      siren: String(row.siren),
      email: row.email || null,
      confidence: typeof row.confidence === 'number' ? row.confidence : 0,
      source: String(row.source || ''),
      signals: JSON.stringify(Array.isArray(row.signals) ? row.signals : []),
      cost_cents: Number.isFinite(row.cost_cents) ? row.cost_cents : 0,
      firstName: normalizeNamePart(row.firstName) || '',
      lastName: normalizeNamePart(row.lastName) || '',
      role: String(row.role || ''),
      roleSource: String(row.roleSource || ''),
      roleConfidence: typeof row.roleConfidence === 'number' ? row.roleConfidence : 0,
      domain: row.domain || null,
      domainSource: String(row.domainSource || ''),
      resolvedAt: now,
      lastVerifiedAt: now,
      experimentsApplied: JSON.stringify(
        Array.isArray(row.experimentsApplied) ? row.experimentsApplied : [],
      ),
      beneficiaryId: String(row.beneficiaryId || ''),
    };
    // upsertEntity("Merge") : ne touche pas aux colonnes non fournies.
    // Ici on fournit tout, y compris resolvedAt/lastVerifiedAt, donc c'est
    // équivalent à un replace pour les résolutions. Pour updateFeedback(),
    // on utilise un appel séparé qui ne touche pas ces colonnes.
    await client.upsertEntity(entity, 'Merge');
    return true;
  } catch {
    return false;
  }
}

/**
 * Lookup cache pour une paire (siren, firstName, lastName). Retourne la
 * row en clair ou null (pas trouvée / erreur / pas de storage).
 *
 * Le caller applique lui-même la logique TTL (rétention 90 jours après
 * lastVerifiedAt) en comparant au champ `lastVerifiedAt` du retour.
 *
 * @param {Object} q
 * @param {string} q.siren
 * @param {string} [q.firstName]
 * @param {string} [q.lastName]
 * @returns {Promise<Object|null>}
 */
async function readLeadContact(q = {}) {
  const client = getClient();
  if (!client) return null;
  if (!q.siren || !/^\d{9}$/.test(String(q.siren))) return null;
  try {
    const entity = await client.getEntity(String(q.siren), buildRowKey(q.firstName, q.lastName));
    return entity || null;
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
      return null;
    }
    return null;
  }
}

/**
 * Met à jour le feedback d'une ligne LeadContact sans toucher aux champs
 * de résolution (confidence, source, signals, domain…). Utilisé par le
 * hook fire-and-forget `reportFeedback` consommé par runSequence /
 * davidInbox (Jalon 3).
 *
 * @param {Object} p
 * @param {string} p.siren
 * @param {string} [p.firstName]
 * @param {string} [p.lastName]
 * @param {'delivered'|'bounced'|'replied'|'spam_flagged'} p.status
 * @param {string} [p.timestamp]  ISO, défaut now
 * @returns {Promise<boolean>}
 */
async function updateFeedback(p = {}) {
  const client = getClient();
  if (!client) return false;
  if (!p.siren || !/^\d{9}$/.test(String(p.siren))) return false;
  if (!p.status || typeof p.status !== 'string') return false;
  try {
    const entity = {
      partitionKey: String(p.siren),
      rowKey: buildRowKey(p.firstName, p.lastName),
      feedbackStatus: p.status,
      feedbackAt: p.timestamp || new Date().toISOString(),
    };
    // Merge partiel : n'écrase QUE feedbackStatus + feedbackAt.
    await client.updateEntity(entity, 'Merge');
    return true;
  } catch {
    return false;
  }
}

/**
 * Purge RGPD : supprime toutes les résolutions pour un SIREN donné.
 * Utilisé par l'endpoint admin `/api/lead-contacts/purge` (Jalon 3+).
 * Best effort, retourne le nombre de lignes supprimées ou 0 si erreur.
 *
 * @param {string} siren
 * @returns {Promise<number>}
 */
async function purgeBySiren(siren) {
  const client = getClient();
  if (!client) return 0;
  if (!siren || !/^\d{9}$/.test(String(siren))) return 0;
  let count = 0;
  try {
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${String(siren)}'` },
    });
    for await (const e of iterator) {
      try {
        await client.deleteEntity(e.partitionKey, e.rowKey);
        count++;
      } catch {
        // continue on delete failure — best effort
      }
    }
    return count;
  } catch {
    return count;
  }
}

function _resetForTests() {
  _client = null;
  _ensured = false;
}

module.exports = {
  upsertLeadContact,
  readLeadContact,
  updateFeedback,
  purgeBySiren,
  buildRowKey,
  _resetForTests,
};
