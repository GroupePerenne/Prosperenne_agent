'use strict';

/**
 * Trace cross-invocation des exécutions Lead Selector.
 *
 * Pattern : Azure Table Storage `LeadSelectorTrace` (créée à la volée si
 * absente). Une ligne par appel selectLeadsForConsultant. Lecture par
 * dailyReport pour produire une section "Lead Selector — 24h".
 *
 * Best effort : aucune erreur n'est propagée. Si la connection string est
 * absente ou le storage indisponible, on no-op silencieusement.
 *
 * Schéma minimal d'une ligne :
 *   PartitionKey : ISO date YYYY-MM-DD (Paris) — facilite les scans 24h
 *   RowKey       : ISO timestamp + random (unique)
 *   status       : 'ok' | 'insufficient' | 'empty' | 'error'
 *   returned     : nombre de leads retournés
 *   requested    : taille de batch demandée
 *   candidatesCount, excludedByRules, excludedNoEmail, excludedNoGps : ints
 *   nafCount, effectifCount, deptCount : tailles des filtres (pas les valeurs)
 *   elapsedMs    : latence du selector
 *   reason       : 'no_sector_mapped' / errorCode si error
 *   briefId, consultantId : identifiants si fournis
 */

const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = process.env.LEAD_SELECTOR_TRACE_TABLE || 'LeadSelectorTrace';

let _client = null;
let _ensured = false;

function getClient() {
  if (_client) return _client;
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) return null;
  try {
    _client = TableClient.fromConnectionString(conn, TABLE_NAME);
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
    } else {
      // autre erreur : on log éventuellement, mais on continue
    }
  } finally {
    _ensured = true;
  }
}

function safeIsoDateParis(d = new Date()) {
  // Approximation simple : on délègue à shared/holidays si dispo, sinon UTC date
  try {
    const { parisDateParts } = require('./holidays');
    return parisDateParts(d).isoDate;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function rowKey() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  // Inversé pour avoir l'ordre antichronologique en scan natif
  return `${(9999999999999 - ts).toString().padStart(13, '0')}-${rand}`;
}

/**
 * Enregistre un événement Lead Selector. Best effort.
 *
 * @param {Object} event
 * @param {string} event.status
 * @param {Object} [event.meta]   meta du SelectorResult
 * @param {string} [event.briefId]
 * @param {string} [event.consultantId]
 */
async function recordLeadSelectorEvent(event = {}) {
  const client = getClient();
  if (!client) return null;
  try {
    await ensureTable(client);
    const meta = event.meta || {};
    const entity = {
      partitionKey: safeIsoDateParis(),
      rowKey: rowKey(),
      status: String(event.status || 'unknown').slice(0, 32),
      requested: meta.requested || 0,
      returned: meta.returned || 0,
      candidatesCount: meta.candidatesCount || 0,
      excludedByRules: meta.excludedByRules || 0,
      excludedNoEmail: meta.excludedNoEmail || 0,
      excludedNoGps: meta.excludedNoGps || 0,
      nafCount: Array.isArray(meta.nafCodesQueried) ? meta.nafCodesQueried.length : 0,
      effectifCount: Array.isArray(meta.effectifCodesQueried) ? meta.effectifCodesQueried.length : 0,
      deptCount:
        meta.zoneFilter && Array.isArray(meta.zoneFilter.departements)
          ? meta.zoneFilter.departements.length
          : 0,
      elapsedMs: meta.elapsedMs || 0,
      reason: meta.reason || meta.errorCode || '',
      briefId: event.briefId || '',
      consultantId: event.consultantId || '',
      excludedNoDirigeant: meta.excludedNoDirigeant || 0,
      excludedNoDirigeantSirensJson: Array.isArray(meta.excludedNoDirigeantSirens)
        ? JSON.stringify(meta.excludedNoDirigeantSirens.slice(0, 100)).slice(0, 32000)
        : '[]',
      excludedAlreadyInPipe: meta.excludedAlreadyInPipe || 0,
    };
    await client.createEntity(entity);
    return entity;
  } catch {
    return null;
  }
}

/**
 * Lit les événements depuis une date (incluse). Best effort, retourne [].
 */
async function readEventsSince(isoDate) {
  const client = getClient();
  if (!client) return [];
  try {
    const out = [];
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey ge '${isoDate}'` },
    });
    for await (const e of iterator) {
      out.push(e);
      if (out.length >= 5000) break; // garde-fou
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Compose une string HTML résumant les events des 24h passées. Utilisée
 * par dailyReport. Si aucun event : retourne null (le caller décide de
 * ne rien envoyer).
 */
function summarizeEventsHtml(events, { dateLabel } = {}) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const counts = { ok: 0, insufficient: 0, empty: 0, error: 0 };
  let totalReturned = 0;
  let totalCandidates = 0;
  let totalNoEmail = 0;
  let totalElapsed = 0;
  const reasons = new Map();

  for (const e of events) {
    if (counts[e.status] !== undefined) counts[e.status]++;
    totalReturned += e.returned || 0;
    totalCandidates += e.candidatesCount || 0;
    totalNoEmail += e.excludedNoEmail || 0;
    totalElapsed += e.elapsedMs || 0;
    if (e.reason) reasons.set(e.reason, (reasons.get(e.reason) || 0) + 1);
  }

  const total = events.length;
  const avgMs = total > 0 ? Math.round(totalElapsed / total) : 0;
  const top3Reasons = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `<li>${escapeHtml(k)} : ${v}</li>`)
    .join('');

  return `<h3 style="margin:24px 0 8px;font-size:15px;color:#1a1714">Lead Selector — ${escapeHtml(dateLabel || 'dernières 24h')}</h3>
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1a1714">
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Exécutions totales</td><td><strong>${total}</strong></td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Répartition status</td><td>ok ${counts.ok} · insufficient ${counts.insufficient} · empty ${counts.empty} · error ${counts.error}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Leads produits</td><td>${totalReturned}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Candidats LeadBase scannés</td><td>${totalCandidates}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Exclus faute d'email</td><td>${totalNoEmail}</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#7a756f">Latence moyenne</td><td>${avgMs} ms</td></tr>
</table>
${top3Reasons ? `<p style="margin:8px 0 0;font-size:13px;color:#1a1714">Top raisons d'insuffisance / erreur :</p><ul style="margin:4px 0;font-size:13px">${top3Reasons}</ul>` : ''}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function _resetForTests() {
  _client = null;
  _ensured = false;
}

module.exports = {
  recordLeadSelectorEvent,
  readEventsSince,
  summarizeEventsHtml,
  _resetForTests,
};
