'use strict';

/**
 * Helpers de lecture LeadBase enforçant l'invariant I-2 (discrimination origine).
 *
 * Doctrine : LEADBASE_LESSONS_v1.md §4 invariant I-2.
 * Schéma : LEADBASE_SCHEMA_v1.md §10.5.
 *
 * Tout reader LeadBase qui ne passe pas par ces helpers risque de remonter
 * du legacy non-conforme. Tout reader Couches 1-5 doit appeler
 * safeListLeadBaseEntities() ou assertDiscriminantInFilter() avant un
 * listEntities direct.
 */

const { SCHEMA_VERSION_V1 } = require('./schema-v1');

const DISCRIMINANTS = Object.freeze(['schema_version', 'sireneRunId']);

/**
 * Vérifie qu'un filter OData contient au moins un discriminant origine.
 * Retourne `{ ok: bool, reason?: string }`.
 *
 * @param {string} filter Filter OData v3 / v4 Storage Tables.
 * @returns {{ ok: boolean, reason?: string }}
 */
function assertDiscriminantInFilter(filter) {
  if (!filter || typeof filter !== 'string' || filter.trim() === '') {
    return { ok: false, reason: 'filter_empty_or_missing' };
  }
  const hasDisc = DISCRIMINANTS.some((d) => filter.includes(d));
  if (!hasDisc) {
    return { ok: false, reason: `no_discriminant_found (must contain ${DISCRIMINANTS.join(' or ')})` };
  }
  return { ok: true };
}

/**
 * Compose un filter OData de discrimination minimal v1.
 * Utilitaire pour les readers qui veulent juste lire les entrées v1.0.
 *
 * @param {Object} [extra] Filtres additionnels { dept, trancheEffectif, codeNaf, ... }
 * @returns {string} Filter OData
 */
function composeDiscriminantFilter(extra = {}) {
  const parts = [`schema_version eq '${SCHEMA_VERSION_V1}'`];
  if (extra.partitionKey) parts.push(`PartitionKey eq '${extra.partitionKey}'`);
  if (extra.trancheEffectif) parts.push(`trancheEffectif eq '${extra.trancheEffectif}'`);
  if (extra.codeNaf) parts.push(`codeNaf eq '${extra.codeNaf}'`);
  if (extra.sireneRunId) parts.push(`sireneRunId eq '${extra.sireneRunId}'`);
  return parts.join(' and ');
}

/**
 * Wrapper safe pour listEntities. Refuse de scanner sans discriminant origine.
 *
 * @param {Object} client TableClient.
 * @param {Object} [queryOptions] Storage Tables queryOptions.
 * @param {Object} [opts]
 * @param {boolean} [opts.allowEmptyFilter=false] Bypass I-2 (ex. audit complet legacy)
 * @returns {AsyncIterableIterator} Itérateur d'entités.
 */
async function* safeListLeadBaseEntities(client, queryOptions = {}, opts = {}) {
  if (!client) throw new Error('client_missing');

  if (!opts.allowEmptyFilter) {
    const filter = queryOptions.filter || (queryOptions.queryOptions && queryOptions.queryOptions.filter);
    const check = assertDiscriminantInFilter(filter);
    if (!check.ok) {
      throw new Error(`I2_violation:${check.reason}`);
    }
  }

  const iter = client.listEntities(queryOptions);
  for await (const entity of iter) {
    yield entity;
  }
}

module.exports = {
  DISCRIMINANTS,
  assertDiscriminantInFilter,
  composeDiscriminantFilter,
  safeListLeadBaseEntities,
};
