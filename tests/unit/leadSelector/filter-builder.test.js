/**
 * Tests unitaires — shared/adapters/leadbase/leadbase-table.js
 *
 * Validation de la construction des filtres OData et du partitionnement >50 NAF.
 * Aucun appel réseau : tableClient injecté.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LeadBaseAdapter,
  LeadBaseError,
  buildFilter,
  _internals,
} = require('../../../shared/adapters/leadbase/leadbase-table');

// ─── buildFilter ─────────────────────────────────────────────────────────────

test('buildFilter — 1 NAF, 1 effectif, sans département', () => {
  const f = buildFilter({ nafCodes: ['62.02A'], effectifCodes: ['11'] });
  assert.equal(f, "codeNaf eq '62.02A' and trancheEffectif eq '11'");
});

test('buildFilter — N NAF, N effectif, N départements (parenthèses OR)', () => {
  const f = buildFilter({
    nafCodes: ['62.02A', '62.01Z'],
    effectifCodes: ['11', '12'],
    departements: ['75', '92', '93'],
  });
  assert.equal(
    f,
    "(PartitionKey eq '75' or PartitionKey eq '92' or PartitionKey eq '93')"
    + " and (codeNaf eq '62.02A' or codeNaf eq '62.01Z')"
    + " and (trancheEffectif eq '11' or trancheEffectif eq '12')"
  );
});

test('buildFilter — sans départements : pas de clause PartitionKey', () => {
  const f = buildFilter({ nafCodes: ['62.02A'], effectifCodes: ['11', '12'] });
  assert.ok(!f.includes('PartitionKey'));
  assert.match(f, /trancheEffectif eq '11' or trancheEffectif eq '12'/);
});

test('buildFilter — départements vide [] équivalent à absent', () => {
  const f = buildFilter({ nafCodes: ['62.02A'], effectifCodes: ['11'], departements: [] });
  assert.equal(f, "codeNaf eq '62.02A' and trancheEffectif eq '11'");
});

test('buildFilter — escape des apostrophes (sécurité injection)', () => {
  // Si jamais une valeur contient une apostrophe (cas très improbable sur du NAF),
  // elle doit être échappée par doublement.
  const f = buildFilter({ nafCodes: ["12.34'X"], effectifCodes: ['11'] });
  assert.equal(f, "codeNaf eq '12.34''X' and trancheEffectif eq '11'");
});

// ─── chunk ───────────────────────────────────────────────────────────────────

test('chunk — splitting tableau en blocs de taille N', () => {
  const arr = Array.from({ length: 125 }, (_, i) => `code-${i}`);
  const out = _internals.chunk(arr, 50);
  assert.equal(out.length, 3);
  assert.equal(out[0].length, 50);
  assert.equal(out[1].length, 50);
  assert.equal(out[2].length, 25);
});

test('chunk — tableau vide → []', () => {
  assert.deepEqual(_internals.chunk([], 50), []);
});

// ─── LeadBaseAdapter.queryLeads — mocked tableClient ─────────────────────────

function makeMockClient(rowsByCallOrFilter) {
  const calls = [];
  return {
    calls,
    listEntities: ({ queryOptions }) => {
      calls.push(queryOptions.filter);
      const rows = typeof rowsByCallOrFilter === 'function'
        ? rowsByCallOrFilter(queryOptions.filter, calls.length - 1)
        : (rowsByCallOrFilter[queryOptions.filter] || []);
      return (async function* () {
        for (const r of rows) yield r;
      })();
    },
  };
}

test('queryLeads — empty nafCodes → return [] sans appel client', async () => {
  const mock = makeMockClient(() => []);
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  const out = await adapter.queryLeads({ nafCodes: [], effectifCodes: ['11'] });
  assert.deepEqual(out, []);
  assert.equal(mock.calls.length, 0);
});

test('queryLeads — empty effectifCodes → fallback sur 11/12/21', async () => {
  const mock = makeMockClient(() => []);
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  await adapter.queryLeads({ nafCodes: ['62.02A'], effectifCodes: [] });
  assert.equal(mock.calls.length, 1);
  assert.match(
    mock.calls[0],
    /\(trancheEffectif eq '11' or trancheEffectif eq '12' or trancheEffectif eq '21'\)/,
  );
});

test('queryLeads — 1 chunk si <= 50 NAF', async () => {
  const mock = makeMockClient(() => [
    { siren: '111', nom: 'A' },
    { siren: '222', nom: 'B' },
  ]);
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  const out = await adapter.queryLeads({
    nafCodes: ['62.02A', '62.01Z'],
    effectifCodes: ['11'],
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(out.length, 2);
});

test('queryLeads — partitionnement si > 50 NAF + dédup par SIREN', async () => {
  const nafCodes = Array.from({ length: 120 }, (_, i) =>
    `${String(10 + Math.floor(i / 26)).padStart(2, '0')}.${String((i % 90) + 10).padStart(2, '0')}A`,
  );

  let callIdx = 0;
  const mock = makeMockClient(() => {
    callIdx++;
    // Chaque chunk renvoie 2 entités, dont une commune entre tous les chunks
    return [
      { siren: 'COMMON', nom: 'Acme commune' },
      { siren: `S-${callIdx}`, nom: `Co ${callIdx}` },
    ];
  });
  const adapter = new LeadBaseAdapter({ tableClient: mock });

  const out = await adapter.queryLeads({ nafCodes, effectifCodes: ['11'] });
  assert.equal(mock.calls.length, 3); // 120 / 50 = 3 chunks (50+50+20)
  // 1 entrée COMMON dédupliquée + 3 entrées uniques par chunk = 4 entités
  assert.equal(out.length, 4);
  assert.ok(out.some((e) => e.siren === 'COMMON'));
});

test('queryLeads — hardLimit borne le résultat', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ siren: `S${i}`, nom: `Co ${i}` }));
  const mock = makeMockClient(() => rows);
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  const out = await adapter.queryLeads({
    nafCodes: ['62.02A'],
    effectifCodes: ['11'],
    hardLimit: 10,
  });
  assert.equal(out.length, 10);
});

test('queryLeads — error 404 → LeadBaseError code=table_missing', async () => {
  const mock = {
    listEntities: () =>
      (async function* () {
        const err = new Error('not found');
        err.statusCode = 404;
        throw err;
      })(),
  };
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  await assert.rejects(
    () => adapter.queryLeads({ nafCodes: ['62.02A'], effectifCodes: ['11'] }),
    (err) => err instanceof LeadBaseError && err.code === 'table_missing',
  );
});

test('queryLeads — error 403 → LeadBaseError code=auth_failed', async () => {
  const mock = {
    listEntities: () =>
      (async function* () {
        const err = new Error('forbidden');
        err.statusCode = 403;
        throw err;
      })(),
  };
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  await assert.rejects(
    () => adapter.queryLeads({ nafCodes: ['62.02A'], effectifCodes: ['11'] }),
    (err) => err instanceof LeadBaseError && err.code === 'auth_failed',
  );
});

test('queryLeads — error 503 → LeadBaseError code=transient', async () => {
  const mock = {
    listEntities: () =>
      (async function* () {
        const err = new Error('service unavailable');
        err.statusCode = 503;
        throw err;
      })(),
  };
  const adapter = new LeadBaseAdapter({ tableClient: mock });
  await assert.rejects(
    () => adapter.queryLeads({ nafCodes: ['62.02A'], effectifCodes: ['11'] }),
    (err) => err instanceof LeadBaseError && err.code === 'transient',
  );
});

test('queryLeads — logger reçoit info structurée à la fin', async () => {
  const mock = makeMockClient(() => [{ siren: '1' }, { siren: '2' }]);
  const events = [];
  const logger = { info: (msg, payload) => events.push({ msg, payload }) };
  const adapter = new LeadBaseAdapter({ tableClient: mock, logger });
  await adapter.queryLeads({ nafCodes: ['62.02A'], effectifCodes: ['11'], departements: ['75'] });
  const ev = events.find((e) => e.msg.includes('queryLeads'));
  assert.ok(ev, 'no queryLeads info log');
  assert.equal(ev.payload.nafCount, 1);
  assert.equal(ev.payload.effectifCount, 1);
  assert.equal(ev.payload.departements, 1);
  assert.equal(ev.payload.resultCount, 2);
  assert.equal(ev.payload.chunks, 1);
});
