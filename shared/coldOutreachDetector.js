/**
 * shared/coldOutreachDetector.js
 *
 * Helpers pour filtre cold outreach pré-classify David.
 * Référence : ADR-0005 docs/adr/ADR-0005-filtre-cold-outreach-pre-classify-david.md
 *
 * Deux niveaux exposés :
 *   - isInternalSender(fromAddress) : whitelist consultants + COMEX + agents internes
 *   - detectColdOutreachSignals(subject, fromAddress, headers) : Niveau B heuristiques
 *
 * Aucun appel runtime externe. Pas de credentials. Pas de side effect.
 * 100% pur, testable unit sans mocks.
 */

'use strict';

// Liste des emails internes COMEX (extension du COMEX_EMAILS Set de
// orchestrator.js + variantes @perennereseau.fr explicites + Charli).
// Lecture env vars consultants pour scaling sans modif code à l'onboarding.
const COMEX_INTERNAL_EMAILS = Object.freeze([
  'paul.rudler@oseys.fr',
  'paul.rudler@perennereseau.fr',
  'constantin.picoron@oseys.fr',
  'constantin.picoron@perennereseau.fr',
  'olivier@oseys.fr',
  'olivier@perennereseau.fr',
  'direction@oseys.fr',
  'direction@perennereseau.fr',
  'charli@pereneo.eu',
]);

// Env vars consultants pilote + agents (Morgane, Johnny, Elie + Martin, Mila, David).
// Lues runtime au lieu d'être hardcodées : permet d'étendre le pool consultant
// sans modif code (juste ajout env var Azure + restart FA).
const CONSULTANT_ENV_VARS = Object.freeze([
  'MORGANE_EMAIL',
  'JOHNNY_EMAIL',
  'ELIE_EMAIL',
]);

const AGENT_ENV_VARS = Object.freeze([
  'MARTIN_EMAIL',
  'MILA_EMAIL',
  'DAVID_EMAIL',
]);

// Niveau B — TLD suspects mass mailing / cold outreach.
// Mesure factuelle mai 2026 (Charli III.F) : 4/8 cas faux positif venaient
// de .top, .info, .co. Liste étendue aux TLDs réputés mass mailing.
const SUSPECT_TLDS = Object.freeze([
  '.top', '.info', '.co', '.click', '.online',
  '.xyz', '.live', '.site', '.shop',
]);

// Niveau B — regex tracking codes mesuré sur 7/8 cas mai 2026.
// Pattern : 2 blocs alphanumériques 6-8 chars séparés par espace, anywhere in subject.
// Exemples mesurés : "RYEH2BT NBH29P6", "MJNQTSW NBH29P6", "P4E64MX NBH29P6",
// "84RMYT4 NBH29P6", "HB4WMHS NBH29P6", "775JY6F NBH29P6", "P2ASFPJ NBH29P6".
const TRACKING_CODE_REGEX = /\b[A-Z0-9]{6,8}\s+[A-Z0-9]{6,8}\b/;

/**
 * Construit la whitelist runtime des emails internes en lisant
 * process.env + COMEX_INTERNAL_EMAILS hardcoded. Lowercase pour comparaison
 * insensible à la casse.
 *
 * @param {Object} [env=process.env]  override pour tests
 * @returns {Set<string>}  Set d'emails lowercase
 */
function buildInternalWhitelist(env = process.env) {
  const whitelist = new Set(
    COMEX_INTERNAL_EMAILS.map((e) => e.toLowerCase()),
  );
  for (const varName of CONSULTANT_ENV_VARS) {
    const value = env[varName];
    if (value && typeof value === 'string') {
      whitelist.add(value.toLowerCase());
    }
  }
  for (const varName of AGENT_ENV_VARS) {
    const value = env[varName];
    if (value && typeof value === 'string') {
      whitelist.add(value.toLowerCase());
    }
  }
  return whitelist;
}

/**
 * Détermine si l'expéditeur est un acteur interne (consultant, agent,
 * COMEX, Charli). Comparaison lowercase exacte.
 *
 * @param {string} fromAddress
 * @param {Object} [env=process.env]  override pour tests
 * @returns {boolean}
 */
function isInternalSender(fromAddress, env = process.env) {
  if (!fromAddress || typeof fromAddress !== 'string') return false;
  const whitelist = buildInternalWhitelist(env);
  return whitelist.has(fromAddress.toLowerCase().trim());
}

/**
 * Détecte les signaux Niveau B caractéristiques d'un cold outreach :
 *   - B1 : code tracking 2 blocs alphanumériques dans subject
 *   - B2 : TLD suspect dans fromAddress
 *   - B3 : header List-Unsubscribe présent OU Precedence: bulk
 *
 * @param {string} subject
 * @param {string} fromAddress
 * @param {Object} [headers={}]  internetMessageHeaders array ou map normalisée
 * @returns {{ isCold: boolean, signals: string[] }}
 */
function detectColdOutreachSignals(subject, fromAddress, headers = {}) {
  const signals = [];

  // B1 — tracking code regex dans subject
  if (subject && typeof subject === 'string' && TRACKING_CODE_REGEX.test(subject)) {
    signals.push('B1_tracking_code');
  }

  // B2 — TLD suspect dans fromAddress (insensible à la casse)
  if (fromAddress && typeof fromAddress === 'string') {
    const lower = fromAddress.toLowerCase();
    for (const tld of SUSPECT_TLDS) {
      if (lower.endsWith(tld)) {
        signals.push(`B2_suspect_tld:${tld}`);
        break;
      }
    }
  }

  // B3 — List-Unsubscribe header présent OU Precedence: bulk
  // Graph API expose les headers via msg.internetMessageHeaders (array
  // [{name, value}]) si fetché avec $select=internetMessageHeaders.
  // Si headers absent (cas habituel sans fetch explicite), B3 désactivé.
  if (headers) {
    const headersArray = Array.isArray(headers)
      ? headers
      : Array.isArray(headers.internetMessageHeaders)
        ? headers.internetMessageHeaders
        : [];

    for (const h of headersArray) {
      if (!h || !h.name) continue;
      const name = String(h.name).toLowerCase();
      const value = String(h.value || '').toLowerCase();
      if (name === 'list-unsubscribe') {
        signals.push('B3_list_unsubscribe');
        break;
      }
      if (name === 'precedence' && value === 'bulk') {
        signals.push('B3_precedence_bulk');
        break;
      }
    }
  }

  return {
    isCold: signals.length > 0,
    signals,
  };
}

module.exports = {
  isInternalSender,
  detectColdOutreachSignals,
  buildInternalWhitelist,
  // Exposés pour tests :
  COMEX_INTERNAL_EMAILS,
  CONSULTANT_ENV_VARS,
  AGENT_ENV_VARS,
  SUSPECT_TLDS,
  TRACKING_CODE_REGEX,
};
