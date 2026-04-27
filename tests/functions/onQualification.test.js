/**
 * Tests unitaires — functions/onQualification (greffe Mem0 D5)
 *
 * Stratégie :
 *   - Handler extractible handleQualification(request, context, deps) dans
 *     l'index.js → deps = { sendMail, getMem0 } injectables.
 *   - Request simulée avec .json() async + .method. Pas d'Azure Functions
 *     runtime réel, pas de réseau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleQualification, buildConsultantMemory } = require('../../src/functions/onQualification');

const BRIEF_COMPLET = {
  nom: 'Morgane Dupont',
  email: 'Morgane.Dupont@oseys.fr',
  offre: 'Accompagnement commercial pour dirigeants de PME',
  entreprise: 'Cabinet Dupont Conseil',
  secteurs: 'services_btb, conseil ; artisanat',
  registre: 'direct_cordial',
  vouvoiement: 'tu',
  exemple_client: 'Cabinet X : +32% CA en 6 mois',
};

function makeRequest({ method = 'POST', body = BRIEF_COMPLET } = {}) {
  return {
    method,
    json: async () => body,
  };
}

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

function makeDeps({ mem0, sendMailResult, sendMailThrows, triggerLeadSelector } = {}) {
  const sendMailCalls = [];
  const sendMail = async (args) => {
    sendMailCalls.push(args);
    if (sendMailThrows) throw sendMailThrows;
    return sendMailResult || { success: true };
  };
  const getMem0 = () => mem0 === undefined ? null : mem0;
  // Neutralise le fire-and-forget Lead Selector par défaut : les tests de
  // ce fichier couvrent handleQualification (Mem0 + sendMail + validation),
  // pas le pipeline Lead Selector. Sans ce stub, defaultTriggerLeadSelector
  // lance une IIFE async qui log des warns sur le context partagé
  // (effectif non mappé, leadBase auth_failed…) et pollue ctxCalls.warn,
  // faussant les assertions sur le warn Mem0. Les tests qui souhaitent
  // vérifier le trigger peuvent toujours passer leur propre implémentation.
  const triggerCalls = [];
  const triggerLeadSelectorStub = triggerLeadSelector || ((args) => {
    triggerCalls.push(args);
  });
  return { sendMail, sendMailCalls, getMem0, triggerLeadSelector: triggerLeadSelectorStub, triggerCalls };
}

function makeMem0Stub({ storeReturns = { id: 'consultant_mem1' }, storeThrows = null } = {}) {
  const calls = [];
  return {
    calls,
    mem0: {
      storeConsultant: async (id, memory) => {
        calls.push({ id, memory });
        if (storeThrows) throw storeThrows;
        return storeReturns;
      },
    },
  };
}

// ──────────────── buildConsultantMemory (pur) ────────────────

test('buildConsultantMemory — mapping complet', () => {
  const m = buildConsultantMemory(BRIEF_COMPLET);
  assert.equal(m.display_name, 'Morgane Dupont');
  assert.equal(m.preferred_tone, 'direct_cordial');
  assert.equal(m.tutoiement, true);
  assert.deepEqual(m.favorite_sectors, ['services_btb', 'conseil', 'artisanat']);
  assert.equal(m.commercial_strategy, 'Accompagnement commercial pour dirigeants de PME');
  assert.deepEqual(m.usable_anecdotes, ['Cabinet X : +32% CA en 6 mois']);
});

test('buildConsultantMemory — secteurs absent : favorite_sectors = []', () => {
  const m = buildConsultantMemory({ ...BRIEF_COMPLET, secteurs: undefined });
  assert.deepEqual(m.favorite_sectors, []);
});

test('buildConsultantMemory — secteurs vide : favorite_sectors = []', () => {
  const m = buildConsultantMemory({ ...BRIEF_COMPLET, secteurs: '' });
  assert.deepEqual(m.favorite_sectors, []);
});

test('buildConsultantMemory — exemple_client absent : usable_anecdotes = []', () => {
  const m = buildConsultantMemory({ ...BRIEF_COMPLET, exemple_client: undefined });
  assert.deepEqual(m.usable_anecdotes, []);
});

test('buildConsultantMemory — vouvoiement "vous" : tutoiement false', () => {
  const m = buildConsultantMemory({ ...BRIEF_COMPLET, vouvoiement: 'vous' });
  assert.equal(m.tutoiement, false);
});

// ──────────────── handleQualification ────────────────

test('handleQualification — brief complet + Mem0 actif : storeConsultant appelé avec consultant_id lowercase et schéma correct', async () => {
  const { mem0, calls: mem0Calls } = makeMem0Stub();
  const deps = makeDeps({ mem0 });
  const { context } = makeContext();

  const res = await handleQualification(makeRequest(), context, deps);

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.match(res.jsonBody.brief_id, /^brief_/);

  assert.equal(deps.sendMailCalls.length, 2);
  assert.equal(mem0Calls.length, 1);
  // email casé est dans le brief en CamelCase, consultant_id doit être lowercase
  assert.equal(mem0Calls[0].id, 'morgane.dupont@oseys.fr');
  assert.deepEqual(mem0Calls[0].memory, buildConsultantMemory(BRIEF_COMPLET));
});

test('handleQualification — secteurs absents : favorite_sectors [] transmis, status 200', async () => {
  const brief = { ...BRIEF_COMPLET };
  delete brief.secteurs;
  const { mem0, calls: mem0Calls } = makeMem0Stub();
  const deps = makeDeps({ mem0 });
  const { context } = makeContext();

  const res = await handleQualification(makeRequest({ body: brief }), context, deps);

  assert.equal(res.status, 200);
  assert.equal(mem0Calls.length, 1);
  assert.deepEqual(mem0Calls[0].memory.favorite_sectors, []);
});

test('handleQualification — exemple_client absent : usable_anecdotes [] transmis', async () => {
  const brief = { ...BRIEF_COMPLET };
  delete brief.exemple_client;
  const { mem0, calls: mem0Calls } = makeMem0Stub();
  const deps = makeDeps({ mem0 });
  const { context } = makeContext();

  const res = await handleQualification(makeRequest({ body: brief }), context, deps);

  assert.equal(res.status, 200);
  assert.deepEqual(mem0Calls[0].memory.usable_anecdotes, []);
});

test('handleQualification — Mem0 storeConsultant retourne null (dégradation) : status 200 quand même', async () => {
  const { mem0 } = makeMem0Stub({ storeReturns: null });
  const deps = makeDeps({ mem0 });
  const { context } = makeContext();

  const res = await handleQualification(makeRequest(), context, deps);

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.ok, true);
});

test('handleQualification — Mem0 storeConsultant throw : warn log + status 200 (best effort)', async () => {
  const { mem0 } = makeMem0Stub({ storeThrows: new Error('mem0 exploded') });
  const deps = makeDeps({ mem0 });
  const { context, calls: ctxCalls } = makeContext();

  const res = await handleQualification(makeRequest(), context, deps);

  assert.equal(res.status, 200);
  assert.equal(ctxCalls.warn.length, 1);
  assert.match(ctxCalls.warn[0][0], /\[mem0\] storeConsultant failed: mem0 exploded/);
});

test('handleQualification — getMem0 retourne null (MEM0_API_KEY absente) : pas d\'appel storeConsultant, status 200', async () => {
  const deps = makeDeps({ mem0: null });
  const { context } = makeContext();

  const res = await handleQualification(makeRequest(), context, deps);

  assert.equal(res.status, 200);
  assert.equal(deps.sendMailCalls.length, 2);
});

test('handleQualification — OPTIONS : retourne 204 sans traitement', async () => {
  const deps = makeDeps({ mem0: null });
  const { context } = makeContext();
  const res = await handleQualification({ method: 'OPTIONS' }, context, deps);
  assert.equal(res.status, 204);
  assert.equal(deps.sendMailCalls.length, 0);
});

test('handleQualification — champs requis manquants : 400 sans appel sendMail ni Mem0', async () => {
  const { mem0, calls: mem0Calls } = makeMem0Stub();
  const deps = makeDeps({ mem0 });
  const { context } = makeContext();
  const res = await handleQualification(makeRequest({ body: { nom: 'X' } }), context, deps);
  assert.equal(res.status, 400);
  assert.match(res.jsonBody.error, /Champs manquants/);
  assert.equal(deps.sendMailCalls.length, 0);
  assert.equal(mem0Calls.length, 0);
});

test('handleQualification — sendMail throw : status 500 (erreur non-Mem0 propagée)', async () => {
  const { mem0 } = makeMem0Stub();
  const deps = makeDeps({ mem0, sendMailThrows: new Error('Graph API 500') });
  const { context } = makeContext();
  const res = await handleQualification(makeRequest(), context, deps);
  assert.equal(res.status, 500);
  assert.match(res.jsonBody.error, /Graph API 500/);
});
