'use strict';

/**
 * Writer LeadBase pour les résultats site-finder.
 *
 * Sprint 1 a confirmé que `shared/adapters/leadbase/leadbase-table.js` est
 * read-only (Constantin maintient les écritures via son propre tooling).
 * Pour Sprint 2 site-finder, on a besoin d'écrire des champs supplémentaires
 * sur l'entité existante (siteWeb, siteWebConfidence, etc.). On le fait via
 * un TableClient direct, instancié localement, en mode `Merge` (patch
 * partiel — préserve les autres champs maintenus par Constantin).
 *
 * **Le adapter leadbase-table.js n'est volontairement pas modifié** :
 * exposer une write-API là-bas serait une refonte de scope qui couplerait
 * le pipeline aux opérations de Constantin. Le writer site-finder reste
 * isolé, son périmètre clair (5 champs siteWeb*).
 *
 * Cascade connection string (pattern Sprint 1) :
 *   1. WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING (au cas où le cache et
 *      LeadBase vivent dans le même storage account, cf. réalité prod)
 *   2. LEADBASE_STORAGE_CONNECTION_STRING (KV ref Sprint 1 dédiée)
 *   3. AzureWebJobsStorage (compat historique)
 *
 * partitionKey : pris du candidate (qui le porte depuis Sprint 2 via
 * l'extension de extractCandidateFromEntity dans shared/leadSelector.js).
 * Si absent, on tente un lookup par RowKey via query filter — coût d'un
 * round-trip, acceptable parce qu'on est déjà dans une cascade lente.
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.LEADBASE_TABLE || 'LeadBase';
const WRITER_VERSION = 'v1';

let _client = null;
let _injectedClient = null;

function _getClient() {
  if (_injectedClient) return _injectedClient;
  if (_client) return _client;
  const conn = process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING
    || process.env.LEADBASE_STORAGE_CONNECTION_STRING
    || process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_NAME);
    return _client;
  } catch {
    return null;
  }
}

/**
 * Écrit le résultat site-finder sur l'entité LeadBase identifiée par `siren`.
 *
 * Champs écrits (Merge, donc les autres champs ne bougent pas) :
 *   - siteWeb              : URL canonique (ou null si rejet)
 *   - siteWebConfidence    : 0-1
 *   - siteWebSource        : 'api_gouv' | 'websearch_*' | 'cache' | null
 *   - siteWebProofType     : 'siren_match' | 'weak_signals' | 'siren_mismatch' | null
 *   - siteWebValidatedAt   : ISO timestamp (date du résultat)
 *   - siteWebLastCheckedAt : ISO timestamp (date de cette écriture)
 *   - siteWebVersion       : 'v1'
 *
 * Best effort : retourne false si pas de connection string, partitionKey
 * inconnu, ou throw lors de l'écriture. Le caller log warn et continue.
 *
 * @param {string} siren
 * @param {Object} result                 FindWebsiteOutput
 * @param {Object} [opts]
 * @param {string} [opts.partitionKey]    Si connu (depuis le candidate)
 * @param {Date}   [opts.now]
 * @returns {Promise<boolean>}
 */
async function writeSiteFinderResultToLeadBase(siren, result, opts = {}) {
  const client = _getClient();
  if (!client) return false;
  if (!/^\d{9}$/.test(String(siren || ''))) return false;
  if (!result || typeof result !== 'object') return false;

  const partitionKey = opts.partitionKey
    ? String(opts.partitionKey)
    : await lookupPartitionKey(client, siren);
  if (!partitionKey) return false;

  const nowDate = opts.now instanceof Date ? opts.now : new Date();
  const entity = {
    partitionKey,
    rowKey: String(siren),
    siteWeb: result.siteUrl || null,
    siteWebConfidence: typeof result.confidence === 'number' ? result.confidence : 0,
    siteWebSource: result.source || null,
    siteWebProofType: result.proofType || null,
    siteWebValidatedAt: result.validatedAt || nowDate.toISOString(),
    siteWebLastCheckedAt: nowDate.toISOString(),
    siteWebVersion: WRITER_VERSION,
  };

  try {
    // I-1 OK: writer site-finder = Couche 3 owner. Pose ses propres audit *At
    // (siteWebLastCheckedAt, siteWebValidatedAt). Refactor vers
    // safeMergeCoucheN reporté à un follow-up — ce writer a sa logique
    // d'idempotence interne et son propre cluster (websitePatternsCache).
    // I-9 OK: entity ne pose que des colonnes Couche 3 owned (siteWeb*).
    // I-10 OK: siteWebLastCheckedAt + siteWebValidatedAt posés ligne 94-95.
    await client.updateEntity(entity, 'Merge');
    return true;
  } catch {
    return false;
  }
}

/**
 * Cherche le partitionKey d'une entité par RowKey via query filter. Coûte un
 * round-trip réseau supplémentaire — utilisé seulement quand le caller n'a
 * pas pu propager le partitionKey depuis selectCandidates.
 *
 * @returns {Promise<string|null>}
 */
async function lookupPartitionKey(client, siren) {
  try {
    // I-2 OK: filter combine RowKey eq siren + schema_version eq '1.0'.
    // site-finder ne doit pas écrire sur du legacy non-conforme.
    const iter = client.listEntities({
      queryOptions: {
        filter: `RowKey eq '${String(siren).replace(/'/g, "''")}' and schema_version eq '1.0'`,
        select: ['PartitionKey', 'RowKey'],
      },
    });
    for await (const entity of iter) {
      if (entity.partitionKey || entity.PartitionKey) {
        return String(entity.partitionKey || entity.PartitionKey);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function _setClientForTests(client) {
  _injectedClient = client;
}

function _resetForTests() {
  _client = null;
  _injectedClient = null;
}

module.exports = {
  writeSiteFinderResultToLeadBase,
  TABLE_NAME,
  WRITER_VERSION,
  // Exposés pour tests :
  _setClientForTests,
  _resetForTests,
  _internals: { lookupPartitionKey },
};
