/**
 * lib/tokenProvider — provider de Bearer token Entra v2 (client_credentials).
 *
 * Pattern strictement calqué sur le wrapper bash charli-mcp-token.sh côté Paul :
 * cache in-memory du token + refresh à expiry - 300s. Lecture lazy de
 * process.env.ENTRA_CLIENT_SECRET au moment de chaque POST OAuth (pas de
 * mémorisation, pas de fs read d'un fichier). Le secret est résolu par le
 * runtime FA depuis la KV reference, on ne le manipule jamais.
 *
 * R-CRED strict : aucun log du token (pattern propre `length: token.length`).
 */

'use strict';

const REFRESH_BUFFER_MS = 300 * 1000;

let _fetchImpl = null; // override testable
let _clockImpl = null; // override testable

function nowMs() {
  return _clockImpl ? _clockImpl() : Date.now();
}

function fetchImpl() {
  return _fetchImpl || globalThis.fetch;
}

/**
 * Crée un provider de token. Chaque provider possède son propre cache.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId — Entra tenant ID (GUID)
 * @param {string} opts.clientId — App registration client ID
 * @param {string} opts.scope    — ex: "api://pereneo-charli-mcp/.default"
 * @returns {{ getAccessToken: () => Promise<string> }}
 */
function createTokenProvider({ tenantId, clientId, scope } = {}) {
  if (!tenantId) throw new Error('createTokenProvider: tenantId requis');
  if (!clientId) throw new Error('createTokenProvider: clientId requis');
  if (!scope) throw new Error('createTokenProvider: scope requis');

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  let cache = null; // { accessToken, expiresAtMs }

  async function fetchNewToken() {
    const clientSecret = process.env.ENTRA_CLIENT_SECRET;
    if (!clientSecret) {
      throw new Error('ENTRA_CLIENT_SECRET non défini (KV reference manquante côté FA)');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: scope,
    }).toString();

    let res;
    try {
      res = await fetchImpl()(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new Error(`Entra token fetch failed: ${err.message || err}`);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j.error_description || j.error || '';
      } catch (_) { /* body non JSON */ }
      throw new Error(`Entra token HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }

    const j = await res.json();
    if (!j.access_token) {
      throw new Error('Entra token response missing access_token');
    }
    const expiresInSec = Number(j.expires_in) || 3600;
    cache = {
      accessToken: j.access_token,
      expiresAtMs: nowMs() + expiresInSec * 1000,
    };
    return cache.accessToken;
  }

  async function getAccessToken() {
    if (cache && nowMs() < cache.expiresAtMs - REFRESH_BUFFER_MS) {
      return cache.accessToken;
    }
    return fetchNewToken();
  }

  return { getAccessToken };
}

const _internals = {
  REFRESH_BUFFER_MS,
  setFetchForTests: (f) => { _fetchImpl = f; },
  setClockForTests: (c) => { _clockImpl = c; },
  resetForTests: () => { _fetchImpl = null; _clockImpl = null; },
};

module.exports = {
  createTokenProvider,
  _internals,
};
