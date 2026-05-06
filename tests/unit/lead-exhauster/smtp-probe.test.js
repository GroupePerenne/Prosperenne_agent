'use strict';

/**
 * Tests SMTP probe — adapters injectés pour ne pas tirer sur le réseau réel.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { probeEmail, resolveMxHosts } = require('../../../shared/lead-exhauster/smtp-probe');

function makeAdapters({ mxRecords, dialogResults }) {
  let dialogIdx = 0;
  return {
    mxLookup: async () => mxRecords,
    smtpDialog: async ({ host }) => {
      const r = Array.isArray(dialogResults)
        ? dialogResults[dialogIdx++]
        : dialogResults;
      if (r instanceof Error) throw r;
      return { ...r, host };
    },
  };
}

test('probeEmail — email syntaxiquement invalide → unknown', async () => {
  const r = await probeEmail({ email: 'not-an-email' });
  assert.equal(r.status, 'unknown');
  assert.equal(r.code, null);
});

test('probeEmail — pas de MX → unknown', async () => {
  const adapters = makeAdapters({ mxRecords: [], dialogResults: null });
  const r = await probeEmail({ email: 'x@example.com', adapters });
  assert.equal(r.status, 'unknown');
  assert.match(r.response, /no mx/i);
});

test('probeEmail — MX OK + RCPT 250 → ok', async () => {
  const adapters = makeAdapters({
    mxRecords: [{ exchange: 'mx1.example.com', priority: 10 }],
    dialogResults: { code: 250, response: '250 OK', accepted: true },
  });
  const r = await probeEmail({ email: 'paul@example.com', adapters });
  assert.equal(r.status, 'ok');
  assert.equal(r.code, 250);
  assert.equal(r.mxHost, 'mx1.example.com');
});

test('probeEmail — MX OK + RCPT 550 → rejected', async () => {
  const adapters = makeAdapters({
    mxRecords: [{ exchange: 'mx1.example.com', priority: 10 }],
    dialogResults: { code: 550, response: '550 mailbox unknown', accepted: false },
  });
  const r = await probeEmail({ email: 'fake@example.com', adapters });
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 550);
});

test('probeEmail — RCPT 450 (greylisting) → unknown', async () => {
  const adapters = makeAdapters({
    mxRecords: [{ exchange: 'mx1.example.com', priority: 10 }],
    dialogResults: { code: 450, response: '450 try again', accepted: false },
  });
  const r = await probeEmail({ email: 'paul@example.com', adapters });
  assert.equal(r.status, 'unknown');
  assert.equal(r.code, 450);
});

test('probeEmail — MX prio multiples : tente le 2e si le 1er erreur réseau', async () => {
  const adapters = makeAdapters({
    mxRecords: [
      { exchange: 'mx1.example.com', priority: 10 },
      { exchange: 'mx2.example.com', priority: 20 },
    ],
    dialogResults: [
      new Error('connection refused'),
      { code: 250, response: '250 OK', accepted: true },
    ],
  });
  const r = await probeEmail({ email: 'paul@example.com', adapters });
  assert.equal(r.status, 'ok');
  assert.equal(r.mxHost, 'mx2.example.com');
});

test('probeEmail — MX trié par priorité ascendante', async () => {
  let firstHost;
  const adapters = {
    mxLookup: async () => [
      { exchange: 'mx-low.example.com', priority: 30 },
      { exchange: 'mx-high.example.com', priority: 10 },
    ],
    smtpDialog: async ({ host }) => {
      if (!firstHost) firstHost = host;
      return { code: 250, response: '250 OK', accepted: true };
    },
  };
  await probeEmail({ email: 'paul@example.com', adapters });
  assert.equal(firstHost, 'mx-high.example.com'); // priority 10 first
});

test('probeEmail — MX lookup throw → unknown', async () => {
  const adapters = {
    mxLookup: async () => { throw new Error('ENOTFOUND'); },
    smtpDialog: async () => { throw new Error('should not be called'); },
  };
  const r = await probeEmail({ email: 'x@nodomain.invalid', adapters });
  assert.equal(r.status, 'unknown');
  assert.match(r.response, /mx lookup failed/);
});

test('probeEmail — tous les MX échouent → unknown avec last response', async () => {
  const adapters = makeAdapters({
    mxRecords: [
      { exchange: 'mx1.example.com', priority: 10 },
      { exchange: 'mx2.example.com', priority: 20 },
    ],
    dialogResults: [
      new Error('timeout'),
      new Error('connection reset'),
    ],
  });
  const r = await probeEmail({ email: 'x@example.com', adapters });
  assert.equal(r.status, 'unknown');
  assert.match(r.response, /connection reset|timeout/);
});

test('resolveMxHosts — utilise dnsImpl injecté', async () => {
  const dnsImpl = {
    resolveMx: async (d) => {
      if (d === 'oseys.fr') return [{ exchange: 'aspmx.l.google.com', priority: 1 }];
      return [];
    },
  };
  const r = await resolveMxHosts('oseys.fr', dnsImpl);
  assert.equal(r.length, 1);
  assert.equal(r[0].exchange, 'aspmx.l.google.com');
});

test('resolveMxHosts — sans MX → []', async () => {
  const dnsImpl = { resolveMx: async () => [] };
  const r = await resolveMxHosts('foo.invalid', dnsImpl);
  assert.deepEqual(r, []);
});
