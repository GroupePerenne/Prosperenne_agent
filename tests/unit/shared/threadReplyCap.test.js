'use strict';

/**
 * Tests unitaires — shared/threadReplyCap.js (plan v3.1 Pilier 3).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canReplyToThreadToday,
  incrementThreadReply,
  _setClientForTests,
  _resetForTests,
  _dateKey,
} = require('../../../shared/threadReplyCap');

function mockClient({ getEntity, createEntity, updateEntity }) {
  return {
    getEntity: getEntity || (async () => { const e = new Error('not found'); e.statusCode = 404; throw e; }),
    createEntity: createEntity || (async () => true),
    updateEntity: updateEntity || (async () => true),
  };
}

test.beforeEach(() => { _resetForTests(); });

test('dateKey UTC format YYYYMMDD', () => {
  const d = new Date(Date.UTC(2026, 4, 14, 12, 0, 0));
  assert.equal(_dateKey(d), '20260514');
});

test('canReplyToThreadToday — pas de conversationId → ok no_conversation_id', async () => {
  const r = await canReplyToThreadToday('');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_conversation_id');
});

test('canReplyToThreadToday — Storage indispo → ok no_storage', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await canReplyToThreadToday('conv-123');
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'no_storage');
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});

test('canReplyToThreadToday — entity absente (404) → ok count=0', async () => {
  _setClientForTests(mockClient({}));
  const r = await canReplyToThreadToday('conv-123');
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
});

test('canReplyToThreadToday — count >= max → !ok thread_daily_cap_reached', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: 'conv-123', rowKey: '20260514', count: 1 }),
  }));
  const r = await canReplyToThreadToday('conv-123', { maxPerDay: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'thread_daily_cap_reached');
});

test('canReplyToThreadToday — count < max → ok', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: 'conv-123', rowKey: '20260514', count: 0 }),
  }));
  const r = await canReplyToThreadToday('conv-123', { maxPerDay: 1 });
  assert.equal(r.ok, true);
});

test('canReplyToThreadToday — maxPerDay=3, count=2 → ok', async () => {
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: 'conv-123', rowKey: '20260514', count: 2 }),
  }));
  const r = await canReplyToThreadToday('conv-123', { maxPerDay: 3 });
  assert.equal(r.ok, true);
});

test('incrementThreadReply — entity absente → création count=1', async () => {
  let created = null;
  _setClientForTests(mockClient({
    createEntity: async (e) => { created = e; return true; },
  }));
  const r = await incrementThreadReply('conv-123');
  assert.equal(r.count, 1);
  assert.equal(created.partitionKey, 'conv-123');
  assert.equal(created.count, 1);
});

test('incrementThreadReply — entity existe → +1', async () => {
  let updated = null;
  _setClientForTests(mockClient({
    getEntity: async () => ({ partitionKey: 'conv-123', rowKey: '20260514', count: 1, etag: 'W/"abc"' }),
    updateEntity: async (e) => { updated = e; return true; },
  }));
  const r = await incrementThreadReply('conv-123');
  assert.equal(r.count, 2);
  assert.equal(updated.count, 2);
});

test('incrementThreadReply — pas de conversationId → null', async () => {
  const r = await incrementThreadReply('');
  assert.equal(r, null);
});

test('incrementThreadReply — Storage indispo → null', async () => {
  _resetForTests();
  const previous = process.env.AzureWebJobsStorage;
  delete process.env.AzureWebJobsStorage;
  try {
    const r = await incrementThreadReply('conv-123');
    assert.equal(r, null);
  } finally {
    if (previous !== undefined) process.env.AzureWebJobsStorage = previous;
  }
});
