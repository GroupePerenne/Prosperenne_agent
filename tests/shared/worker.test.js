/**
 * Tests unitaires — shared/worker.js (greffes Mem0)
 *
 * On ne teste pas bootstrapSequence end-to-end (trop de dépendances externes :
 * Pipedrive, Anthropic, Graph, Queue). On teste le helper pur
 * resolveMem0Enrichments qui porte la logique Mem0 ajoutée par D2.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMem0Enrichments, sendFuzzyMatchEscalation } = require('../../shared/worker');

function makeMem0Stub({ prospectResult = [], patternResult = [] } = {}) {
  const calls = { retrieveProspect: [], retrievePatterns: [] };
  const mem0 = {
    retrieveProspect: async (siren) => {
      calls.retrieveProspect.push(siren);
      return prospectResult;
    },
    retrievePatterns: async (ctx) => {
      calls.retrievePatterns.push(ctx);
      return patternResult;
    }
  };
  return { mem0, calls };
}

function makeContext() {
  const warnings = [];
  const logs = [];
  return {
    warnings,
    logs,
    context: {
      warn: (msg) => warnings.push(msg),
      log: (msg) => logs.push(msg)
    }
  };
}

test('resolveMem0Enrichments — lead.siren présent : retrieveProspect et retrievePatterns appelés, pas de warn', async () => {
  const { mem0, calls } = makeMem0Stub({
    prospectResult: [{ id: 'p1', memory: 'mem prospect' }],
    patternResult: [{ id: 'pat1', memory: 'mem pattern' }]
  });
  const { context, warnings } = makeContext();

  const res = await resolveMem0Enrichments({
    mem0,
    lead: { siren: '852115740', email: 'contact@acme.fr', secteur: 'services_btb' },
    context
  });

  assert.deepEqual(calls.retrieveProspect, ['852115740']);
  assert.deepEqual(calls.retrievePatterns, [{ sector: 'services_btb' }]);
  assert.deepEqual(res.prospectMemories, [{ id: 'p1', memory: 'mem prospect' }]);
  assert.deepEqual(res.patternMemories, [{ id: 'pat1', memory: 'mem pattern' }]);
  assert.equal(warnings.length, 0);
});

test('resolveMem0Enrichments — lead.siren absent : retrieveProspect skippé, retrievePatterns appelé, warn émis avec email du lead', async () => {
  const { mem0, calls } = makeMem0Stub({ patternResult: [{ id: 'pat1' }] });
  const { context, warnings } = makeContext();

  const res = await resolveMem0Enrichments({
    mem0,
    lead: { email: 'inconnu@example.fr', secteur: 'conseil' },
    context
  });

  assert.equal(calls.retrieveProspect.length, 0);
  assert.equal(calls.retrievePatterns.length, 1);
  assert.deepEqual(calls.retrievePatterns[0], { sector: 'conseil' });
  assert.deepEqual(res.prospectMemories, []);
  assert.deepEqual(res.patternMemories, [{ id: 'pat1' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[mem0\] prospect retrieve skipped: no SIREN for lead inconnu@example\.fr/);
});

test('resolveMem0Enrichments — mem0 null → [] pour les deux, aucun warn, aucun throw', async () => {
  const { context, warnings } = makeContext();
  const res = await resolveMem0Enrichments({
    mem0: null,
    lead: { email: 'x@y.com' },
    context
  });
  assert.deepEqual(res, { prospectMemories: [], patternMemories: [] });
  assert.equal(warnings.length, 0);
});

test('resolveMem0Enrichments — lead.siren et lead.email absents : warn tombe sur "(no email)"', async () => {
  const { mem0 } = makeMem0Stub();
  const { context, warnings } = makeContext();

  await resolveMem0Enrichments({ mem0, lead: {}, context });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no SIREN for lead \(no email\)/);
});

test('resolveMem0Enrichments — context.warn absent, fallback sur context.log', async () => {
  const { mem0 } = makeMem0Stub();
  const logs = [];
  const context = { log: (msg) => logs.push(msg) };
  await resolveMem0Enrichments({ mem0, lead: { email: 'a@b.fr' }, context });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /prospect retrieve skipped/);
});

test('resolveMem0Enrichments — context absent : pas de throw, comportement identique', async () => {
  const { mem0, calls } = makeMem0Stub({ patternResult: [] });
  const res = await resolveMem0Enrichments({ mem0, lead: { siren: '123', secteur: 'conseil' } });
  assert.deepEqual(calls.retrieveProspect, ['123']);
  assert.deepEqual(res, { prospectMemories: [], patternMemories: [] });
});

// ──────────────── 4.5 bis Item 2 — sendFuzzyMatchEscalation ────────────────

function makeSendMailStub({ throws } = {}) {
  const calls = [];
  const sendMail = async (args) => {
    calls.push(args);
    if (throws) throw throws;
    return { success: true };
  };
  return { sendMail, calls };
}

function makeWarnContext() {
  const warnings = [];
  return {
    warnings,
    context: { warn: (m) => warnings.push(m) },
  };
}

const FUZZY_LEAD = {
  prenom: 'Marc',
  nom: 'Durand',
  entreprise: 'ACME SAS',
  email: 'marc@acme.fr',
};

test('sendFuzzyMatchEscalation — deal.user_id.email présent : mail envoyé direct au consultant owner', async () => {
  const prev = { david: process.env.DAVID_EMAIL, dom: process.env.PIPEDRIVE_COMPANY_DOMAIN };
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  process.env.PIPEDRIVE_COMPANY_DOMAIN = 'oseys';
  const { sendMail, calls } = makeSendMailStub();
  try {
    const fuzzyDeal = { id: 111, user_id: { id: 5, email: 'morgane@oseys.fr', name: 'Morgane Dupont' } };
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: FUZZY_LEAD, deps: { sendMail },
    });
    assert.equal(res.sent, true);
    assert.equal(res.to, 'morgane@oseys.fr');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, 'morgane@oseys.fr');
    assert.match(calls[0].subject, /\[David\] Prospect déjà en suivi : ACME SAS/);
    assert.match(calls[0].html, /Bonjour Morgane/);
    assert.match(calls[0].html, /Marc Durand/);
    assert.match(calls[0].html, /marc@acme\.fr/);
    assert.match(calls[0].html, /oseys\.pipedrive\.com\/deal\/111/);
  } finally {
    if (prev.david !== undefined) process.env.DAVID_EMAIL = prev.david;
    if (prev.dom !== undefined) process.env.PIPEDRIVE_COMPANY_DOMAIN = prev.dom;
  }
});

test('sendFuzzyMatchEscalation — deal.user_id.email absent, fallback getUserEmail(id)', async () => {
  const prev = process.env.DAVID_EMAIL;
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  const { sendMail, calls } = makeSendMailStub();
  try {
    const fuzzyDeal = { id: 222, user_id: { id: 7, name: 'Johnny Serra' } };
    const pipedriveMod = { getUserEmail: async (id) => (id === 7 ? 'johnny@oseys.fr' : null) };
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: FUZZY_LEAD, deps: { sendMail, pipedriveMod },
    });
    assert.equal(res.sent, true);
    assert.equal(res.to, 'johnny@oseys.fr');
    assert.match(calls[0].html, /Bonjour Johnny/);
  } finally {
    if (prev !== undefined) process.env.DAVID_EMAIL = prev;
  }
});

test('sendFuzzyMatchEscalation — owner non résolvable : fallback direction@oseys.fr + subject non attribuable', async () => {
  const prev = { david: process.env.DAVID_EMAIL, esc: process.env.ESCALATION_EMAIL };
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  delete process.env.ESCALATION_EMAIL;
  const { sendMail, calls } = makeSendMailStub();
  try {
    const fuzzyDeal = { id: 333, user_id: { id: 999 } };    // pas d'email, getUserEmail retourne null
    const pipedriveMod = { getUserEmail: async () => null };
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: FUZZY_LEAD, deps: { sendMail, pipedriveMod },
    });
    assert.equal(res.sent, true);
    assert.equal(res.to, 'direction@oseys.fr');
    assert.equal(res.unattributable, true);
    assert.match(calls[0].subject, /\[David\] Escalation non attribuable : ACME SAS/);
    assert.match(calls[0].html, /Intervention humaine requise/);
  } finally {
    if (prev.david !== undefined) process.env.DAVID_EMAIL = prev.david;
    if (prev.esc !== undefined) process.env.ESCALATION_EMAIL = prev.esc;
  }
});

test('sendFuzzyMatchEscalation — ESCALATION_EMAIL env override utilisé', async () => {
  const prev = { david: process.env.DAVID_EMAIL, esc: process.env.ESCALATION_EMAIL };
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  process.env.ESCALATION_EMAIL = 'escalation-test@oseys.fr';
  const { sendMail, calls } = makeSendMailStub();
  try {
    const fuzzyDeal = { id: 444 };   // pas de user_id du tout
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: FUZZY_LEAD, deps: { sendMail, pipedriveMod: { getUserEmail: async () => null } },
    });
    assert.equal(res.to, 'escalation-test@oseys.fr');
    assert.equal(calls[0].to, 'escalation-test@oseys.fr');
  } finally {
    if (prev.david !== undefined) process.env.DAVID_EMAIL = prev.david;
    if (prev.esc !== undefined) process.env.ESCALATION_EMAIL = prev.esc;
    else delete process.env.ESCALATION_EMAIL;
  }
});

test('sendFuzzyMatchEscalation — sendMail throw : warn log + sent:false, pas de propagation', async () => {
  const prev = process.env.DAVID_EMAIL;
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  const { sendMail } = makeSendMailStub({ throws: new Error('Graph 500') });
  const { context, warnings } = makeWarnContext();
  try {
    const fuzzyDeal = { id: 555, user_id: { id: 5, email: 'm@oseys.fr' } };
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: FUZZY_LEAD, deps: { sendMail }, context,
    });
    assert.equal(res.sent, false);
    assert.match(res.error, /Graph 500/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[dedup\] escalation email failed: Graph 500/);
  } finally {
    if (prev !== undefined) process.env.DAVID_EMAIL = prev;
  }
});

test('sendFuzzyMatchEscalation — entreprise ou fields manquants sur lead : pas de throw (HTML escape)', async () => {
  const prev = process.env.DAVID_EMAIL;
  process.env.DAVID_EMAIL = 'david@oseys.fr';
  const { sendMail, calls } = makeSendMailStub();
  try {
    const fuzzyDeal = { id: 666, user_id: { email: 'o@oseys.fr', name: '' } };
    const res = await sendFuzzyMatchEscalation({
      fuzzyDeal, lead: { email: 'x@y.fr' }, deps: { sendMail },
    });
    assert.equal(res.sent, true);
    assert.match(calls[0].subject, /\[David\] Prospect déjà en suivi :/);
    assert.match(calls[0].html, /Bonjour équipe/);   // fallback sans prenom
  } finally {
    if (prev !== undefined) process.env.DAVID_EMAIL = prev;
  }
});
