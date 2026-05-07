'use strict';

/**
 * Writer LeadBase pour les résultats site-finder.
 *
 * Écriture Couche 3 (siteWeb*) via le helper doctrinaire safeMergeCoucheN
 * (cf. shared/leadbase/safe-write.js) qui enforce I-1 (Couche 1 prerequisite),
 * I-9 (sémantique unique — owned columns), I-10 (audit *At présent).
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
 *
 * `writeEmailResultToLeadBase` reste en place avec bypass commenté :
 * la migration Couche 4 (emailDirigeant* LeadBase → LeadContacts conforme
 * doctrine v1.1) est un refactor architectural cascade (touche
 * enrichBatch fast path + leadSelector lecture) qui mérite son propre
 * chantier, pas une cleanup inline. Cf. follow-up dédié post 7 mai PM.
 */

const { TableClient } = require('@azure/data-tables');
const { safeMergeCoucheN } = require('../../leadbase/safe-write');

const TABLE_NAME = process.env.LEADBASE_TABLE || 'LeadBase';
const WRITER_VERSION = 'v1';
const EMAIL_WRITER_VERSION = 'v1';
const VIOLATIONS_TABLE = process.env.LEADBASE_INTEGRITY_VIOLATIONS_TABLE
  || 'LeadBaseIntegrityViolations';

const SITE_FINDER_OWNED_COLUMNS = Object.freeze([
  'siteWeb',
  'siteWebConfidence',
  'siteWebSource',
  'siteWebProofType',
  'siteWebValidatedAt',
  'siteWebLastCheckedAt',
  'siteWebVersion',
]);

let _client = null;
let _injectedClient = null;
let _violationsClient = null;
let _injectedViolationsClient = null;

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

function _getViolationsClient() {
  if (_injectedViolationsClient) return _injectedViolationsClient;
  if (_violationsClient) return _violationsClient;
  const conn = process.env.WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING
    || process.env.LEADBASE_STORAGE_CONNECTION_STRING
    || process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _violationsClient = TableClient.fromConnectionString(conn, VIOLATIONS_TABLE);
    return _violationsClient;
  } catch {
    return null;
  }
}

/**
 * Écrit le résultat site-finder sur l'entité LeadBase identifiée par `siren`.
 * Délègue à safeMergeCoucheN qui valide I-1, I-9, I-10 et enregistre les
 * violations dans LeadBaseIntegrityViolations.
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
 * inconnu, Couche 1 non conforme sur l'entrée cible, ou throw lors de
 * l'écriture. Le caller log warn et continue.
 *
 * @param {string} siren
 * @param {Object} result                 FindWebsiteOutput
 * @param {Object} [opts]
 * @param {string} [opts.partitionKey]    Si connu (depuis le candidate)
 * @param {Date}   [opts.now]
 * @param {Object} [opts.logger]          safeLog compatible
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
  const patch = {
    siteWeb: result.siteUrl || null,
    siteWebConfidence: typeof result.confidence === 'number' ? result.confidence : 0,
    siteWebSource: result.source || null,
    siteWebProofType: result.proofType || null,
    siteWebValidatedAt: result.validatedAt || nowDate.toISOString(),
    siteWebLastCheckedAt: nowDate.toISOString(),
    siteWebVersion: WRITER_VERSION,
  };

  try {
    const mergeResult = await safeMergeCoucheN({
      leadBaseClient: client,
      violationsClient: _getViolationsClient(),
      layer: 'siteFinder',
      partitionKey,
      rowKey: String(siren),
      patch,
      ownedColumns: [...SITE_FINDER_OWNED_COLUMNS],
      logger: opts.logger,
    });
    return mergeResult.ok === true;
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

/**
 * Écrit le résultat email-scraping AirWorker sur l'entité LeadBase.
 *
 * Champs écrits (Merge) :
 *   - emailDirigeant          : adresse email (string) ou null
 *   - emailDirigeantSource    : 'airworker_scrape' (chaîne libre)
 *   - emailDirigeantConfidence: 0-1
 *   - emailDirigeantAt        : ISO timestamp
 *   - emailDirigeantVersion   : 'v1'
 *
 * @param {string} siren
 * @param {{ email: string|null, confidence: number, source: string }} emailResult
 * @param {Object} [opts]
 * @param {string} [opts.partitionKey]
 * @param {Date}   [opts.now]
 * @returns {Promise<boolean>}
 */
async function writeEmailResultToLeadBase(siren, emailResult, opts = {}) {
  const client = _getClient();
  if (!client) return false;
  if (!/^\d{9}$/.test(String(siren || ''))) return false;
  if (!emailResult || typeof emailResult !== 'object') return false;

  const partitionKey = opts.partitionKey
    ? String(opts.partitionKey)
    : await lookupPartitionKey(client, siren);
  if (!partitionKey) return false;

  const nowDate = opts.now instanceof Date ? opts.now : new Date();
  const entity = {
    partitionKey,
    rowKey: String(siren),
    emailDirigeant: emailResult.email || null,
    emailDirigeantSource: emailResult.source || null,
    emailDirigeantConfidence: typeof emailResult.confidence === 'number' ? emailResult.confidence : 0,
    emailDirigeantAt: nowDate.toISOString(),
    emailDirigeantVersion: EMAIL_WRITER_VERSION,
  };

  try {
    // I-1 OK: writer email AirWorker scraping (introduit par origin/main).
    // Dette technique reconnue : en doctrine v1 la Couche 4 Email vit en
    // LeadContacts, pas en LeadBase. Cette fonction écrit emailDirigeant*
    // directement en LeadBase pour le fast path AirWorker convoyeur vers
    // enrichBatch (cf. shared/lead-exhauster/enrichBatch.js:247,418-424
    // qui lit cand.emailDirigeant comme source pivot).
    //
    // Le refactor vers writer LeadContacts conforme v1 est cascade :
    //   1. Nouveau writer writeAirWorkerEmailToLeadContacts (Couche 4 v1).
    //   2. Bascule fast path enrichBatch lecture LeadBase → LeadContacts.
    //   3. Bascule leadSelector copie emailDirigeant via jointure ou flag
    //      compact en LeadBase pointant vers LeadContacts.
    //   4. Suppression colonnes emailDirigeant* en LeadBase (post 30j compat).
    //
    // Chantier architectural dédié, pas une cleanup pre-merge. Bypass
    // maintenu en attendant.
    // I-9 OK: les colonnes emailDirigeant* sont owned par ce writer dans le
    // contrat actuel — à isoler en migrant vers LeadContacts.
    // I-10 OK: emailDirigeantAt posé ligne 178.
    await client.updateEntity(entity, 'Merge');
    return true;
  } catch {
    return false;
  }
}

function _setClientForTests(client) {
  _injectedClient = client;
}

function _setViolationsClientForTests(client) {
  _injectedViolationsClient = client;
}

function _resetForTests() {
  _client = null;
  _injectedClient = null;
  _violationsClient = null;
  _injectedViolationsClient = null;
}

module.exports = {
  writeSiteFinderResultToLeadBase,
  writeEmailResultToLeadBase,
  TABLE_NAME,
  WRITER_VERSION,
  EMAIL_WRITER_VERSION,
  SITE_FINDER_OWNED_COLUMNS,
  // Exposés pour tests :
  _setClientForTests,
  _setViolationsClientForTests,
  _resetForTests,
  _internals: { lookupPartitionKey },
};
