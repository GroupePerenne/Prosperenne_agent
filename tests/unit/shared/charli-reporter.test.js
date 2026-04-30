/**
 * Tests — shared/charli-reporter
 *
 * Vérifie :
 *   - validation/normalisation event (agent, eventType, summary requis)
 *   - eventId UUID v4 auto-généré si absent
 *   - timestamp ISO auto-généré si absent
 *   - eventId/timestamp/metadata fournis sont préservés
 *   - succès : message base64 JSON envoyé sur la queue, ok=true
 *   - fire-and-forget : queue down → ok=false, ne lève pas, log warn
 *   - fire-and-forget : event invalide → ok=false, ne lève pas
 *   - ctx.log.warn utilisé si fourni, fallback console.warn sinon
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reportToCharli,
  _internals,
} = require('../../../shared/charli-reporter');

function makeQueueClientStub({ shouldThrow = null, captured = [] } = {}) {
  return {
    sendMessage: async (msg) => {
      if (shouldThrow) throw shouldThrow;
      captured.push(msg);
      return { messageId: `fake-${captured.length}`, popReceipt: 'fake-receipt' };
    },
  };
}

// ─── buildPayload — validation et normalisation ─────────────────────────────

test('buildPayload — event minimal valide retourne payload complet avec eventId UUID + timestamp ISO', () => {
  const before = Date.now();
  const out = _internals.buildPayload({
    agent: 'david',
    eventType: 'qualif_done',
    summary: 'Le dirigeant de SIREN 12345678901234 a été qualifié niveau 2 le 2026-04-30.',
  });
  const after = Date.now();

  assert.equal(out.agent, 'david');
  assert.equal(out.eventType, 'qualif_done');
  assert.equal(out.summary.startsWith('Le dirigeant'), true);
  assert.match(out.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const ts = new Date(out.timestamp).getTime();
  assert.ok(Number.isFinite(ts) && ts >= before && ts <= after, 'timestamp ISO récent');
  assert.deepEqual(out.metadata, {});
});

test('buildPayload — eventId, timestamp, metadata fournis sont préservés tels quels', () => {
  const out = _internals.buildPayload({
    agent: 'alicia',
    eventType: 'rdv_booked',
    summary: 'RDV pris',
    eventId: 'fixed-id-abc',
    timestamp: '2026-04-30T15:00:00.000Z',
    metadata: { dealId: 42, consultant: 'morgane' },
  });

  assert.equal(out.eventId, 'fixed-id-abc');
  assert.equal(out.timestamp, '2026-04-30T15:00:00.000Z');
  assert.deepEqual(out.metadata, { dealId: 42, consultant: 'morgane' });
});

test('buildPayload — event null/non-objet/manquant lève une erreur explicite', () => {
  assert.throws(() => _internals.buildPayload(null), /event must be an object/);
  assert.throws(() => _internals.buildPayload(undefined), /event must be an object/);
  assert.throws(() => _internals.buildPayload('string'), /event must be an object/);
  assert.throws(() => _internals.buildPayload({ eventType: 'x', summary: 'y' }), /event\.agent/);
  assert.throws(() => _internals.buildPayload({ agent: 'd', summary: 'y' }), /event\.eventType/);
  assert.throws(() => _internals.buildPayload({ agent: 'd', eventType: 'x' }), /event\.summary/);
});

// ─── reportToCharli — succès ─────────────────────────────────────────────────

test('reportToCharli — succès : message base64 JSON envoyé, ok=true, eventId retourné', async () => {
  const captured = [];
  _internals.setClientForTests(makeQueueClientStub({ captured }));
  try {
    const out = await reportToCharli({
      agent: 'david',
      eventType: 'email_sent',
      summary: 'Email J0 envoyé au dirigeant SIREN 12345678901234.',
      metadata: { dealId: 42 },
    });

    assert.equal(out.ok, true);
    assert.match(out.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(captured.length, 1);

    const decoded = JSON.parse(Buffer.from(captured[0], 'base64').toString('utf8'));
    assert.equal(decoded.agent, 'david');
    assert.equal(decoded.eventType, 'email_sent');
    assert.equal(decoded.summary.startsWith('Email J0'), true);
    assert.equal(decoded.eventId, out.eventId);
    assert.deepEqual(decoded.metadata, { dealId: 42 });
    assert.ok(typeof decoded.timestamp === 'string' && decoded.timestamp.length > 0);
  } finally {
    _internals.resetClient();
  }
});

// ─── reportToCharli — fire-and-forget (R-J brief §3.1) ──────────────────────

test('reportToCharli — queue throws : ne lève pas, retourne ok=false avec error, log warn ctx.log.warn', async () => {
  _internals.setClientForTests(makeQueueClientStub({ shouldThrow: new Error('Queue unreachable') }));
  let warnMsg = null;
  const ctx = { log: { warn: (m) => { warnMsg = m; } } };
  try {
    const out = await reportToCharli({
      agent: 'david',
      eventType: 'email_sent',
      summary: 'X',
    }, ctx);

    assert.equal(out.ok, false);
    assert.match(out.error, /Queue unreachable/);
    assert.match(warnMsg, /charli-reporter.*Queue unreachable/);
  } finally {
    _internals.resetClient();
  }
});

test('reportToCharli — event invalide : ne lève pas, retourne ok=false, ne touche pas la queue', async () => {
  const captured = [];
  _internals.setClientForTests(makeQueueClientStub({ captured }));
  try {
    const out = await reportToCharli({ agent: 'david' }); // missing eventType + summary

    assert.equal(out.ok, false);
    assert.match(out.error, /event\.eventType|event\.summary/);
    assert.equal(captured.length, 0, 'queue ne doit pas être touchée');
  } finally {
    _internals.resetClient();
  }
});

test('reportToCharli — fallback console.warn si pas de ctx fourni', async () => {
  _internals.setClientForTests(makeQueueClientStub({ shouldThrow: new Error('boom') }));
  const originalWarn = console.warn;
  let captured = null;
  console.warn = (m) => { captured = m; };
  try {
    const out = await reportToCharli({
      agent: 'david',
      eventType: 'x',
      summary: 'y',
    });
    assert.equal(out.ok, false);
    assert.match(captured, /charli-reporter.*boom/);
  } finally {
    console.warn = originalWarn;
    _internals.resetClient();
  }
});

// ─── reportToCharli — config absente ────────────────────────────────────────

test('reportToCharli — CHARLI_QUEUE_CONNECTION_STRING absent : ok=false, ne lève pas', async () => {
  _internals.resetClient();
  const prev = process.env.CHARLI_QUEUE_CONNECTION_STRING;
  delete process.env.CHARLI_QUEUE_CONNECTION_STRING;
  try {
    const out = await reportToCharli({
      agent: 'david',
      eventType: 'email_sent',
      summary: 'X',
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /CHARLI_QUEUE_CONNECTION_STRING/);
  } finally {
    if (prev !== undefined) process.env.CHARLI_QUEUE_CONNECTION_STRING = prev;
  }
});
