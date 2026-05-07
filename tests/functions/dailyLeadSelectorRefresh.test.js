/**
 * Tests unitaires — functions/dailyLeadSelectorRefresh
 *
 * Couvrent : récupération consultants actifs depuis env vars, post queue
 * pour chaque consultant, comportement quand LEAD_SELECTOR_DISABLED=1,
 * comportement quand aucun consultant n'est configuré, gestion d'erreur
 * du post queue par consultant (ne stoppe pas le batch).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleDailyLeadSelectorRefresh,
  getActiveConsultants,
} = require('../../src/functions/dailyLeadSelectorRefresh');

function makeContext() {
  const calls = { warn: [], error: [], log: [], info: [] };
  return {
    calls,
    context: {
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a),
      log: (...a) => calls.log.push(a),
      info: (...a) => calls.info.push(a),
    },
  };
}

function makeQueueClientStub({ sendMessageThrows = null, throwsForConsultant = null } = {}) {
  const calls = { createIfNotExists: 0, sendMessage: [] };
  return {
    calls,
    factory: () => ({
      createIfNotExists: async () => { calls.createIfNotExists += 1; },
      sendMessage: async (msg) => {
        const decoded = JSON.parse(Buffer.from(msg, 'base64').toString('utf8'));
        calls.sendMessage.push(decoded);
        if (sendMessageThrows) throw sendMessageThrows;
        if (throwsForConsultant && decoded.consultantId === throwsForConsultant) {
          throw new Error('queue post failed');
        }
        return { messageId: `msg-${calls.sendMessage.length}` };
      },
    }),
  };
}

function withEnv(overrides, fn) {
  const original = {};
  for (const [k, v] of Object.entries(overrides)) {
    original[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ──────────────── getActiveConsultants ────────────────

test('getActiveConsultants — 2 env vars présentes : 2 consultants lowercased', () => {
  const result = getActiveConsultants({
    MORGANE_EMAIL: 'M.DEJESSEY@oseys.fr',
    JOHNNY_EMAIL: 'J.SERRA@oseys.fr',
  });
  assert.deepEqual(result, ['m.dejessey@oseys.fr', 'j.serra@oseys.fr']);
});

test('getActiveConsultants — env var manquante : ignorée silencieusement', () => {
  const result = getActiveConsultants({ MORGANE_EMAIL: 'm.dejessey@oseys.fr' });
  assert.deepEqual(result, ['m.dejessey@oseys.fr']);
});

test('getActiveConsultants — env vars vides : tableau vide', () => {
  const result = getActiveConsultants({});
  assert.deepEqual(result, []);
});

test('getActiveConsultants — valeur sans @ : ignorée', () => {
  const result = getActiveConsultants({
    MORGANE_EMAIL: 'pas un email',
    JOHNNY_EMAIL: 'j.serra@oseys.fr',
  });
  assert.deepEqual(result, ['j.serra@oseys.fr']);
});

// ──────────────── handleDailyLeadSelectorRefresh ────────────────

test('handleDailyLeadSelectorRefresh — LEAD_SELECTOR_DISABLED=1 : skip', async () => {
  await withEnv({ LEAD_SELECTOR_DISABLED: '1' }, async () => {
    const { context } = makeContext();
    const result = await handleDailyLeadSelectorRefresh(context);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'disabled');
    assert.equal(result.posted, 0);
  });
});

test('handleDailyLeadSelectorRefresh — aucun consultant actif : skip avec warn', async () => {
  await withEnv(
    { LEAD_SELECTOR_DISABLED: undefined, MORGANE_EMAIL: undefined, JOHNNY_EMAIL: undefined },
    async () => {
      const { context, calls } = makeContext();
      const result = await handleDailyLeadSelectorRefresh(context);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'no_active_consultants');
      assert.equal(calls.warn.length, 1);
    },
  );
});

test('handleDailyLeadSelectorRefresh — 2 consultants : 2 messages postés sur la queue', async () => {
  await withEnv(
    {
      LEAD_SELECTOR_DISABLED: undefined,
      MORGANE_EMAIL: 'm.dejessey@oseys.fr',
      JOHNNY_EMAIL: 'j.serra@oseys.fr',
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
    },
    async () => {
      const { context } = makeContext();
      const queueStub = makeQueueClientStub();
      const result = await handleDailyLeadSelectorRefresh(context, {
        queueClientFactory: queueStub.factory,
      });
      assert.equal(result.posted, 2);
      assert.equal(result.failed, 0);
      assert.equal(queueStub.calls.sendMessage.length, 2);
      const consultantIds = queueStub.calls.sendMessage.map((m) => m.consultantId).sort();
      assert.deepEqual(consultantIds, ['j.serra@oseys.fr', 'm.dejessey@oseys.fr']);
      const sources = queueStub.calls.sendMessage.map((m) => m.source);
      assert.ok(sources.every((s) => s === 'dailyLeadSelectorRefresh'));
      const jobIds = queueStub.calls.sendMessage.map((m) => m.jobId);
      assert.ok(jobIds.every((id) => id.startsWith('daily-')));
    },
  );
});

test('handleDailyLeadSelectorRefresh — 1 consultant échoue : continue les autres + reporte failed', async () => {
  await withEnv(
    {
      LEAD_SELECTOR_DISABLED: undefined,
      MORGANE_EMAIL: 'm.dejessey@oseys.fr',
      JOHNNY_EMAIL: 'j.serra@oseys.fr',
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
    },
    async () => {
      const { context } = makeContext();
      const queueStub = makeQueueClientStub({ throwsForConsultant: 'j.serra@oseys.fr' });
      const result = await handleDailyLeadSelectorRefresh(context, {
        queueClientFactory: queueStub.factory,
      });
      assert.equal(result.posted, 1);
      assert.equal(result.failed, 1);
      assert.equal(result.total, 2);
    },
  );
});

test('handleDailyLeadSelectorRefresh — payload contient batchSize override LEAD_SELECTOR_BATCH_SIZE', async () => {
  await withEnv(
    {
      LEAD_SELECTOR_DISABLED: undefined,
      MORGANE_EMAIL: 'm.dejessey@oseys.fr',
      JOHNNY_EMAIL: undefined,
      LEAD_SELECTOR_BATCH_SIZE: '7',
      AzureWebJobsStorage: 'UseDevelopmentStorage=true',
    },
    async () => {
      const { context } = makeContext();
      const queueStub = makeQueueClientStub();
      await handleDailyLeadSelectorRefresh(context, { queueClientFactory: queueStub.factory });
      assert.equal(queueStub.calls.sendMessage[0].batchSize, 7);
    },
  );
});
