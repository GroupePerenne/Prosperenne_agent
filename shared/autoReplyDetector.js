'use strict';

/**
 * Détection d'auto-reply (out-of-office, vacation responder, mailer-daemon)
 * AVANT classification Claude — économie de tokens + protection anti-boucle.
 *
 * Contexte (plan v3.1 Pilier 3 + invariant #9) :
 *   Sans cette détection, David peut entrer en boucle infinie avec un
 *   répondeur d'absence (David répond à un OOO → l'OOO répond à David
 *   → David répond à nouveau → ...). Incident potentiel non encore
 *   matérialisé mais probabilité moyenne, impact catastrophique (mails
 *   en pagaille côté prospect, risque réputation Pereneo).
 *
 * Sources de vérité (par ordre de fiabilité décroissante) :
 *
 *   1. Header SMTP `Auto-Submitted` (RFC 3834) — standard universel
 *      des auto-replies bien implémentés. Valeurs : `auto-replied`,
 *      `auto-generated`. Si présent avec valeur != `no` → c'est un auto-reply.
 *
 *   2. Header `X-Auto-Response-Suppress` (Microsoft) — posé par Outlook /
 *      Exchange sur les NDR + OOO + bounce. Si présent → auto-reply.
 *
 *   3. Header `Precedence` (RFC 2076) — `auto_reply`, `bulk`, `list`,
 *      `junk` indiquent un message non humain.
 *
 *   4. Header `X-Autoreply` ou `X-Autorespond` (legacy mailers).
 *
 *   5. Patterns subject (best effort, fallback) — "out of office",
 *      "absence", "vacances", "automatic reply", "réponse automatique",
 *      "je suis absent". Faux positifs possibles, donc utilisé seulement
 *      si aucun header SMTP n'a tranché.
 *
 * Doctrine : préférer les headers SMTP à la sémantique subject. Les headers
 * sont posés par les serveurs mail (Exchange, Gmail, etc.) au moment où le
 * répondeur est déclenché — c'est non-bypassable côté expéditeur normal.
 */

const AUTO_REPLY_SUBJECT_PATTERNS = [
  /out\s*of\s*office/i,
  /automatic\s*reply/i,
  /auto[-\s]?reply/i,
  /\babsence\b/i,
  /\bvacances\b/i,
  /\bje\s+suis\s+absent/i,
  /\bréponse\s+automatique/i,
  /\bcong[ée]s?\b/i,
];

/**
 * Extrait les headers SMTP du message Graph dans un dict case-insensitive.
 *
 * Graph API retourne `internetMessageHeaders` sous forme Array<{name, value}>
 * uniquement si on le demande explicitement dans `$select`. Si l'array est
 * absent (message pas encore enrichi), on retourne un dict vide — le
 * fallback subject prend alors le relais.
 *
 * @param {object} msg Message Graph
 * @returns {Object<string,string>} headers lowercased
 */
function headersOf(msg) {
  const list = Array.isArray(msg && msg.internetMessageHeaders) ? msg.internetMessageHeaders : [];
  const out = {};
  for (const h of list) {
    if (h && typeof h.name === 'string' && typeof h.value === 'string') {
      out[h.name.toLowerCase()] = h.value;
    }
  }
  return out;
}

/**
 * Retourne true si le message est un auto-reply (OOO / vacation / NDR
 * non-bounce / etc.). Détection multi-niveaux par ordre de fiabilité.
 *
 * @param {object} msg Message Graph (avec internetMessageHeaders si disponible)
 * @returns {{isAutoReply: boolean, reason: string|null}}
 */
function detectAutoReply(msg) {
  if (!msg || typeof msg !== 'object') return { isAutoReply: false, reason: null };

  const headers = headersOf(msg);

  // 1. Auto-Submitted RFC 3834
  const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return { isAutoReply: true, reason: `header_auto_submitted:${autoSubmitted}` };
  }

  // 2. X-Auto-Response-Suppress Microsoft
  if (headers['x-auto-response-suppress']) {
    return { isAutoReply: true, reason: `header_x_auto_response_suppress:${headers['x-auto-response-suppress']}` };
  }

  // 3. Precedence RFC 2076
  const precedence = (headers['precedence'] || '').toLowerCase().trim();
  if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'list' || precedence === 'junk') {
    return { isAutoReply: true, reason: `header_precedence:${precedence}` };
  }

  // 4. X-Autoreply / X-Autorespond legacy
  if (headers['x-autoreply'] || headers['x-autorespond']) {
    return { isAutoReply: true, reason: 'header_x_autoreply_legacy' };
  }

  // 5. Fallback subject patterns — utilisé seulement si aucun header n'a tranché.
  //    Plus faillible (faux positifs possibles), mais couvre les mailers qui
  //    n'auraient pas posé les headers (rare aujourd'hui mais Outlook OWA
  //    out-of-office classique pose Auto-Submitted, donc déjà couvert par 1).
  const subject = String(msg.subject || '');
  for (const pattern of AUTO_REPLY_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      return { isAutoReply: true, reason: `subject_pattern:${pattern.source}` };
    }
  }

  return { isAutoReply: false, reason: null };
}

/**
 * Helper booléen direct (compat appel).
 */
function isAutoReply(msg) {
  return detectAutoReply(msg).isAutoReply;
}

module.exports = {
  detectAutoReply,
  isAutoReply,
  AUTO_REPLY_SUBJECT_PATTERNS,
};
