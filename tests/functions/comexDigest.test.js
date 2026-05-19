'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleComexDigest } = require('../../src/functions/comexDigest');

function makeContext() {
  const logs = [];
  const ctx = {
    log: (...args) => logs.push(['log', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };
  ctx._logs = logs;
  return ctx;
}

test('handleComexDigest envoie le mail avec récap formaté', async () => {
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  process.env.COMEX_EMAIL = 'direction@oseys.fr';
  const sent = [];
  await handleComexDigest({}, makeContext(), {
    readMetrics: async () => [
      { date: getYesterdayIso(), consultant: 'morgane', martin_sent: 3, mila_sent: 2, replies: 1 },
      { date: getYesterdayIso(), consultant: 'johnny', martin_sent: 0, mila_sent: 4, replies: 0, rdv_set: 0 },
    ],
    sendMail: async (m) => { sent.push(m); return { ok: true }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'david@oseys.fr');
  assert.equal(sent[0].to, 'direction@oseys.fr');
  assert.match(sent[0].subject, /Récap COMEX Pérenne/);
  assert.ok(sent[0].html.includes('Morgane'));
  assert.ok(sent[0].html.includes('Johnny'));
});

test('handleComexDigest envoie même si zéro data (état initial pilote)', async () => {
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  const sent = [];
  await handleComexDigest({}, makeContext(), {
    readMetrics: async () => [],
    sendMail: async (m) => { sent.push(m); return { ok: true }; },
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes('Aucune activité'));
});

test('handleComexDigest abort si DAVID_EMAIL absent', async () => {
  delete process.env.DAVID_EMAIL;
  const sent = [];
  await handleComexDigest({}, makeContext(), {
    readMetrics: async () => [],
    sendMail: async (m) => { sent.push(m); return { ok: true }; },
  });
  assert.equal(sent.length, 0);
});

test('handleComexDigest n est PAS bloqué par DAILY_REPORT_ENABLED (envoi inconditionnel COMEX)', async () => {
  // À la différence de dailyReport, le récap COMEX doit partir même si le
  // pilote n est pas encore activé. Cela permet à Paul/Constantin d avoir
  // un signal "pilote en sommeil" et de vérifier l infrastructure.
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  delete process.env.DAILY_REPORT_ENABLED;
  const sent = [];
  await handleComexDigest({}, makeContext(), {
    readMetrics: async () => [],
    sendMail: async (m) => { sent.push(m); return { ok: true }; },
  });
  assert.equal(sent.length, 1);
});

test('handleComexDigest catch erreur sendMail sans throw', async () => {
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  await assert.doesNotReject(() => handleComexDigest({}, makeContext(), {
    readMetrics: async () => [],
    sendMail: async () => { throw new Error('SMTP timeout'); },
  }));
});

function getYesterdayIso() {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}
