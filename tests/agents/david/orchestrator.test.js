/**
 * Tests unitaires — agents/david/orchestrator.js (greffes Mem0 D4)
 *
 * On ne teste PAS handleProspectReply end-to-end (il appelle Pipedrive,
 * Graph, Queue). On teste les helpers extraits par D4 qui portent la
 * nouvelle logique Mem0 :
 *   - persistInboundProspect : décisions de store (skip/no-siren/bounce)
 *   - resolveSirenForOrg     : remontée SIREN via Pipedrive (avec stub)
 *
 * Les sous-fonctions handlePositive/Question/etc. n'ont pas été touchées
 * par D4, elles sont couvertes par les tests d'intégration (étape 5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  persistInboundProspect,
  resolveSirenForOrg,
  checkLeadCooldown,
  pickMostRecent,
  resolveOrCreateDeal,
} = require('../../../agents/david/orchestrator');

function makeMem0Stub({ storeReturns = { id: 'm1' } } = {}) {
  const calls = [];
  return {
    calls,
    mem0: {
      storeProspect: async (siren, memory) => {
        calls.push({ siren, memory });
        return storeReturns;
      },
    },
  };
}

function makeContext() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    context: {
      warn: (m) => warnings.push(m),
      log: (m) => logs.push(m),
    },
  };
}

// ──────────────── persistInboundProspect ────────────────

test('persistInboundProspect — siren + mem0 actif → storeProspect appelé avec le bon SIREN et schéma correct', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '852115740',
    prospectClass: 'positive',
    fromAddress: 'm.durand@acme.fr',
    confidence: 0.92,
    decision: { resume_humain: 'intéressé, demande RDV' },
    context,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].siren, '852115740');
  assert.equal(calls[0].memory.company_name, null);
  const hist = calls[0].memory.interaction_history;
  assert.equal(hist.length, 1);
  assert.match(hist[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(hist[0].type, 'email_received');
  assert.equal(hist[0].class, 'positive');
  assert.equal(hist[0].confidence, 0.92);
  assert.equal(hist[0].summary, 'intéressé, demande RDV');
  assert.equal(res.stored, true);
  assert.equal(res.siren, '852115740');
});

test('persistInboundProspect — siren absent → pas de store, warn émis avec fromAddress', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context, warnings } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: null,
    prospectClass: 'question',
    fromAddress: 'contact@inconnu.fr',
    confidence: 0.8,
    decision: { resume_humain: 'demande un devis' },
    context,
  });

  assert.equal(calls.length, 0);
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'no_siren');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[mem0\] prospect store skipped: no SIREN for inbound contact@inconnu\.fr/);
});

test('persistInboundProspect — prospectClass bounce → skip silencieux (pas de store, pas de warn)', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context, warnings } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '852115740',          // SIREN présent mais pas exploitable sur bounce
    prospectClass: 'bounce',
    fromAddress: 'postmaster@example.com',
    confidence: 1.0,
    decision: { resume_humain: 'NDR' },
    context,
  });

  assert.equal(calls.length, 0);
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'bounce_skipped');
  assert.equal(warnings.length, 0);
});

test('persistInboundProspect — mem0 storeProspect retourne null (dégradation 429/timeout) : stored=false, pas de throw', async () => {
  const { mem0 } = makeMem0Stub({ storeReturns: null });
  const { context } = makeContext();

  const res = await persistInboundProspect({
    mem0,
    siren: '123456789',
    prospectClass: 'neutre',
    fromAddress: 'x@y.fr',
    confidence: 0.75,
    decision: { resume_humain: 'ok merci' },
    context,
  });

  assert.equal(res.stored, false);
  assert.equal(res.siren, '123456789');
});

test('persistInboundProspect — decision.resume_humain absent : fallback decision.summary puis chaîne vide, pas de throw', async () => {
  const { mem0, calls } = makeMem0Stub();
  const { context } = makeContext();

  // fallback sur decision.summary
  await persistInboundProspect({
    mem0, siren: '111', prospectClass: 'neutre', fromAddress: 'a@b.fr',
    confidence: 0.9, decision: { summary: 'fallback ok' }, context,
  });
  assert.equal(calls[0].memory.interaction_history[0].summary, 'fallback ok');

  // fallback ultime : chaîne vide
  await persistInboundProspect({
    mem0, siren: '222', prospectClass: 'neutre', fromAddress: 'c@d.fr',
    confidence: 0.9, decision: {}, context,
  });
  assert.equal(calls[1].memory.interaction_history[0].summary, '');

  // decision null : toujours pas de throw, summary = ''
  await persistInboundProspect({
    mem0, siren: '333', prospectClass: 'neutre', fromAddress: 'e@f.fr',
    confidence: 0.9, decision: null, context,
  });
  assert.equal(calls[2].memory.interaction_history[0].summary, '');
});

test('persistInboundProspect — mem0 null : retourne reason=mem0_off, aucun appel', async () => {
  const { context } = makeContext();
  const res = await persistInboundProspect({
    mem0: null,
    siren: '999',
    prospectClass: 'positive',
    fromAddress: 'a@b.fr',
    confidence: 0.9,
    decision: { resume_humain: 'x' },
    context,
  });
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'mem0_off');
});

// ──────────────── resolveSirenForOrg ────────────────

test('resolveSirenForOrg — orgId null → null, pas d\'appel Pipedrive', async () => {
  let called = false;
  const pipedriveMod = { getOrganization: async () => { called = true; return {}; } };
  const res = await resolveSirenForOrg(null, { pipedriveMod });
  assert.equal(res, null);
  assert.equal(called, false);
});

test('resolveSirenForOrg — env PIPEDRIVE_ORG_FIELD_SIREN absente → null, pas d\'appel', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  try {
    let called = false;
    const pipedriveMod = { getOrganization: async () => { called = true; return { abc: '123' }; } };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, null);
    assert.equal(called, false);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
  }
});

test('resolveSirenForOrg — field présent → valeur retournée en string', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  try {
    const pipedriveMod = {
      getOrganization: async (id) => ({ id, name: 'ACME', hash_siren_xyz: 852115740 }),
    };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, '852115740');
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});

test('resolveSirenForOrg — field vide sur l\'org → null', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  try {
    const pipedriveMod = { getOrganization: async () => ({ name: 'ACME' }) };
    const res = await resolveSirenForOrg(42, { pipedriveMod });
    assert.equal(res, null);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});

test('resolveSirenForOrg — Pipedrive throw → null + warn log, pas de propagation', async () => {
  const prev = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  process.env.PIPEDRIVE_ORG_FIELD_SIREN = 'hash_siren_xyz';
  const { context, warnings } = makeContext();
  try {
    const pipedriveMod = { getOrganization: async () => { throw new Error('Pipedrive down'); } };
    const res = await resolveSirenForOrg(42, { context, pipedriveMod });
    assert.equal(res, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[mem0\] siren lookup failed for org 42.*Pipedrive down/);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_ORG_FIELD_SIREN = prev;
    else delete process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  }
});

// ──────────────── 4.5 bis Item 1 — resolveOrCreateDeal ────────────────

function makeInfoContext() {
  const infos = [];
  const warnings = [];
  return {
    infos,
    warnings,
    context: {
      info: (m) => infos.push(m),
      warn: (m) => warnings.push(m),
      log: (m) => infos.push(m),
    },
  };
}

test('resolveOrCreateDeal — aucun deal ouvert existant → createDeal appelé normalement', async () => {
  const createCalls = [];
  const pipedriveMod = {
    findOpenDealsForPersonInOurPipe: async () => [],
    createDeal: async (args) => {
      createCalls.push(args);
      return { id: 999, title: args.title, stage_id: 1 };
    },
  };
  const { context } = makeInfoContext();
  const res = await resolveOrCreateDeal({
    consultant: { nom: 'Morgane' },
    lead: { entreprise: 'ACME' },
    agentKey: 'martin',
    person: { id: 42 },
    org: { id: 7 },
    context,
    pipedriveMod,
  });
  assert.equal(res.reused, false);
  assert.equal(res.deal.id, 999);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].personId, 42);
  assert.equal(createCalls[0].orgId, 7);
  assert.equal(createCalls[0].agent, 'martin');
});

test('resolveOrCreateDeal — 1 deal ouvert existant → skip createDeal, retourne le deal existant, log info', async () => {
  const createCalls = [];
  const existing = [{ id: 555, update_time: '2026-04-20 10:00:00', stage_id: 3 }];
  const pipedriveMod = {
    findOpenDealsForPersonInOurPipe: async () => existing,
    createDeal: async (args) => { createCalls.push(args); return { id: 999 }; },
  };
  const { context, infos, warnings } = makeInfoContext();
  const res = await resolveOrCreateDeal({
    consultant: { nom: 'Morgane' },
    lead: { entreprise: 'ACME' },
    agentKey: 'mila',
    person: { id: 42 },
    org: { id: 7 },
    context,
    pipedriveMod,
  });
  assert.equal(res.reused, true);
  assert.equal(res.deal.id, 555);
  assert.equal(createCalls.length, 0);
  assert.equal(warnings.length, 0);
  assert.equal(infos.length, 1);
  assert.match(infos[0], /\[dedup\] skipping createDeal: existing open deal 555 for person 42/);
});

test('resolveOrCreateDeal — plusieurs deals ouverts → warn + prend le plus récent (update_time DESC)', async () => {
  const existing = [
    { id: 111, update_time: '2026-04-10 09:00:00' },
    { id: 222, update_time: '2026-04-21 15:30:00' },  // plus récent
    { id: 333, update_time: '2026-04-15 12:00:00' },
  ];
  const pipedriveMod = {
    findOpenDealsForPersonInOurPipe: async () => existing,
    createDeal: async () => { throw new Error('should not be called'); },
  };
  const { context, warnings, infos } = makeInfoContext();
  const res = await resolveOrCreateDeal({
    consultant: { nom: 'M' }, lead: { entreprise: 'X' }, agentKey: 'martin',
    person: { id: 42 }, org: { id: 7 }, context, pipedriveMod,
  });
  assert.equal(res.reused, true);
  assert.equal(res.deal.id, 222);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[dedup\] 3 open deals for person 42 — taking most recent/);
  assert.equal(infos.length, 1);
  assert.match(infos[0], /existing open deal 222/);
});

test('pickMostRecent — fallback sur add_time si update_time absent', () => {
  const res = pickMostRecent([
    { id: 1, add_time: '2026-04-10 09:00:00' },
    { id: 2, add_time: '2026-04-20 15:00:00' },
  ]);
  assert.equal(res.id, 2);
});

// ──────────────── 4.5 bis Item 3 — checkLeadCooldown ────────────────

test('checkLeadCooldown — env vars non configurées : skip false, aucun appel Pipedrive', async () => {
  const prev = {
    opt: process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL,
    retry: process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER,
  };
  delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  try {
    let called = false;
    const pipedriveMod = { findOpenDealsForPersonInOurPipe: async () => { called = true; return []; } };
    const res = await checkLeadCooldown(42, { pipedriveMod });
    assert.deepEqual(res, { skip: false });
    assert.equal(called, false);
  } finally {
    if (prev.opt !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev.opt;
    if (prev.retry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = prev.retry;
  }
});

test('checkLeadCooldown — personId null : skip false sans appel', async () => {
  let called = false;
  const pipedriveMod = { findOpenDealsForPersonInOurPipe: async () => { called = true; return []; } };
  const res = await checkLeadCooldown(null, { pipedriveMod });
  assert.deepEqual(res, { skip: false });
  assert.equal(called, false);
});

test('checkLeadCooldown — opt_out_until = 9999-12-31 → skip permanent opt_out + log info', async () => {
  const prev = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  const { context, infos } = makeInfoContext();
  try {
    const pipedriveMod = {
      findOpenDealsForPersonInOurPipe: async () => [{ id: 1, update_time: '2026-01-01', field_optout: '9999-12-31' }],
    };
    const res = await checkLeadCooldown(42, { context, pipedriveMod });
    assert.equal(res.skip, true);
    assert.equal(res.reason, 'opt_out');
    assert.equal(res.until, '9999-12-31');
    assert.equal(infos.length, 1);
    assert.match(infos[0], /\[dedup\] skipping permanent opt-out: person 42 until 9999-12-31/);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  }
});

test('checkLeadCooldown — retry_available_after > today → skip cooldown + log avec last_agent', async () => {
  const prev = {
    retry: process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER,
    last: process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED,
  };
  process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = 'field_retry';
  process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED = 'field_last';
  const { context, infos } = makeInfoContext();
  try {
    const future = '2099-12-31';
    const pipedriveMod = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 1, update_time: '2026-04-01', field_retry: future, field_last: 'martin' },
      ],
    };
    const res = await checkLeadCooldown(42, { context, pipedriveMod });
    assert.equal(res.skip, true);
    assert.equal(res.reason, 'cooldown');
    assert.equal(res.until, future);
    assert.equal(res.lastAgent, 'martin');
    assert.match(infos[0], /skipping cooldown: person 42 until 2099-12-31, last_agent=martin/);
  } finally {
    if (prev.retry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = prev.retry;
    else delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
    if (prev.last !== undefined) process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED = prev.last;
    else delete process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED;
  }
});

test('checkLeadCooldown — date passée dans les champs → flow normal (skip false)', async () => {
  const prev = {
    opt: process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL,
    retry: process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER,
  };
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = 'field_retry';
  try {
    const pipedriveMod = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 1, update_time: '2025-01-01', field_optout: '2020-01-01', field_retry: '2020-06-01' },
      ],
    };
    const res = await checkLeadCooldown(42, { pipedriveMod });
    assert.deepEqual(res, { skip: false });
  } finally {
    if (prev.opt !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev.opt;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
    if (prev.retry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = prev.retry;
    else delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  }
});

test('checkLeadCooldown — les deux champs actifs : opt_out prioritaire sur retry', async () => {
  const prev = {
    opt: process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL,
    retry: process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER,
  };
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = 'field_retry';
  try {
    const pipedriveMod = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 1, update_time: '2026-04-20', field_optout: '9999-12-31', field_retry: '2099-06-01' },
      ],
    };
    const res = await checkLeadCooldown(42, { pipedriveMod });
    assert.equal(res.skip, true);
    assert.equal(res.reason, 'opt_out');     // pas 'cooldown'
    assert.equal(res.until, '9999-12-31');
  } finally {
    if (prev.opt !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev.opt;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
    if (prev.retry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = prev.retry;
    else delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  }
});

test('checkLeadCooldown — opt_out sur deal ancien, retry libre sur deal récent : opt_out sticky wins', async () => {
  const prev = {
    opt: process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL,
    retry: process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER,
  };
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = 'field_retry';
  try {
    const pipedriveMod = {
      findOpenDealsForPersonInOurPipe: async () => [
        { id: 2, update_time: '2026-04-20' },                                   // récent, pas d'opt-out
        { id: 1, update_time: '2025-08-01', field_optout: '9999-12-31' },       // ancien, opt-out
      ],
    };
    const res = await checkLeadCooldown(42, { pipedriveMod });
    assert.equal(res.skip, true);
    assert.equal(res.reason, 'opt_out');
  } finally {
    if (prev.opt !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev.opt;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
    if (prev.retry !== undefined) process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER = prev.retry;
    else delete process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  }
});

test('checkLeadCooldown — aucun deal trouvé : skip false', async () => {
  const prev = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  try {
    const pipedriveMod = { findOpenDealsForPersonInOurPipe: async () => [] };
    const res = await checkLeadCooldown(42, { pipedriveMod });
    assert.deepEqual(res, { skip: false });
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  }
});

test('checkLeadCooldown — Pipedrive throw : warn + skip false (best effort, on ne bloque pas)', async () => {
  const prev = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = 'field_optout';
  const { context, warnings } = makeInfoContext();
  try {
    const pipedriveMod = { findOpenDealsForPersonInOurPipe: async () => { throw new Error('Pipedrive 500'); } };
    const res = await checkLeadCooldown(42, { context, pipedriveMod });
    assert.deepEqual(res, { skip: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cooldown check failed for person 42.*Pipedrive 500/);
  } finally {
    if (prev !== undefined) process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL = prev;
    else delete process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  }
});
