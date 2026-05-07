'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pMapLimit } = require('../../../shared/utils/p-map-limit');

test('pMapLimit: items vide → []', async () => {
  const out = await pMapLimit([], 3, async (x) => x * 2);
  assert.deepEqual(out, []);
});

test('pMapLimit: concurrency=1 séquentiel, ordre conservé', async () => {
  const order = [];
  const items = [10, 20, 30];
  const out = await pMapLimit(items, 1, async (x) => {
    order.push(x);
    await new Promise((r) => setTimeout(r, 10));
    return x * 2;
  });
  assert.deepEqual(out, [20, 40, 60]);
  assert.deepEqual(order, [10, 20, 30]);
});

test('pMapLimit: ordre des résultats conservé même avec parallélisme', async () => {
  const items = [50, 5, 30, 1, 20];
  const out = await pMapLimit(items, 3, async (x) => {
    await new Promise((r) => setTimeout(r, x));
    return x * 10;
  });
  assert.deepEqual(out, [500, 50, 300, 10, 200]);
});

test('pMapLimit: concurrency=3 plus rapide que séquentiel', async () => {
  const items = [50, 50, 50, 50, 50, 50];
  const tStart = Date.now();
  await pMapLimit(items, 3, async () => {
    await new Promise((r) => setTimeout(r, 50));
    return 1;
  });
  const elapsed = Date.now() - tStart;
  // Séquentiel = 6 × 50ms = 300ms. Concurrency 3 = 2 vagues × 50ms = 100ms.
  // Marge généreuse pour l'event loop.
  assert.ok(elapsed < 200, `expected <200ms, got ${elapsed}ms`);
});

test('pMapLimit: fn throw → result.error, ne stoppe pas les autres', async () => {
  const items = [1, 2, 3];
  const out = await pMapLimit(items, 2, async (x) => {
    if (x === 2) throw new Error('boom');
    return x * 10;
  });
  assert.equal(out[0], 10);
  assert.ok(out[1] && out[1].error instanceof Error);
  assert.equal(out[1].error.message, 'boom');
  assert.equal(out[2], 30);
});

test('pMapLimit: concurrency > items.length → cap à items.length', async () => {
  const items = [1, 2];
  const out = await pMapLimit(items, 100, async (x) => x + 1);
  assert.deepEqual(out, [2, 3]);
});

test('pMapLimit: fn reçoit (item, idx)', async () => {
  const items = ['a', 'b', 'c'];
  const out = await pMapLimit(items, 2, async (item, idx) => `${item}-${idx}`);
  assert.deepEqual(out, ['a-0', 'b-1', 'c-2']);
});
