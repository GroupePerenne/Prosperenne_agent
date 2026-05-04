'use strict';

/**
 * Classes d'erreur partagées par les backends webSearch.
 *
 * - SearchBlockedError : le moteur a détecté du scraping et nous bloque
 *   (challenge anti-bot, 403, 429, captcha). Le caller doit basculer sur
 *   le backend suivant ou stopper la cascade pour éviter de marteler.
 *
 * - SearchTransientError : erreur réseau ou 5xx du moteur. Le caller peut
 *   retry plus tard (mais en pilote on remonte simplement et on continue).
 */

class SearchBlockedError extends Error {
  constructor(reason, status) {
    super(`web search blocked: ${reason}`);
    this.name = 'SearchBlockedError';
    this.code = 'blocked';
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

class SearchTransientError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SearchTransientError';
    this.code = 'transient';
    if (status !== undefined) this.status = status;
  }
}

module.exports = {
  SearchBlockedError,
  SearchTransientError,
};
