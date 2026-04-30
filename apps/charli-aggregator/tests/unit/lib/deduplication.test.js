/**
 * Tests — apps/charli-aggregator/lib/deduplication
 *
 * Vérifie :
 *   - eventId vide/null : false (pas de check)
 *   - searchMemory throws : bubble up vers le caller (processor décide)
 *   - result vide : false
 *   - result avec match metadata.event_id : true
 *   - result sans match (autre event_id) : false
 *   - format alternatif { results: [...] } : true si match
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isDuplicateEvent } = require('../../../lib/deduplication');

function makeMcpClientStub({ searchResult = null, searchThrows = null, capture = [] } = {}) {
  return {
    searchMemory: async (query, opts) => {
      capture.push({ query, opts });
      if (searchThrows) throw searchThrows;
      return searchResult;
    },
  };
}

function mcpResult(items) {
  return { content: [{ type: 'text', text: JSON.stringify(items) }] };
}

// ─── Cas trivials ───────────────────────────────────────────────────────────

test('isDuplicateEvent — eventId null : false (pas d\'appel search)', async () => {
  const capture = [];
  const stub = makeMcpClientStub({ capture });
  const out = await isDuplicateEvent(stub, null);
  assert.equal(out, false);
  assert.equal(capture.length, 0);
});

test('isDuplicateEvent — eventId vide : false (pas d\'appel search)', async () => {
  const capture = [];
  const stub = makeMcpClientStub({ capture });
  const out = await isDuplicateEvent(stub, '');
  assert.equal(out, false);
  assert.equal(capture.length, 0);
});

// ─── search throw : graceful ────────────────────────────────────────────────

test('isDuplicateEvent — searchMemory throws : bubble up vers le caller', async () => {
  const stub = makeMcpClientStub({ searchThrows: new Error('Mem0 throttling') });
  await assert.rejects(() => isDuplicateEvent(stub, 'evt-123'), /Mem0 throttling/);
});

// ─── Match / no match ───────────────────────────────────────────────────────

test('isDuplicateEvent — match metadata.event_id : true', async () => {
  const stub = makeMcpClientStub({
    searchResult: mcpResult([{ id: 'mem-1', metadata: { event_id: 'evt-123', other: 'x' } }]),
  });
  const out = await isDuplicateEvent(stub, 'evt-123');
  assert.equal(out, true);
});

test('isDuplicateEvent — pas de match (autre event_id retourné) : false', async () => {
  const stub = makeMcpClientStub({
    searchResult: mcpResult([{ id: 'mem-1', metadata: { event_id: 'evt-other' } }]),
  });
  const out = await isDuplicateEvent(stub, 'evt-123');
  assert.equal(out, false);
});

test('isDuplicateEvent — résultat vide : false', async () => {
  const stub = makeMcpClientStub({ searchResult: mcpResult([]) });
  const out = await isDuplicateEvent(stub, 'evt-123');
  assert.equal(out, false);
});

test('isDuplicateEvent — format alternatif { results: [...] } : true si match', async () => {
  const stub = makeMcpClientStub({
    searchResult: mcpResult({ results: [{ id: 'mem-1', metadata: { event_id: 'evt-A' } }] }),
  });
  const out = await isDuplicateEvent(stub, 'evt-A');
  assert.equal(out, true);
});

test('isDuplicateEvent — query et filters passés correctement à searchMemory', async () => {
  const capture = [];
  const stub = makeMcpClientStub({ capture, searchResult: mcpResult([]) });
  await isDuplicateEvent(stub, 'evt-XYZ');
  assert.equal(capture.length, 1);
  assert.equal(capture[0].query, 'evt-XYZ');
  assert.deepEqual(capture[0].opts.filters, { event_id: 'evt-XYZ' });
  assert.equal(capture[0].opts.topK, 1);
});

test('isDuplicateEvent — résultat null/malformé : false (graceful)', async () => {
  const stub1 = makeMcpClientStub({ searchResult: null });
  const stub2 = makeMcpClientStub({ searchResult: { content: null } });
  const stub3 = makeMcpClientStub({ searchResult: { content: [{ type: 'text', text: 'not-json' }] } });
  assert.equal(await isDuplicateEvent(stub1, 'evt-1'), false);
  assert.equal(await isDuplicateEvent(stub2, 'evt-1'), false);
  assert.equal(await isDuplicateEvent(stub3, 'evt-1'), false);
});
