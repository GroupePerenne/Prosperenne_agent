'use strict';

/**
 * API publique du module disc-profiler.
 *
 * Usage :
 *   const disc = require('./shared/disc-profiler');
 *   const score = await disc.inferDISC({ role, linkedin, companyTone, pressMentions });
 *
 * Exports :
 *   - inferDISC (async, principal)
 *   - extractSignals (pur, testable)
 *   - hasEnoughSignalsForInference (pur)
 *   - CONFIDENCE_ADAPT_THRESHOLD : seuil >= 0.4 déclenche l'adaptation DISC
 *                                   dans pitch.js (cf. STRATEGY §4.11.3)
 *   - CONFIDENCE_STRONG_THRESHOLD : seuil >= 0.7 signal fort
 */

const { inferDISC } = require('./inference');
const { extractSignals, hasEnoughSignalsForInference } = require('./signals');

const CONFIDENCE_ADAPT_THRESHOLD = 0.4;
const CONFIDENCE_STRONG_THRESHOLD = 0.7;

/**
 * Utilitaire decision helper : doit-on adapter le ton au DISC ?
 * @param {object} discScore output de inferDISC
 * @returns {boolean}
 */
function shouldAdaptToneToDISC(discScore) {
  if (!discScore || typeof discScore !== 'object') return false;
  if (discScore.primary === 'unknown') return false;
  return (discScore.confidence || 0) >= CONFIDENCE_ADAPT_THRESHOLD;
}

module.exports = {
  inferDISC,
  extractSignals,
  hasEnoughSignalsForInference,
  shouldAdaptToneToDISC,
  CONFIDENCE_ADAPT_THRESHOLD,
  CONFIDENCE_STRONG_THRESHOLD,
};
