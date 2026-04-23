'use strict';

/**
 * Adapter Azure Table Storage pour la base LeadBase (12,8M entreprises FR
 * SIRENE+INPI, maintenue par Constantin). Read-only. Aucun autre module ne
 * doit lire LeadBase en direct — tout passe par cet adapter.
 *
 * Usage :
 *   const adapter = new LeadBaseAdapter();
 *   const entities = await adapter.queryLeads({
 *     nafCodes: ['62.02A', '62.01Z'],
 *     effectifCodes: ['11', '12'],
 *     departements: ['75', '92', '93'],
 *     hardLimit: 2000,
 *   });
 *
 * Erreurs : throw LeadBaseError avec un .code stable (table_missing, auth_failed,
 * transient, ...).
 */

const { TableClient } = require('@azure/data-tables');

const DEFAULT_TABLE_NAME = process.env.LEADBASE_TABLE || 'LeadBase';
const DEFAULT_HARD_LIMIT = Number(process.env.LEAD_SELECTOR_HARD_LIMIT || 2000);
const NAF_CHUNK_SIZE = 50;

const SELECT_FIELDS = [
  'PartitionKey',
  'RowKey',
  'siren',
  'nom',
  'codeNaf',
  'ville',
  'trancheEffectif',
  'latitude',
  'longitude',
  'dirigeants',
];

class LeadBaseError extends Error {
  constructor(message, code = 'unknown', cause = null) {
    super(message);
    this.name = 'LeadBaseError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function escapeOData(s) {
  return String(s).replace(/'/g, "''");
}

function orClause(field, values) {
  if (!values || values.length === 0) return null;
  if (values.length === 1) return `${field} eq '${escapeOData(values[0])}'`;
  const inner = values.map((v) => `${field} eq '${escapeOData(v)}'`).join(' or ');
  return `(${inner})`;
}

/**
 * Construit la clause OData pour une requête LeadBase. Exposé pour tests.
 *
 * Règles :
 *   - departements optionnel : si présent, contraint PartitionKey
 *   - nafCodes obligatoire (caller responsable)
 *   - effectifCodes obligatoire (caller responsable)
 *   - jointure AND entre clauses
 */
function buildFilter({ nafCodes, effectifCodes, departements }) {
  const clauses = [];
  const dep = orClause('PartitionKey', departements);
  if (dep) clauses.push(dep);
  const naf = orClause('codeNaf', nafCodes);
  if (naf) clauses.push(naf);
  const eff = orClause('trancheEffectif', effectifCodes);
  if (eff) clauses.push(eff);
  return clauses.join(' and ');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

class LeadBaseAdapter {
  /**
   * @param {Object} opts
   * @param {string} [opts.connectionString]
   * @param {string} [opts.tableName]
   * @param {Object} [opts.tableClient] — injection pour tests
   * @param {Object} [opts.logger] — context.log Azure Functions ou console
   */
  constructor(opts = {}) {
    this.tableName = opts.tableName || DEFAULT_TABLE_NAME;
    this.logger = opts.logger || null;
    this._injectedClient = opts.tableClient || null;
    this._connectionString = opts.connectionString || process.env.AzureWebJobsStorage || null;
    this._client = null;
  }

  _getClient() {
    if (this._injectedClient) return this._injectedClient;
    if (this._client) return this._client;
    if (!this._connectionString) {
      throw new LeadBaseError(
        'AzureWebJobsStorage absent (et tableClient non injecté)',
        'auth_failed',
      );
    }
    this._client = TableClient.fromConnectionString(this._connectionString, this.tableName);
    return this._client;
  }

  _log(level, message, payload) {
    if (!this.logger) return;
    if (typeof this.logger[level] === 'function') {
      this.logger[level](message, payload);
    } else if (typeof this.logger === 'function') {
      this.logger(`${level}: ${message}`, payload);
    } else if (typeof this.logger.log === 'function') {
      this.logger.log(`[${level}] ${message}`, payload);
    }
  }

  /**
   * @param {Object} query
   * @param {string[]} query.nafCodes
   * @param {string[]} query.effectifCodes
   * @param {string[]} [query.departements]
   * @param {number} [query.hardLimit]
   * @returns {Promise<Array>}
   */
  async queryLeads(query) {
    const started = Date.now();
    const hardLimit = query.hardLimit || DEFAULT_HARD_LIMIT;

    if (!query.nafCodes || query.nafCodes.length === 0) {
      this._log('warn', '[leadbase] queryLeads aborted: empty nafCodes');
      return [];
    }
    if (!query.effectifCodes || query.effectifCodes.length === 0) {
      this._log('warn', '[leadbase] queryLeads called without effectif filter — falling back to default tranches 11/12/21');
      query = { ...query, effectifCodes: ['11', '12', '21'] };
    }

    const client = this._getClient();

    const nafChunks = chunk(query.nafCodes, NAF_CHUNK_SIZE);
    const truncatedFlags = [];

    let combined;
    if (nafChunks.length === 1) {
      combined = await this._fetchOneFilter(
        client,
        buildFilter({
          nafCodes: nafChunks[0],
          effectifCodes: query.effectifCodes,
          departements: query.departements,
        }),
        hardLimit,
        truncatedFlags,
      );
    } else {
      this._log(
        'warn',
        `[leadbase] partitioning ${query.nafCodes.length} NAF codes into ${nafChunks.length} chunks`,
      );
      const promises = nafChunks.map((codes) =>
        this._fetchOneFilter(
          client,
          buildFilter({
            nafCodes: codes,
            effectifCodes: query.effectifCodes,
            departements: query.departements,
          }),
          hardLimit,
          truncatedFlags,
        ),
      );
      const groups = await Promise.all(promises);
      const dedup = new Map();
      for (const group of groups) {
        for (const e of group) {
          const k = e.siren || `${e.partitionKey || e.PartitionKey || ''}:${e.rowKey || e.RowKey || ''}`;
          if (!dedup.has(k)) dedup.set(k, e);
        }
      }
      combined = [...dedup.values()];
      if (combined.length > hardLimit) {
        truncatedFlags.push(true);
        combined = combined.slice(0, hardLimit);
      }
    }

    this._log('info', '[leadbase] queryLeads', {
      nafCount: query.nafCodes.length,
      effectifCount: query.effectifCodes.length,
      departements: (query.departements && query.departements.length) || 0,
      resultCount: combined.length,
      truncated: truncatedFlags.length > 0,
      ms: Date.now() - started,
      chunks: nafChunks.length,
    });

    return combined;
  }

  async _fetchOneFilter(client, filter, hardLimit, truncatedFlags) {
    const out = [];
    try {
      const iterator = client.listEntities({
        queryOptions: {
          filter,
          select: SELECT_FIELDS,
        },
      });
      for await (const entity of iterator) {
        out.push(entity);
        if (out.length >= hardLimit) {
          truncatedFlags.push(true);
          break;
        }
      }
    } catch (err) {
      throw classifyError(err);
    }
    return out;
  }
}

function classifyError(err) {
  if (err instanceof LeadBaseError) return err;
  const status = err && (err.statusCode || (err.response && err.response.status));
  if (status === 404) return new LeadBaseError('LeadBase table missing', 'table_missing', err);
  if (status === 401 || status === 403) return new LeadBaseError('LeadBase auth failed', 'auth_failed', err);
  if (status === 429 || (status >= 500 && status < 600)) {
    return new LeadBaseError('LeadBase transient error', 'transient', err);
  }
  if (err && (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET')) {
    return new LeadBaseError('LeadBase network error', 'transient', err);
  }
  return err;
}

module.exports = {
  LeadBaseAdapter,
  LeadBaseError,
  buildFilter,
  // exposé pour tests :
  _internals: { chunk, classifyError, NAF_CHUNK_SIZE, SELECT_FIELDS },
};
