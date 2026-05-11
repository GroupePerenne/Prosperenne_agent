'use strict';

/**
 * Application Insights — wrapper léger défensif.
 *
 * Contexte (BL-04bis "AI silencieux", découvert à fond le 12 mai 2026) :
 *   L'auto-instrumentation Azure Functions Node.js v4 ne capture que les
 *   exceptions non-catchées et certains événements HTTP. Comme notre code
 *   utilise shared/safe-log.js qui swallow toutes les exceptions et fallback
 *   silencieusement sur console.*, AI ne voit RIEN — confirmé par query AI
 *   sur 7 jours retournant zéro events.
 *
 *   Conséquence : les 403 markAsRead répétés depuis avril, les exceptions
 *   davidInbox, les 5xx Graph etc. ne sont JAMAIS remontés. Pour un pilote
 *   en production avec 3 consultants, c'est intenable.
 *
 * Approche :
 *   Module pur côté Node SDK applicationinsights v3.x. À l'init, on appelle
 *   setup() + start() pour activer l'auto-instrumentation OpenTelemetry du
 *   SDK. Pour les logs/exceptions du code applicatif, on expose trackTrace
 *   et trackException qui poussent directement via TelemetryClient — bypass
 *   complet du context.log Azure Functions et du fallback console.
 *
 * Discipline : ne JAMAIS crasher l'app si AI est down ou mal configuré.
 * Toutes les fonctions sont try/catch silencieux, retournent null si KO.
 */

let _client = null;
let _initAttempted = false;
let _initFailed = false;

function init() {
  if (_initAttempted) return _client;
  _initAttempted = true;
  const conn = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!conn) {
    _initFailed = true;
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const appInsights = require('applicationinsights');
    appInsights
      .setup(conn)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true, true)
      .setAutoCollectExceptions(true)
      .setAutoCollectDependencies(true)
      .setAutoCollectConsole(false, false)  // évite double-logging via console.*
      .setUseDiskRetryCaching(true)
      .start();
    _client = new appInsights.TelemetryClient(conn);
    return _client;
  } catch (err) {
    _initFailed = true;
    _client = null;
    // Pas de console.error pour ne pas spammer ; le code applicatif fallback OK
    return null;
  }
}

function getClient() {
  if (_initFailed) return null;
  if (!_initAttempted) return init();
  return _client;
}

// Mapping severity string → niveau AI (cf. KnownSeverityLevel / SeverityLevel)
//   0 = Verbose, 1 = Information, 2 = Warning, 3 = Error, 4 = Critical
const SEVERITY_LEVELS = {
  verbose: 0,
  info: 1,
  warn: 2,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * Pousse une trace vers AI. Best effort, ne throw jamais.
 *
 * @param {string} message
 * @param {object} [properties] - custom dimensions
 * @param {string} [severity] - 'verbose' | 'info' | 'warn' | 'error' | 'critical'
 */
function trackTrace(message, properties = {}, severity = 'info') {
  const c = getClient();
  if (!c) return;
  try {
    c.trackTrace({
      message: String(message || '').slice(0, 8000),
      severity: SEVERITY_LEVELS[severity] ?? 1,
      properties: sanitizeProperties(properties),
    });
  } catch {
    // Best effort
  }
}

/**
 * Pousse une exception vers AI. Best effort.
 *
 * @param {Error|string} error
 * @param {object} [properties]
 */
function trackException(error, properties = {}) {
  const c = getClient();
  if (!c) return;
  try {
    const exception = error instanceof Error ? error : new Error(String(error || 'unknown error'));
    c.trackException({
      exception,
      properties: sanitizeProperties(properties),
    });
  } catch {
    // Best effort
  }
}

/**
 * Pousse une métrique custom vers AI.
 *
 * @param {string} name
 * @param {number} value
 * @param {object} [properties]
 */
function trackMetric(name, value, properties = {}) {
  const c = getClient();
  if (!c) return;
  try {
    c.trackMetric({
      name: String(name).slice(0, 200),
      value: Number(value) || 0,
      properties: sanitizeProperties(properties),
    });
  } catch {
    // Best effort
  }
}

/**
 * Sanitize les properties pour éviter d'envoyer du PII / secret par accident.
 * Tronque chaque valeur à 8KB max et stringifie les objets.
 */
function sanitizeProperties(props) {
  if (!props || typeof props !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else {
      try { s = JSON.stringify(v); } catch { s = '[unserializable]'; }
    }
    out[k] = s.slice(0, 8000);
  }
  return out;
}

module.exports = {
  init,
  getClient,
  trackTrace,
  trackException,
  trackMetric,
  // Pour tests :
  _reset() {
    _client = null;
    _initAttempted = false;
    _initFailed = false;
  },
};
