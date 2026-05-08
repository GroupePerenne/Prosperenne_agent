'use strict';

/**
 * SMTP probe — vérification soft (sans envoi) qu'une adresse email candidate
 * est acceptée par le serveur destinataire.
 *
 * Mécanique :
 *   1. Résolution MX du domaine via DNS
 *   2. Connect MX:25 (port SMTP)
 *   3. EHLO {helloDomain}     → 250 OK attendu
 *   4. MAIL FROM:<{fromAddress}> → 250 OK attendu
 *   5. RCPT TO:<{candidateEmail}> → 250 OK = email accepté, 550/553/554 = rejeté
 *   6. QUIT (clean disconnect, pas d'envoi DATA)
 *
 * Statuts retournés :
 *   - 'ok'        : 250 sur RCPT TO → l'adresse est acceptée
 *   - 'rejected'  : 550/553/554 sur RCPT TO → l'adresse n'existe pas
 *   - 'no_mx'     : pas de MX record DNS pour le domaine
 *   - 'timeout'   : connection TCP timeout (réseau ou MX inaccessible)
 *   - 'error_*'   : erreur réseau ou code SMTP inattendu
 *
 * Limites :
 *   - Catch-all servers : retournent 250 sur tout RCPT TO valide → ambigu, on
 *     ne peut pas distinguer "vraie boîte" de "catch-all". Caller doit gérer.
 *   - Greylisting : 451 4.7.1 → on retry 1× après 60s (option futur)
 *   - Réputation IP : si on probe trop, le serveur peut blacklister notre IP.
 *     Throttle externe imposé par le caller.
 *   - Azure FA Linux Consumption bloque port 25 sortant. Ce module ne peut
 *     tourner qu'en local Mac (AirWorker) ou Container App avec port 25 ouvert.
 *
 * Pas de dépendance externe : modules natifs Node 'net' + 'dns/promises'.
 */

const net = require('net');
const dns = require('dns/promises');

const DEFAULT_HELO_DOMAIN = process.env.SMTP_PROBE_HELO_DOMAIN || 'pereneo.eu';
const DEFAULT_FROM_ADDRESS = process.env.SMTP_PROBE_FROM_ADDRESS || 'verify@pereneo.eu';
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Résout les MX records d'un domaine, triés par priorité ascendante.
 *
 * @param {string} domain
 * @param {Object} [opts]
 * @param {Object} [opts.dnsImpl]  Injection pour tests
 * @returns {Promise<string[]>} liste des hostnames MX, [] si aucun.
 */
async function resolveMxHosts(domain, opts = {}) {
  const dnsImpl = opts.dnsImpl || dns;
  try {
    const records = await dnsImpl.resolveMx(domain);
    if (!Array.isArray(records) || records.length === 0) return [];
    return records
      .slice()
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .map((r) => r.exchange);
  } catch {
    return [];
  }
}

/**
 * Lance un dialogue SMTP MAIL/RCPT contre un MX. Retourne un objet
 * { status, code, mxHost, log[] }.
 */
async function smtpDialog(mxHost, email, opts = {}) {
  const helloDomain = opts.helloDomain || DEFAULT_HELO_DOMAIN;
  const fromAddress = opts.fromAddress || DEFAULT_FROM_ADDRESS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const result = { status: 'unknown', code: null, mxHost, log: [] };
    let stage = 'connect';
    let buffer = '';
    let resolved = false;

    function done(status, code) {
      if (resolved) return;
      resolved = true;
      result.status = status;
      if (code != null) result.code = code;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    }

    function send(cmd) {
      result.log.push(`> ${cmd}`);
      try { socket.write(`${cmd}\r\n`); } catch { /* socket dead */ }
    }

    const socket = net.createConnection({ host: mxHost, port: 25 });
    socket.setTimeout(timeoutMs);

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        result.log.push(`< ${line}`);
        const code = parseInt(line.slice(0, 3), 10);
        if (Number.isFinite(code)) result.code = code;
        // SMTP multi-line : "250-..." continue, "250 ..." final.
        const isContinuation = line[3] === '-';

        if (stage === 'connect' && code === 220) {
          stage = 'helo';
          send(`EHLO ${helloDomain}`);
        } else if (stage === 'helo' && code === 250 && !isContinuation) {
          stage = 'mailfrom';
          send(`MAIL FROM:<${fromAddress}>`);
        } else if (stage === 'mailfrom' && code === 250) {
          stage = 'rcptto';
          send(`RCPT TO:<${email}>`);
        } else if (stage === 'rcptto') {
          if (code === 250) {
            stage = 'quit';
            send('QUIT');
            done('ok', code);
            return;
          }
          if (code === 550 || code === 551 || code === 553 || code === 554) {
            stage = 'quit';
            send('QUIT');
            done('rejected', code);
            return;
          }
          if (code === 450 || code === 451 || code === 452) {
            // Temporary failure (greylisting, etc.)
            stage = 'quit';
            send('QUIT');
            done('temporary', code);
            return;
          }
          // Code SMTP imprévu sur RCPT TO
          done(`error_rcpt_${code}`, code);
          return;
        } else if (code === 421) {
          // Server says goodbye (rate-limit, IP banni, etc.)
          done(`error_421`, code);
          return;
        } else if (code >= 500 && stage !== 'quit') {
          done(`error_${code}_${stage}`, code);
          return;
        }
      }
    });

    socket.on('timeout', () => done('timeout'));
    socket.on('error', (err) => done(`error_network_${err.code || 'unknown'}`));
    socket.on('close', () => {
      if (!resolved) done(stage === 'quit' ? 'ok' : `closed_${stage}`);
    });
  });
}

/**
 * Vérifie soft une adresse email via SMTP probe.
 *
 *   const r = await probeEmail('jean.dupont@acme.fr');
 *   // → { status: 'ok'|'rejected'|'no_mx'|'timeout'|'error_*', code, mxHost, ... }
 *
 * @param {string} email
 * @param {Object} [opts]
 * @param {string}   [opts.helloDomain]
 * @param {string}   [opts.fromAddress]
 * @param {number}   [opts.timeoutMs]
 * @param {Object}   [opts.dnsImpl]   Injection tests
 * @param {Function} [opts.dialogImpl] Injection tests (default smtpDialog)
 * @returns {Promise<{status, code, mxHost?, error?, log?}>}
 */
async function probeEmail(email, opts = {}) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return { status: 'invalid', code: null };
  }
  const domain = email.split('@')[1].toLowerCase();
  const mxHosts = await resolveMxHosts(domain, opts);
  if (mxHosts.length === 0) {
    return { status: 'no_mx', code: null, domain };
  }

  const dialogImpl = opts.dialogImpl || smtpDialog;
  // Essai sur le 1er MX. Si timeout/error réseau, on essaie le 2e (résilience).
  const tryHosts = mxHosts.slice(0, 2);
  let lastResult = null;
  for (const mxHost of tryHosts) {
    const r = await dialogImpl(mxHost, email, opts);
    lastResult = r;
    // Statuts définitifs : on ne réessaie pas sur le MX suivant.
    if (r.status === 'ok' || r.status === 'rejected' || r.status === 'temporary') {
      return r;
    }
    // Sinon (timeout, error réseau), on tente le MX suivant.
  }
  return lastResult || { status: 'no_mx_reachable', code: null };
}

/**
 * Probe un batch de candidates email. Retourne un Map email → result.
 * Sequentiel par défaut pour ménager la réputation IP (on ne flood pas un
 * MX avec 10 RCPT TO en parallèle, plusieurs serveurs blacklistent vite).
 *
 * @param {string[]} emails
 * @param {Object} [opts]   Idem probeEmail
 * @param {number} [opts.delayBetweenMs]  Pause entre 2 probes (default 500ms)
 * @returns {Promise<Map<string, Object>>}
 */
async function probeBatch(emails, opts = {}) {
  const out = new Map();
  const delay = Number.isFinite(opts.delayBetweenMs) ? opts.delayBetweenMs : 500;
  for (const email of emails) {
    const r = await probeEmail(email, opts);
    out.set(email, r);
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  }
  return out;
}

module.exports = {
  probeEmail,
  probeBatch,
  resolveMxHosts,
  smtpDialog,
  _constants: {
    DEFAULT_HELO_DOMAIN,
    DEFAULT_FROM_ADDRESS,
    DEFAULT_TIMEOUT_MS,
  },
};
