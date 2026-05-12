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

// Tests handleDailyDigest reposent sur le flag DAILY_REPORT_ENABLED=1 (cf.
// décision Paul 1er mai 2026 PM : le digest skip silencieusement si flag à 0
// pour éviter les mails vides avant démarrage pilote opérationnel).
process.env.DAILY_REPORT_ENABLED = '1';

const {
  handleDailyDigest,
  aggregateMetrics,
  buildDigestSummary,
  writeDailyMetricsToTable,
  fetchConsultantMetrics,
  loadPipelineDealsIndex,
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
  consultants = [{ email: 'morgane@oseys.fr', prenom: 'morgane', fullName: 'Morgane DE JESSEY' }],
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
      // Nouvelle signature post-fix 12 mai 2026 : (consultantFullName, dateISO).
      // Cf. dailyDigest.js fetchConsultantMetrics — attribution par titre deal.
      fetchConsultantMetrics: async (consultantFullName, dateISO) => {
        metricsCalls.push({ consultantFullName, dateISO });
        if (metricsThrows) throw metricsThrows;
        if (typeof metricsReturn === 'function') {
          const r = metricsReturn(consultantFullName);
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
      { email: 'morgane@oseys.fr', prenom: 'morgane', fullName: 'Morgane DE JESSEY' },
      { email: 'johnny@oseys.fr', prenom: 'johnny', fullName: 'Johnny SERRA' },
    ],
    findUserIdReturn: (email) => email.includes('morgane') ? 42 : 99,
    metricsReturn: (fullName) => /johnny/i.test(fullName)
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

// ─── fetchConsultantMetrics (refonte 12 mai 2026 — attribution par titre deal)─
//
// Diagnostic (cf. handover Paul 12 mai 2026 PM) :
//   - Pipedrive en prod OSEYS remappe `type:'email'` source → `appel_de_relance`
//   - Owner deals + activités = David (30884421), pas le consultant
//   - Attribution réelle au consultant = parsing du titre du deal
//
// Helper minimal pour simuler le client Pipedrive injecté via opts.pipedriveCall.

function makePipedriveStub({ activities = [], dealsByPipeline = {}, dealsByStage = {} } = {}) {
  const calls = [];
  return {
    calls,
    pipedriveCall: async (path, query = {}) => {
      calls.push({ path, query });
      if (path === '/activities') {
        return activities;
      }
      if (path === '/deals' && query.pipeline_id) {
        return dealsByPipeline[query.pipeline_id] || [];
      }
      if (path === '/deals' && query.stage_id) {
        return dealsByStage[query.stage_id] || [];
      }
      return [];
    },
  };
}

test('fetchConsultantMetrics — compte les envois Martin sur activités appel_de_relance owner David', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE DE POSE NORMANDE', pipeline_id: 28 },
    { id: 1002, title: 'Morgane DE JESSEY → ENTREPRISE DURAND', pipeline_id: 28 },
    { id: 1003, title: 'Johnny SERRA → CHRISTIAN NEVEU ELECTRICITE', pipeline_id: 28 },
  ];
  const activities = [
    // 2 envois Martin sur deals Morgane (owner David user_id=30884421, type appel_de_relance)
    { id: 1, type: 'appel_de_relance', subject: '[Martin] J0 — Bonjour', deal_id: 1001, user_id: 30884421 },
    { id: 2, type: 'appel_de_relance', subject: '[Martin] J14 — Relance', deal_id: 1002, user_id: 30884421 },
    // 1 envoi Mila sur deal Morgane
    { id: 3, type: 'appel_de_relance', subject: '[Mila] J0 — Bonjour', deal_id: 1002, user_id: 30884421 },
    // 1 envoi Martin sur deal Johnny — NE DOIT PAS compter pour Morgane
    { id: 4, type: 'appel_de_relance', subject: '[Martin] J0 — Bonjour', deal_id: 1003, user_id: 30884421 },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 2, 'devrait compter 2 envois Martin sur Morgane');
  assert.equal(m.milaSent, 1, 'devrait compter 1 envoi Mila sur Morgane');
});

test('fetchConsultantMetrics — scoping consultant : titre Johnny ne compte pas pour Morgane', async () => {
  const dealsP28 = [
    { id: 1003, title: 'Johnny SERRA → CHRISTIAN NEVEU ELECTRICITE', pipeline_id: 28 },
  ];
  const activities = [
    { id: 10, type: 'appel_de_relance', subject: '[Martin] J0 — Bonjour', deal_id: 1003, user_id: 30884421 },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 0);
  assert.equal(m.milaSent, 0);
});

test('fetchConsultantMetrics — accepte les deux types email et appel_de_relance (back-compat tenant)', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28 },
  ];
  const activities = [
    { id: 1, type: 'email', subject: '[Martin] J0 — Bonjour', deal_id: 1001 },
    { id: 2, type: 'appel_de_relance', subject: '[Martin] J14 — Relance', deal_id: 1001 },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 2, 'compte les deux types (email legacy + appel_de_relance prod)');
});

test('fetchConsultantMetrics — types non supportés ignorés (meeting, call)', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28 },
  ];
  const activities = [
    { id: 1, type: 'meeting', subject: '[Martin] RDV', deal_id: 1001 },
    { id: 2, type: 'call', subject: '[Mila] Appel', deal_id: 1001 },
    { id: 3, type: 'task', subject: '[Martin] Todo', deal_id: 1001 },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 0);
  assert.equal(m.milaSent, 0);
});

test('fetchConsultantMetrics — activité sur deal hors pipeline cible : ignorée', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28 },
    // Deal 1099 dans un AUTRE pipeline mais titre contenant "Morgane" → pas dans index P28
  ];
  const activities = [
    // deal_id=1099 inconnu de l'index P28 → ignoré
    { id: 1, type: 'appel_de_relance', subject: '[Martin] J0', deal_id: 1099 },
    // deal_id=1001 dans P28 → compté
    { id: 2, type: 'appel_de_relance', subject: '[Martin] J0', deal_id: 1001 },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 1);
});

test('fetchConsultantMetrics — activité sans deal_id : ignorée', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28 },
  ];
  const activities = [
    { id: 1, type: 'appel_de_relance', subject: '[Martin] J0', deal_id: null },
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities,
    dealsByPipeline: { 28: dealsP28 },
  });
  const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
    pipelineId: 28,
    pipedriveCall,
  });
  assert.equal(m.martinSent, 0);
});

test('fetchConsultantMetrics — pipeline ID absent retourne zéro (garde-fou)', async () => {
  const { pipedriveCall } = makePipedriveStub({ activities: [] });
  const prevPipeline = process.env.PIPEDRIVE_PIPELINE_ID;
  delete process.env.PIPEDRIVE_PIPELINE_ID;
  try {
    const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', { pipedriveCall });
    assert.equal(m.martinSent, 0);
    assert.equal(m.milaSent, 0);
  } finally {
    if (prevPipeline) process.env.PIPEDRIVE_PIPELINE_ID = prevPipeline;
  }
});

test('fetchConsultantMetrics — compte replies (stage replied) et rdvSet (stage rdv_set) avec matching par titre', async () => {
  const dealsP28 = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28 },
  ];
  const dealsRepliedStage = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28, update_time: '2026-05-11 12:30:00' },
  ];
  const dealsRdvStage = [
    { id: 1001, title: 'Morgane DE JESSEY → SOCIETE X', pipeline_id: 28, update_time: '2026-05-11 14:00:00' },
    { id: 1004, title: 'Johnny SERRA → AUTRE', pipeline_id: 28, update_time: '2026-05-11 10:00:00' }, // doit être ignoré
  ];
  const { pipedriveCall } = makePipedriveStub({
    activities: [],
    dealsByPipeline: { 28: dealsP28 },
    dealsByStage: { 254: dealsRepliedStage, 257: dealsRdvStage },
  });
  const prevReplied = process.env.PIPEDRIVE_STAGE_REPLIED;
  const prevQualified = process.env.PIPEDRIVE_STAGE_QUALIFIED;
  const prevRdv = process.env.PIPEDRIVE_STAGE_RDV_SET;
  process.env.PIPEDRIVE_STAGE_REPLIED = '254';
  delete process.env.PIPEDRIVE_STAGE_QUALIFIED;
  process.env.PIPEDRIVE_STAGE_RDV_SET = '257';
  try {
    const m = await fetchConsultantMetrics('Morgane DE JESSEY', '2026-05-11', {
      pipelineId: 28,
      pipedriveCall,
    });
    assert.equal(m.replies, 1, 'doit compter 1 reply sur stage replied');
    assert.equal(m.rdvSet, 1, 'doit compter 1 rdvSet (Morgane), Johnny ignoré');
  } finally {
    if (prevReplied) process.env.PIPEDRIVE_STAGE_REPLIED = prevReplied; else delete process.env.PIPEDRIVE_STAGE_REPLIED;
    if (prevQualified) process.env.PIPEDRIVE_STAGE_QUALIFIED = prevQualified;
    if (prevRdv) process.env.PIPEDRIVE_STAGE_RDV_SET = prevRdv; else delete process.env.PIPEDRIVE_STAGE_RDV_SET;
  }
});

test('loadPipelineDealsIndex — itère sur la pagination Pipedrive (multi-pages)', async () => {
  let page = 0;
  const pipedriveCall = async (path, query) => {
    assert.equal(path, '/deals');
    assert.equal(query.pipeline_id, 28);
    page++;
    if (page === 1) {
      // page 1 pleine (500 items simulés par 2 pour test rapide → on simule plein avec limit=2)
      // En vrai limit=500, on simule juste qu'on a "limit" items pour déclencher la page 2
      const arr = [];
      for (let i = 0; i < query.limit; i++) {
        arr.push({ id: query.start + i + 1, title: `Deal ${query.start + i + 1}`, pipeline_id: 28 });
      }
      return arr;
    }
    // page 2 partielle → stop
    return [{ id: 9999, title: 'Last deal', pipeline_id: 28 }];
  };
  const index = await loadPipelineDealsIndex(28, pipedriveCall);
  // 500 + 1 = 501 deals
  assert.equal(index.size, 501);
  assert.ok(index.has(9999));
});
