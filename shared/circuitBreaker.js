'use strict';

/**
 * Circuit breaker simple en mémoire processus — plan v3.1 P3 Task #14.
 *
 * Évite de hammer Microsoft Graph (ou tout autre upstream) quand l'API est
 * dégradée. Après N échecs consécutifs, le circuit s'ouvre pendant W minutes
 * et tout call retourne immédiatement une CircuitOpenError. Après W min,
 * le circuit passe en half-open et tente un call de probe : si OK → closed,
 * si KO → re-open.
 *
 * État en mémoire processus : suffisant pour FA Linux Consumption où cold
 * start = nouveau contexte. La perte d'état à un cold start n'est pas un
 * problème (on repart en mode closed, ce qui est le bon défaut).
 *
 * Usage :
 *   const { withBreaker } = require('./circuitBreaker');
 *   const result = await withBreaker('graph', () => callGraphApi(...));
 *
 * Si circuit open : throw CircuitOpenError (err.skipped=true pour callers
 * davidReplyFlusher cohérent threadReplyCap pattern).
 *
 * Env vars override :
 *   - CIRCUIT_BREAKER_FAIL_THRESHOLD (défaut 5)
 *   - CIRCUIT_BREAKER_OPEN_DURATION_MS (défaut 900000 = 15 min)
 */

const DEFAULT_FAIL_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAIL_THRESHOLD || 5);
const DEFAULT_OPEN_DURATION_MS = Number(process.env.CIRCUIT_BREAKER_OPEN_DURATION_MS || 15 * 60 * 1000);

const STATES = Object.freeze({ CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' });

class CircuitOpenError extends Error {
  constructor(name, openedAt, willHalfOpenAt) {
    super(`circuit_open:${name} openedAt=${openedAt} willHalfOpenAt=${willHalfOpenAt}`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.skipped = true;
    this.circuitName = name;
    this.openedAt = openedAt;
    this.willHalfOpenAt = willHalfOpenAt;
  }
}

// State par circuit. { state, failCount, openedAt, halfOpenAt }
const _circuits = new Map();

function _getCircuit(name) {
  let c = _circuits.get(name);
  if (!c) {
    c = { state: STATES.CLOSED, failCount: 0, openedAt: null, halfOpenAt: null };
    _circuits.set(name, c);
  }
  return c;
}

function _resetForTests() { _circuits.clear(); }

function getState(name) {
  const c = _getCircuit(name);
  return { ...c };
}

/**
 * Wrappe un async fn dans un circuit breaker nommé.
 *
 * @param {string} name
 * @param {() => Promise<any>} asyncFn
 * @param {object} [opts]
 * @param {number} [opts.failThreshold]    Défaut env var ou 5
 * @param {number} [opts.openDurationMs]   Défaut env var ou 900000 (15 min)
 * @param {(err: Error) => boolean} [opts.shouldCount] Filtre pour ne compter
 *        que certaines erreurs (par défaut : toutes)
 * @returns {Promise<any>} résultat de asyncFn ou throw CircuitOpenError
 */
async function withBreaker(name, asyncFn, opts = {}) {
  const failThreshold = Number.isFinite(opts.failThreshold) ? opts.failThreshold : DEFAULT_FAIL_THRESHOLD;
  const openDurationMs = Number.isFinite(opts.openDurationMs) ? opts.openDurationMs : DEFAULT_OPEN_DURATION_MS;
  const shouldCount = typeof opts.shouldCount === 'function' ? opts.shouldCount : () => true;

  const c = _getCircuit(name);
  const now = Date.now();

  if (c.state === STATES.OPEN) {
    if (c.halfOpenAt && now >= c.halfOpenAt) {
      c.state = STATES.HALF_OPEN; // probe au prochain call
    } else {
      throw new CircuitOpenError(name, new Date(c.openedAt).toISOString(), new Date(c.halfOpenAt).toISOString());
    }
  }

  try {
    const result = await asyncFn();
    // Success → close circuit
    c.state = STATES.CLOSED;
    c.failCount = 0;
    c.openedAt = null;
    c.halfOpenAt = null;
    return result;
  } catch (err) {
    if (!shouldCount(err)) throw err;
    c.failCount = (c.failCount || 0) + 1;
    if (c.failCount >= failThreshold) {
      c.state = STATES.OPEN;
      c.openedAt = now;
      c.halfOpenAt = now + openDurationMs;
    }
    throw err;
  }
}

module.exports = {
  withBreaker,
  CircuitOpenError,
  getState,
  STATES,
  // Tests :
  _resetForTests,
};
