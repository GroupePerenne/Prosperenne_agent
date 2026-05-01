'use strict';

/**
 * Safe logger pour Azure Functions v4.
 *
 * Le SDK @azure/functions v4 utilise des private fields (#field) sur son
 * InvocationContext.log. Un .bind() perd l'accès à ces fields quand la
 * méthode est appelée depuis une autre closure (cas singleton réutilisé
 * entre invocations, cas extraction de méthode dans une variable, cas
 * passage à un module shared). Provoque BL-45 : `Cannot read private
 * member from an object whose class did not declare it`.
 *
 * Ce module wrappe context.log (et ses variantes context.info/warn/error)
 * dans un logger qui :
 *   - try/catch chaque appel pour ne jamais propager le crash #privateField
 *   - fallback gracieux sur console.{log,warn,error} si l'invocation Azure
 *     échoue silencieusement (cas BL-04bis télémétrie AI silencieuse)
 *   - expose une API uniforme couvrant les 3 styles d'usage observés :
 *       1. context.log(msg, payload)              → log(msg, payload)
 *       2. context.log.info(msg, payload)         → log.info(msg, payload)
 *       3. context.{info,warn,error}(msg, payload) → log.{info,warn,error}(msg, payload)
 *
 * Usage :
 *   const { makeSafeLogger } = require('../../shared/safe-log');
 *   async function myHandler(context) {
 *     const log = makeSafeLogger(context);
 *     log('handler tick');                  // routes to info
 *     log.info('detail', { foo: 'bar' });
 *     log.warn('soft warning');
 *     log.error('failure', { stack });
 *   }
 *
 * Fix transverse BL-45 — Sprint 3 Phase 1 (1er mai 2026).
 */

function noop() {}

/**
 * Résout la méthode primaire d'un context Azure Functions v4 selon les
 * patterns observés. Ordre de priorité :
 *   1. context.<method>          (Azure Functions v4 InvocationContext)
 *   2. context.log.<method>      (legacy v3, ou wrapper custom)
 *   3. context.log               (callable direct, fallback méthode)
 *   4. fallback noop
 */
function resolveMethod(context, methodName, fallback) {
  if (!context) return fallback;
  // Cas 1 : v4 native (context.info, context.warn, context.error)
  if (typeof context[methodName] === 'function') return context[methodName].bind(context);
  // Cas 2 : v3 ou wrapper custom (context.log.info, ...)
  if (context.log && typeof context.log[methodName] === 'function') {
    return context.log[methodName].bind(context.log);
  }
  // Cas 3 : context.log callable direct (souvent utilisé pour 'log' méthode info-like)
  if (typeof context.log === 'function') return context.log.bind(context);
  return fallback;
}

/**
 * Construit un logger safe pour un Azure Functions context.
 *
 * @param {object|null|undefined} context  InvocationContext Azure Functions v4
 * @returns {Function & {info, warn, error}}  Logger callable + méthodes
 */
function makeSafeLogger(context) {
  const rawInfo = resolveMethod(context, 'info', noop);
  const rawWarn = resolveMethod(context, 'warn', rawInfo);
  const rawError = resolveMethod(context, 'error', rawWarn);

  // `consoleKey` résolu dynamiquement à chaque appel via console[key],
  // pour qu'un re-binding de console.* (cas tests, ou monitoring custom)
  // soit pris en compte. Si on capturait console.log au moment de la
  // création, un test mockant console.log après coup ne verrait rien.
  const safe = (fn, consoleKey) => (...args) => {
    try {
      return fn(...args);
    } catch {
      try {
        return console[consoleKey](...args);
      } catch {
        // Dernier recours : silence pour ne jamais bloquer le caller.
      }
    }
  };

  const safeInfo = safe(rawInfo, 'log');
  const safeWarn = safe(rawWarn, 'warn');
  const safeError = safe(rawError, 'error');

  // Logger callable : log(msg) route vers safeInfo (compat avec
  // context.log(msg) direct utilisé dans les call sites historiques).
  const logger = (...args) => safeInfo(...args);
  logger.info = safeInfo;
  logger.warn = safeWarn;
  logger.error = safeError;
  return logger;
}

module.exports = {
  makeSafeLogger,
  // Exposé pour tests unitaires :
  _resolveMethod: resolveMethod,
};
