/**
 * Tests unitaires — functions/dailyDigest (Phase C Niveau 2 — David vers Charli)
 *
 * Stratégie :
 *   - Handler `handleDailyDigest(myTimer, context, deps)` exporté avec
 *     dependencies injectables (`consultants`, `findPipedriveUserId`,
 *     `fetchConsultantMetrics`, `writeDailyMetricsToTable`, `reportToCharli`).
 *   - Pas d'Azure Functions runtime réel, pas de réseau, pas de Pipedrive,
 *     pas de Table Storage.
 *   - Vigilance ordre handler (CHARLI v1.5 §10) : test #9 vérifie que
 *     writeDailyMetricsToTable est appelé AVANT reportToCharli.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleDailyDigest,
  aggregateMetrics,
  buildDigestSummary,
  writeDailyMetricsToTable,
} = require('../../src/functions/dailyDigest');

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeContext() {
  const calls = { warn: [], error: [], log: [] };
  return {
    calls,
    context: {
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a),
      log: (...a) => calls.log.push(a),
    },
  };
}

function makeDeps({
  consultants = [{ email: 'morgane@oseys.fr', prenom: 'morgane' }],
  findUserIdReturn = 42,
  metricsReturn = { martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 1, rdvSet: 0 },
  writeResult = { ok: true, written: 1 },
  writeThrows = null,
  reportResult = { ok: true, eventId: 'evt-1' },
  metricsThrows = null,
  callOrder = null,
} = {}) {
  const findCalls = [];
  const metricsCalls = [];
  const writeCalls = [];
  const reportCalls = [];
  return {
    findCalls, metricsCalls, writeCalls, reportCalls,
    deps: {
      consultants,
      findPipedriveUserId: async (email) => {
        findCalls.push(email);
        return typeof findUserIdReturn === 'function' ? findUserIdReturn(email) : findUserIdReturn;
      },
      fetchConsultantMetrics: async (userId, dateISO) => {
        metricsCalls.push({ userId, dateISO });
        if (metricsThrows) throw metricsThrows;
        if (typeof metricsReturn === 'function') {
          const r = metricsReturn(userId);
          if (r && r.__throw) throw new Error(r.__throw);
          return r;
        }
        return metricsReturn;
      },
      writeDailyMetricsToTable: async (per, date, ctx) => {
        if (callOrder) callOrder.push('write');
        writeCalls.push({ per, date });
        if (writeThrows) throw writeThrows;
        return writeResult;
      },
      reportToCharli: async (event, ctx) => {
        if (callOrder) callOrder.push('report');
        reportCalls.push({ event });
        return reportResult;
      },
    },
  };
}

// ─── aggregateMetrics ──────────────────────────────────────────────────────

test('aggregateMetrics — somme correcte multi-consultants', () => {
  const agg = aggregateMetrics([
    { consultant: 'morgane', martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 1, rdvSet: 0 },
    { consultant: 'johnny', martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 1, rdvSet: 1 },
  ]);
  assert.equal(agg.total_sent, 22);
  assert.equal(agg.martin_sent, 10);
  assert.equal(agg.mila_sent, 12);
  assert.equal(agg.total_opens, 10);
  assert.equal(agg.martin_opens, 4);
  assert.equal(agg.mila_opens, 6);
  assert.equal(agg.replies, 2);
  assert.equal(agg.rdv_set, 1);
});

// ─── buildDigestSummary ────────────────────────────────────────────────────

test('buildDigestSummary — narratif standard non vide jour normal', () => {
  const agg = aggregateMetrics([
    { consultant: 'morgane', martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 1, rdvSet: 0 },
    { consultant: 'johnny', martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 0, rdvSet: 1 },
  ]);
  const summary = buildDigestSummary(agg, ['morgane', 'johnny'], '2026-04-30');
  assert.match(summary, /30\/04\/2026/);
  assert.match(summary, /22 envois/);
  assert.match(summary, /Morgane et Johnny/);
  assert.match(summary, /1 réponse/);
  assert.match(summary, /1 RDV/);
});

test('buildDigestSummary — narratif jour creux honnête (tous zéros)', () => {
  const agg = aggregateMetrics([
    { consultant: 'morgane', martinSent: 0, milaSent: 0, martinOpens: 0, milaOpens: 0, replies: 0, rdvSet: 0 },
  ]);
  const summary = buildDigestSummary(agg, ['morgane'], '2026-04-30');
  assert.match(summary, /aucune activité/i);
  assert.doesNotMatch(summary, /\bcatastrophe\b|\binquiétant\b|\béchec\b/i);
});

// ─── writeDailyMetricsToTable ──────────────────────────────────────────────

test('writeDailyMetricsToTable — upsertEntity PK=YYYY-MM, RK=date_consultant pour chaque consultant', async () => {
  const upsertCalls = [];
  const tableClient = {
    upsertEntity: async (entity, mode) => { upsertCalls.push({ entity, mode }); },
  };
  const perConsultant = [
    { consultant: 'morgane', martinSent: 5, milaSent: 6, martinOpens: 2, milaOpens: 3, replies: 1, rdvSet: 0 },
    { consultant: 'johnny', martinSent: 4, milaSent: 7, martinOpens: 1, milaOpens: 2, replies: 0, rdvSet: 1 },
  ];
  const res = await writeDailyMetricsToTable(perConsultant, '2026-04-30', null, tableClient);
  assert.equal(res.ok, true);
  assert.equal(res.written, 2);
  assert.equal(upsertCalls.length, 2);
  assert.equal(upsertCalls[0].entity.partitionKey, '2026-04');
  assert.equal(upsertCalls[0].entity.rowKey, '2026-04-30_morgane');
  assert.equal(upsertCalls[1].entity.rowKey, '2026-04-30_johnny');
  assert.equal(upsertCalls[0].mode, 'Replace');
  assert.equal(upsertCalls[0].entity.martin_sent, 5);
  assert.equal(upsertCalls[0].entity.total_opens, 5);
  assert.equal(upsertCalls[0].entity.agent, 'david');
});

test('writeDailyMetricsToTable — fail-open si tableClient throw, log warn', async () => {
  const tableClient = {
    upsertEntity: async () => { throw new Error('table down'); },
  };
  const { context, calls } = makeContext();
  const perConsultant = [
    { consultant: 'morgane', martinSent: 5, milaSent: 0, martinOpens: 0, milaOpens: 0, replies: 0, rdvSet: 0 },
  ];
  const res = await writeDailyMetricsToTable(perConsultant, '2026-04-30', context, tableClient);
  assert.equal(res.ok, false);
  assert.equal(res.written, 0);
  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0][0], /\[dailyDigest\] writeDailyMetricsToTable failed for morgane/);
});

// ─── handleDailyDigest ─────────────────────────────────────────────────────

test('handleDailyDigest — appelle reportToCharli avec event shape Option B correct', async () => {
  const { deps, reportCalls } = makeDeps();
  const { context } = makeContext();
  await handleDailyDigest({}, context, deps);
  assert.equal(reportCalls.length, 1);
  const event = reportCalls[0].event;
  assert.equal(event.agent, 'david');
  assert.equal(event.eventType, 'daily_digest');
  assert.equal(typeof event.summary, 'string');
  assert.ok(event.summary.length > 20);
  assert.equal(event.metadata.event_type, 'daily_digest');
  assert.equal(event.metadata.source, 'david-pipeline');
  assert.equal(event.metadata.agent, 'david');
  assert.match(event.metadata.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(event.metadata.consultants_actifs, ['morgane']);
  assert.equal(event.metadata.metrics.total_sent, 11);
  assert.equal(event.metadata.per_consultant.length, 1);
  assert.equal(event.metadata.per_consultant[0].consultant, 'morgane');
});

test('handleDailyDigest — fail-open si reportToCharli {ok:false}, ne throw pas', async () => {
  const { deps } = makeDeps({ reportResult: { ok: false, error: 'queue down' } });
  const { context, calls } = makeContext();
  await assert.doesNotReject(() => handleDailyDigest({}, context, deps));
  assert.ok(
    calls.warn.some((w) => /reportToCharli failed: queue down/.test(w[0])),
    `attendu warn reportToCharli failed, reçu warns: ${JSON.stringify(calls.warn)}`,
  );
});

test('handleDailyDigest — digest dégradé si Pipedrive partial fail (1 consultant throw)', async () => {
  const { deps, reportCalls } = makeDeps({
    consultants: [
      { email: 'morgane@oseys.fr', prenom: 'morgane' },
      { email: 'johnny@oseys.fr', prenom: 'johnny' },
    ],
    findUserIdReturn: (email) => email.includes('morgane') ? 42 : 99,
    metricsReturn: (userId) => userId === 99
      ? { __throw: 'Pipedrive 500 Johnny' }
      : { martinSent: 3, milaSent: 4, martinOpens: 1, milaOpens: 2, replies: 0, rdvSet: 0 },
  });
  const { context, calls } = makeContext();
  await handleDailyDigest({}, context, deps);
  assert.equal(reportCalls.length, 1);
  assert.deepEqual(reportCalls[0].event.metadata.consultants_actifs, ['morgane']);
  assert.ok(
    calls.warn.some((w) => /metrics partial fail pour johnny/.test(w[0])),
    `attendu warn metrics partial fail johnny, reçu warns: ${JSON.stringify(calls.warn)}`,
  );
});

test('handleDailyDigest — séquence stricte write Table puis reportToCharli (ordre testé)', async () => {
  const callOrder = [];
  const { deps } = makeDeps({ callOrder });
  const { context } = makeContext();
  await handleDailyDigest({}, context, deps);
  assert.deepEqual(
    callOrder,
    ['write', 'report'],
    `ordre attendu ['write','report'], reçu ${JSON.stringify(callOrder)}`,
  );
});
