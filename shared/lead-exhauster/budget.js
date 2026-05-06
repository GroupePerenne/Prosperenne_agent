'use strict';

/**
 * Compteur de dépenses par provider externe avec période monthly ou daily.
 *
 * Schéma table `Budgets` (schemas.js) :
 *   PartitionKey : provider (ex. 'dropcontact', 'anthropic')
 *   RowKey       : periodKey — 'YYYYMM' (monthly) ou 'YYYYMMDD' (daily)
 *   Colonnes     : spent_cents, budget_cents, calls, lastUpdatedAt
 *
 * Période par défaut : monthly (rétrocompat Dropcontact V1).
 * Daily ajouté Phase 1 observability pour cap quotidien Anthropic ($25/jour).
 *
 * Stratégie concurrence : update avec optimistic concurrency (If-Match ETag).
 * Si conflict 412, on relit + retry (max 3 fois).
 *
 * Graceful degradation : si AzureWebJobsStorage indisponible, readSpent()
 * retourne 0 et addSpend() no-op. Le caller doit avoir son propre flag
 * "budget_check_failed" dans ce cas.
 */

const { TableClient } = require('@azure/data-tables');
const { TABLE_BUDGETS } = require('./schemas');

let _client = null;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_BUDGETS);
    return _client;
  } catch {
    return null;
  }
}

async function ensureTable(client) {
  try {
    await client.createTable();
  } catch (err) {
    // déjà là (409) ou autres erreurs — on continue, le caller gère
  }
}

function currentMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

function currentDayKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function periodKey(period, date = new Date()) {
  return period === 'daily' ? currentDayKey(date) : currentMonthKey(date);
}

/**
 * Lit les dépenses pour un provider sur la période courante. Retourne 0 si absent/erreur.
 *
 * @param {string} provider
 * @param {Object} [opts]
 * @param {Date} [opts.date]
 * @param {'monthly'|'daily'} [opts.period]  Default 'monthly'
 * @returns {Promise<{ spent_cents:number, budget_cents:number, calls:number, exists:boolean, etag?:string }>}
 */
async function readSpent(provider, opts = {}) {
  const client = getClient();
  const key = periodKey(opts.period || 'monthly', opts.date);
  const empty = { spent_cents: 0, budget_cents: 0, calls: 0, exists: false };
  if (!client) return empty;
  try {
    const entity = await client.getEntity(provider, key);
    return {
      spent_cents: Number(entity.spent_cents) || 0,
      budget_cents: Number(entity.budget_cents) || 0,
      calls: Number(entity.calls) || 0,
      exists: true,
      etag: entity.etag,
    };
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
      return empty;
    }
    return empty;
  }
}

/**
 * Vérifie que le budget permet encore la dépense demandée.
 *
 * @param {string} provider
 * @param {number} costCents        Coût prévu
 * @param {number} budgetCents      Plafond sur la période
 * @param {Object} [opts]
 * @param {'monthly'|'daily'} [opts.period]  Default 'monthly'
 * @returns {Promise<{ ok:boolean, spent:number, budget:number, reason?:string }>}
 */
async function canSpend(provider, costCents, budgetCents, opts = {}) {
  const state = await readSpent(provider, opts);
  const effectiveBudget = budgetCents > 0 ? budgetCents : state.budget_cents;
  if (effectiveBudget <= 0) {
    return { ok: false, spent: state.spent_cents, budget: 0, reason: 'no_budget_configured' };
  }
  if (state.spent_cents + costCents > effectiveBudget) {
    return {
      ok: false,
      spent: state.spent_cents,
      budget: effectiveBudget,
      reason: 'budget_exceeded',
    };
  }
  return { ok: true, spent: state.spent_cents, budget: effectiveBudget };
}

/**
 * Incrémente le compteur de dépenses sur la période courante. Best effort avec
 * retry sur conflit 412. Retourne true si persisté, false sinon.
 *
 * @param {string} provider
 * @param {number} costCents
 * @param {Object} [opts]
 * @param {number} [opts.budgetCents]  Inscrit dans la ligne si création
 * @param {Date}   [opts.date]
 * @param {'monthly'|'daily'} [opts.period]  Default 'monthly'
 * @param {number} [opts.retries]
 * @returns {Promise<boolean>}
 */
async function addSpend(provider, costCents, opts = {}) {
  const client = getClient();
  if (!client) return false;
  const key = periodKey(opts.period || 'monthly', opts.date);
  const budget = Number.isFinite(opts.budgetCents) ? opts.budgetCents : 0;
  const maxRetries = Number.isFinite(opts.retries) ? opts.retries : 3;

  try {
    await ensureTable(client);
  } catch {
    // ignore — on tente quand même
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const cur = await client.getEntity(provider, key).catch((err) => {
        if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) {
          return null;
        }
        throw err;
      });
      if (!cur) {
        const now = new Date().toISOString();
        await client.createEntity({
          partitionKey: provider,
          rowKey: key,
          provider,
          periodKey: key,
          period: opts.period || 'monthly',
          spent_cents: costCents,
          budget_cents: budget,
          calls: 1,
          lastUpdatedAt: now,
        });
        return true;
      }
      const updated = {
        partitionKey: provider,
        rowKey: key,
        spent_cents: (Number(cur.spent_cents) || 0) + costCents,
        calls: (Number(cur.calls) || 0) + 1,
        lastUpdatedAt: new Date().toISOString(),
      };
      if (budget > 0) updated.budget_cents = budget;
      await client.updateEntity(updated, 'Merge', { etag: cur.etag });
      return true;
    } catch (err) {
      const s = err && (err.statusCode || (err.response && err.response.status));
      if (s === 412 && attempt < maxRetries - 1) continue; // conflict → retry
      if (s === 409 && attempt < maxRetries - 1) continue; // create race → retry
      return false;
    }
  }
  return false;
}

function _resetForTests() {
  _client = null;
}

module.exports = {
  readSpent,
  canSpend,
  addSpend,
  currentMonthKey,
  currentDayKey,
  periodKey,
  _resetForTests,
};
