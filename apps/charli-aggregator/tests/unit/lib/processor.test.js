/**
 * Tests — apps/charli-aggregator/lib/processor
 *
 * Logique métier du queue consumer (extraite du wrapper Functions v4 pour
 * être testable sans @azure/functions). Le wrapper src/functions/davidQueueConsumer
 * appelle processQueueItem.
 *
 * Vérifie :
 *   - parseQueueItem : objet, JSON string, base64 JSON, malformé
 *   - isValidEvent : agent/eventType/summary/eventId requis
 *   - message valide (JSON string) → normalize + addMemory appelé
 *   - message valide (objet déjà parsé runtime) → addMemory appelé
 *   - duplicate event_id → skip, addMemory non appelé
 *   - payload malformé → log error, no throw, no addMemory
 *   - shape invalide (eventType manquant) → log error, no throw, no addMemory
 *   - agent inconnu (pas de normalizer) → log error, no throw, no addMemory
 *   - Mem0 addMemory throw → throw bubble pour requeue
 *   - dedup search throw → continue (pas bloquant), addMemory appelé
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  processQueueItem,
  _internals,
} = require('../../../lib/processor');

function makeMcpStub({
  searchResult = { content: [{ type: 'text', text: '[]' }] },
  searchThrows = null,
  addThrows = null,
  capture = [],
} = {}) {
  return {
    searchMemory: async (q, opts) => {
      capture.push({ kind: 'search', q, opts });
      if (searchThrows) throw searchThrows;
      return searchResult;
    },
    addMemory: async (content, metadata) => {
      capture.push({ kind: 'add', content, metadata });
      if (addThrows) throw addThrows;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
}

function makeContext() {
  const logs = { info: [], warn: [], error: [] };
  const log = (m) => logs.info.push(m);
  log.warn = (m) => logs.warn.push(m);
  log.error = (m) => logs.error.push(m);
  return { log, logs };
}

const validEvent = {
  agent: 'david',
  eventType: 'email_sent',
  summary: 'Mail envoyé au dirigeant.',
  eventId: 'evt-1234',
  timestamp: '2026-04-30T10:00:00Z',
  metadata: { dealId: 42 },
};

// ─── parseQueueItem ─────────────────────────────────────────────────────────

test('parseQueueItem — objet déjà parsé : retourné tel quel', () => {
  const obj = { x: 1 };
  assert.equal(_internals.parseQueueItem(obj), obj);
});

test('parseQueueItem — JSON string : parsé', () => {
  assert.deepEqual(_internals.parseQueueItem('{"a":1}'), { a: 1 });
});

test('parseQueueItem — base64 JSON : décodé puis parsé', () => {
  const b64 = Buffer.from(JSON.stringify({ b: 2 })).toString('base64');
  assert.deepEqual(_internals.parseQueueItem(b64), { b: 2 });
});

test('parseQueueItem — string non parsable : null', () => {
  assert.equal(_internals.parseQueueItem('garbage~~not-json-not-base64'), null);
});

test('parseQueueItem — null/undefined/number : null', () => {
  assert.equal(_internals.parseQueueItem(null), null);
  assert.equal(_internals.parseQueueItem(undefined), null);
  assert.equal(_internals.parseQueueItem(42), null);
});

// ─── isValidEvent ───────────────────────────────────────────────────────────

test('isValidEvent — event valide : true', () => {
  assert.equal(_internals.isValidEvent(validEvent), true);
});

test('isValidEvent — manque eventType : false', () => {
  const e = { ...validEvent };
  delete e.eventType;
  assert.equal(_internals.isValidEvent(e), false);
});

test('isValidEvent — manque eventId : false', () => {
  const e = { ...validEvent };
  delete e.eventId;
  assert.equal(_internals.isValidEvent(e), false);
});

// ─── processQueueItem — chemins succès ──────────────────────────────────────

test('processQueueItem — message valide JSON string : normalize + addMemory appelé', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({ capture });
  const ctx = makeContext();
  const out = await processQueueItem(JSON.stringify(validEvent), ctx, { mcpClient });

  assert.equal(out.ok, true);
  assert.equal(out.eventId, 'evt-1234');
  // Pas de duplicate matche, donc add appelé
  const addCall = capture.find(c => c.kind === 'add');
  assert.ok(addCall, 'addMemory appelé');
  assert.equal(addCall.metadata.event_id, 'evt-1234');
  assert.equal(addCall.metadata.agent, 'david');
});

test('processQueueItem — message valide objet (runtime déjà parsé) : addMemory appelé', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({ capture });
  const ctx = makeContext();
  const out = await processQueueItem(validEvent, ctx, { mcpClient });
  assert.equal(out.ok, true);
});

// ─── duplicate ──────────────────────────────────────────────────────────────

test('processQueueItem — duplicate event_id : skip, no addMemory', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({
    capture,
    searchResult: { content: [{ type: 'text', text: JSON.stringify([{ metadata: { event_id: 'evt-1234' } }]) }] },
  });
  const ctx = makeContext();
  const out = await processQueueItem(validEvent, ctx, { mcpClient });

  assert.equal(out.skipped, 'duplicate');
  assert.equal(capture.some(c => c.kind === 'add'), false, 'addMemory NON appelé');
  assert.ok(ctx.logs.info.some(l => /duplicate skipped/.test(l)));
});

// ─── erreurs PERMANENTES : log + no throw ──────────────────────────────────

test('processQueueItem — payload malformé (string non parsable) : log error, no throw, no addMemory', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({ capture });
  const ctx = makeContext();
  const out = await processQueueItem('this is not json or base64', ctx, { mcpClient });
  assert.equal(out.skipped, 'invalid');
  assert.equal(capture.length, 0, 'mcpClient jamais appelé');
  assert.ok(ctx.logs.error.length > 0);
});

test('processQueueItem — shape invalide (manque eventType) : log error, no throw, no addMemory', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({ capture });
  const ctx = makeContext();
  const evt = { ...validEvent };
  delete evt.eventType;
  const out = await processQueueItem(evt, ctx, { mcpClient });
  assert.equal(out.skipped, 'invalid');
  assert.equal(capture.length, 0);
  assert.ok(ctx.logs.error.length > 0);
});

test('processQueueItem — agent inconnu (pas de normalizer) : log error, no throw, no addMemory', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({ capture });
  const ctx = makeContext();
  const evt = { ...validEvent, agent: 'unknown-agent-xyz' };
  const out = await processQueueItem(evt, ctx, { mcpClient });
  assert.equal(out.skipped, 'no-normalizer');
  // Search a été appelé (dedup avant normalize), addMemory NON
  assert.equal(capture.some(c => c.kind === 'add'), false);
  assert.ok(ctx.logs.error.length > 0);
});

// ─── erreur TRANSITOIRE : throw pour requeue ───────────────────────────────

test('processQueueItem — Mem0 addMemory throw : throw bubble pour requeue', async () => {
  const mcpClient = makeMcpStub({ addThrows: new Error('Mem0 service unavailable') });
  const ctx = makeContext();
  await assert.rejects(
    () => processQueueItem(validEvent, ctx, { mcpClient }),
    /Mem0 service unavailable/,
  );
  assert.ok(ctx.logs.error.length > 0);
});

// ─── dedup search transitoire : continue sans bloquer ──────────────────────

test('processQueueItem — dedup search throw : log warn, continue, addMemory appelé', async () => {
  const capture = [];
  const mcpClient = makeMcpStub({
    capture,
    searchThrows: new Error('search throttle'),
  });
  const ctx = makeContext();
  const out = await processQueueItem(validEvent, ctx, { mcpClient });
  assert.equal(out.ok, true);
  assert.ok(capture.some(c => c.kind === 'add'), 'add malgré search throw');
  assert.ok(ctx.logs.warn.some(l => /dedup check failed/.test(l)));
});
