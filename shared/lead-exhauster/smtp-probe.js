'use strict';

/**
 * SMTP probe MVP — vérifie qu'un email existe en interrogeant le serveur SMTP
 * du domaine via MX lookup + RCPT TO.
 *
 * Conçu pour passer la confidence d'un pattern_hint deviné de 0.65 à 0.85
 * quand le serveur SMTP accepte le RCPT TO. Doctrine 0.80 maintenue pour
 * l'envoi : 0.85 > 0.80 OK, 0.65 < 0.80 KO.
 *
 * IMPORTANT — limites du MVP livré 6 mai 2026 (Phase 1) :
 *   1. Pas de retry sur greylisting 4xx (à ajouter Sprint 2 — retry async 5-15min)
 *   2. Pas de détection catch-all (à ajouter Sprint 2 — second probe random_xxx)
 *   3. Azure FA bloque le port 25 outbound — ce probe ne marchera PAS depuis
 *      pereneo-mail-sender. Doit tourner depuis Mac Air worker ou bastion
 *      avec port 25 ouvert.
 *   4. Réputation IP : sur >50 probes/h depuis une IP non-warmupée, risque
 *      de ban ESP. Pas de mitigation MVP, à gérer Sprint 2 (IP dédiée).
 *   5. Précision dégradée selon ESP : Gmail/Outlook acceptent quasi tout en
 *      RCPT (false positive), self-hosted PME plus fiable.
 *
 * Exposé :
 *   - probeEmail({ email, helloDomain, fromAddress, adapters, timeout })
 *     → { status: 'ok'|'rejected'|'unknown', code, response, mxHost?, elapsedMs }
 *   - resolveMxHosts(domain, dnsImpl)  utility
 *
 * Dependency injection pour tests :
 *   adapters.mxLookup(domain) → Promise<[{exchange, priority}]>
 *   adapters.smtpDialog({host, email, helloDomain, fromAddress, timeout})
 *      → Promise<{code, response, accepted}>
 */

const dns = require('dns').promises;
const net = require('net');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_HELLO_DOMAIN = 'oseys.fr';
const DEFAULT_FROM = 'probe@oseys.fr';

/**
 * Résout les MX d'un domaine, triés par priorité ascendante.
 *
 * @param {string} domain
 * @param {Object} [dnsImpl]   Override pour tests (.resolveMx)
 * @returns {Promise<Array<{exchange:string, priority:number}>>}
 */
async function resolveMxHosts(domain, dnsImpl) {
  const impl = dnsImpl || dns;
  const records = await impl.resolveMx(domain);
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }
  return [...records].sort((a, b) => (a.priority || 0) - (b.priority || 0));
}

/**
 * Dialogue SMTP minimal contre un host. Réel (net.connect) si pas d'override.
 *
 * Séquence : connect → 220 → EHLO → 250 → MAIL FROM → 250 → RCPT TO → code
 * → QUIT. Lit ligne par ligne (CRLF). Timeout global.
 *
 * @returns {Promise<{code:number, response:string, accepted:boolean}>}
 */
function smtpDialog({ host, email, helloDomain, fromAddress, timeout }) {
  return new Promise((resolve, reject) => {
    let socket;
    let timer;
    let buffer = '';
    let step = 'greeting';
    let lastCode = null;

    const cleanup = (err, result) => {
      if (timer) clearTimeout(timer);
      if (socket) {
        try { socket.destroy(); } catch {}
      }
      if (err) reject(err);
      else resolve(result);
    };

    timer = setTimeout(() => {
      cleanup(new Error(`smtp timeout after ${timeout}ms (step=${step})`));
    }, timeout || DEFAULT_TIMEOUT_MS);

    try {
      socket = net.createConnection({ host, port: 25 });
    } catch (err) {
      cleanup(err);
      return;
    }

    const send = (line) => {
      try { socket.write(line + '\r\n'); } catch (err) { cleanup(err); }
    };

    const handleResponse = (line) => {
      const m = line.match(/^(\d{3})([- ])(.*)$/);
      if (!m) return;
      const code = parseInt(m[1], 10);
      const cont = m[2] === '-';
      if (cont) return;
      lastCode = code;
      if (step === 'greeting') {
        if (code === 220) {
          step = 'ehlo';
          send(`EHLO ${helloDomain}`);
        } else cleanup(null, { code, response: line, accepted: false });
      } else if (step === 'ehlo') {
        if (code === 250) {
          step = 'mail';
          send(`MAIL FROM:<${fromAddress}>`);
        } else cleanup(null, { code, response: line, accepted: false });
      } else if (step === 'mail') {
        if (code === 250) {
          step = 'rcpt';
          send(`RCPT TO:<${email}>`);
        } else cleanup(null, { code, response: line, accepted: false });
      } else if (step === 'rcpt') {
        const accepted = code >= 200 && code < 300;
        send('QUIT');
        cleanup(null, { code, response: line, accepted });
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleResponse(line);
      }
    });

    socket.on('error', (err) => cleanup(err));
    socket.on('end', () => {
      if (lastCode === null) cleanup(new Error('smtp connection closed before any response'));
    });
  });
}

/**
 * Probe principal : MX lookup → tente chaque MX par priorité jusqu'à un
 * résultat exploitable (code 5xx définitif ou 250 ok).
 *
 * Mappings status :
 *   - accepted (250) → status='ok'
 *   - 550/551/553/554 → status='rejected' (mailbox unknown / blocked)
 *   - 4xx ou erreur réseau → status='unknown' (transient/greylisting/MX KO)
 *
 * @param {Object} arg
 * @param {string} arg.email
 * @param {string} [arg.helloDomain]
 * @param {string} [arg.fromAddress]
 * @param {number} [arg.timeout]
 * @param {Object} [arg.adapters]   { mxLookup, smtpDialog }
 * @returns {Promise<{status, code, response, mxHost, elapsedMs}>}
 */
async function probeEmail({
  email,
  helloDomain = DEFAULT_HELLO_DOMAIN,
  fromAddress = DEFAULT_FROM,
  timeout = DEFAULT_TIMEOUT_MS,
  adapters = {},
} = {}) {
  const t0 = Date.now();
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return {
      status: 'unknown',
      code: null,
      response: 'invalid email syntax',
      mxHost: null,
      elapsedMs: Date.now() - t0,
    };
  }
  const domain = email.split('@')[1].toLowerCase();
  const mxLookup = adapters.mxLookup || ((d) => resolveMxHosts(d));
  const dialog = adapters.smtpDialog || smtpDialog;

  let mxHosts;
  try {
    mxHosts = await mxLookup(domain);
  } catch (err) {
    return {
      status: 'unknown',
      code: null,
      response: `mx lookup failed: ${err.message}`,
      mxHost: null,
      elapsedMs: Date.now() - t0,
    };
  }
  if (!mxHosts || mxHosts.length === 0) {
    return {
      status: 'unknown',
      code: null,
      response: 'no mx records',
      mxHost: null,
      elapsedMs: Date.now() - t0,
    };
  }

  // Tri par priorité ascendante au cas où l'adapter mxLookup ne trie pas.
  const sortedMx = [...mxHosts].sort((a, b) => (a.priority || 0) - (b.priority || 0));

  let lastResult = null;
  for (const mx of sortedMx) {
    try {
      const r = await dialog({
        host: mx.exchange,
        email,
        helloDomain,
        fromAddress,
        timeout,
      });
      lastResult = { ...r, mxHost: mx.exchange };
      if (r.accepted) {
        return {
          status: 'ok',
          code: r.code,
          response: r.response,
          mxHost: mx.exchange,
          elapsedMs: Date.now() - t0,
        };
      }
      const isDefiniteReject = r.code >= 550 && r.code < 560;
      if (isDefiniteReject) {
        return {
          status: 'rejected',
          code: r.code,
          response: r.response,
          mxHost: mx.exchange,
          elapsedMs: Date.now() - t0,
        };
      }
      // 4xx ou autre 5xx → on tente le MX suivant
    } catch (err) {
      lastResult = {
        code: null,
        response: err.message,
        mxHost: mx.exchange,
      };
      // on tente le MX suivant
    }
  }

  return {
    status: 'unknown',
    code: lastResult ? lastResult.code : null,
    response: lastResult ? lastResult.response : 'all mx attempts failed',
    mxHost: lastResult ? lastResult.mxHost : null,
    elapsedMs: Date.now() - t0,
  };
}

module.exports = {
  probeEmail,
  resolveMxHosts,
  smtpDialog,
  // Constants exposed for tests
  _DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
};
