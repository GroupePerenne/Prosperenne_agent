'use strict';

/**
 * Jitter humain pour les réponses davidInbox.
 *
 * Contexte (12 mai 2026, recadrage Paul) :
 *   davidInbox poll les 3 boîtes toutes les 5 min et déclenche sendMail
 *   immédiat dès classification Claude. Pour un mail consultant comme celui
 *   d'Elie, latence totale ≤ 5 min — trop robotique, casse la posture
 *   "agent qui se comporte comme un humain" (règle d'honneur §positionnement
 *   éthique).
 *
 * Doctrine actée par Paul 12 mai matin :
 *   - Prospects (positive/question/neutre/negative)   : 5 à 45 min de jitter
 *   - Consultants / internal                           : 15 à 45 min de jitter
 *   - Jitter calculé en heures ouvrées Paris 9h-18h L-V uniquement
 *   - Hors heures ouvrées → reporter au prochain créneau ouvré + jitter
 *
 * Heures ouvrées : cohérent avec mémoire feedback_heures_ouvrees.md (9h-18h)
 * et feedback_creneau_envoi_9h_18h.md (créneau envoi prospects 9h-18h).
 *
 * Module pur, sans dépendance Azure ou réseau. Toute la logique de
 * persistance vit dans shared/storage-tables/davidPendingReplies.js.
 */

const DEFAULT_TZ = process.env.JITTER_TIMEZONE || 'Europe/Paris';

const JITTER_PROSPECT_MIN_MS = Number(process.env.JITTER_PROSPECT_MIN_MS || 5 * 60 * 1000);
const JITTER_PROSPECT_MAX_MS = Number(process.env.JITTER_PROSPECT_MAX_MS || 45 * 60 * 1000);
const JITTER_CONSULTANT_MIN_MS = Number(process.env.JITTER_CONSULTANT_MIN_MS || 15 * 60 * 1000);
const JITTER_CONSULTANT_MAX_MS = Number(process.env.JITTER_CONSULTANT_MAX_MS || 45 * 60 * 1000);

const BUSINESS_HOUR_START = Number(process.env.JITTER_BUSINESS_HOUR_START || 9);   // 9h inclus
const BUSINESS_HOUR_END = Number(process.env.JITTER_BUSINESS_HOUR_END || 18);     // 18h exclus

const SENDER_TYPES = new Set(['prospect', 'consultant', 'internal', 'spam']);

function randomJitterMs(minMs, maxMs, rng = Math.random) {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  if (hi <= lo) return lo;
  return Math.floor(lo + rng() * (hi - lo));
}

/**
 * Retourne true si `date` est dans une heure ouvrée Paris (L-V 9h-18h).
 * Utilise Intl.DateTimeFormat pour gérer la conversion timezone proprement
 * (DST géré natif).
 */
function isBusinessHour(date, tz = DEFAULT_TZ) {
  const parts = getDateParts(date, tz);
  // weekday: 1 = Monday, 7 = Sunday (ISO style via Intl.DateTimeFormat avec weekday short)
  if (parts.weekdayNum < 1 || parts.weekdayNum > 5) return false;
  if (parts.hour < BUSINESS_HOUR_START) return false;
  if (parts.hour >= BUSINESS_HOUR_END) return false;
  return true;
}

/**
 * Retourne un Date correspondant au prochain début de créneau ouvré
 * strictement après `date`. Si `date` est lui-même un début de créneau ouvré,
 * on saute au suivant.
 */
function nextBusinessSlotStart(date, tz = DEFAULT_TZ) {
  // Stratégie : on avance heure par heure jusqu'à trouver le prochain
  // créneau (weekdayNum 1-5, hour === BUSINESS_HOUR_START).
  // Pas optimal mais simple, suffisant pour le besoin (max ~72h d'itérations
  // sur un weekend long, soit < 100 iterations).
  let cursor = new Date(date.getTime());
  // On avance d'au moins 1 ms pour garantir "strictement après"
  cursor = new Date(cursor.getTime() + 60 * 1000); // +1 min pour éviter loop infini

  for (let i = 0; i < 24 * 7 * 4; i++) {  // safety cap : 1 semaine en quarts d'heure
    const parts = getDateParts(cursor, tz);
    // On cherche le premier instant où on est en business hour ET on était
    // hors business hour juste avant. Simplification : on accepte tout
    // weekday 1-5 avec hour >= BUSINESS_HOUR_START, et on rembobine à l'heure
    // pile BUSINESS_HOUR_START dans la TZ locale.
    if (parts.weekdayNum >= 1 && parts.weekdayNum <= 5 && parts.hour >= BUSINESS_HOUR_START && parts.hour < BUSINESS_HOUR_END) {
      // Construire la date "BUSINESS_HOUR_START:00 ce jour-là dans la TZ"
      return atBusinessSlotStart(cursor, tz);
    }
    cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
  }
  return cursor;
}

/**
 * Retourne une Date correspondant à `BUSINESS_HOUR_START:00:00` du même jour
 * que `date` dans la timezone `tz`. Utilisé pour caler le départ d'un créneau.
 */
function atBusinessSlotStart(date, tz = DEFAULT_TZ) {
  const parts = getDateParts(date, tz);
  // Construit une chaîne ISO locale "YYYY-MM-DDTHH:00:00" puis interprète
  // dans la TZ via détour Date.UTC + offset.
  const isoLocal = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(BUSINESS_HOUR_START)}:00:00`;
  return fromLocalIsoInTz(isoLocal, tz);
}

/**
 * Calcule l'instant d'envoi cible pour une réponse.
 *
 * @param {Date|number|string} receivedAt - quand le mail a été reçu (ou now)
 * @param {object} opts
 * @param {number} opts.minMs - jitter minimum
 * @param {number} opts.maxMs - jitter maximum
 * @param {string} [opts.tz] - timezone (par défaut Europe/Paris)
 * @param {function} [opts.rng] - random generator (pour tests)
 * @returns {Date} - instant d'envoi cible
 *
 * Algo :
 *   1. Tire un jitter aléatoire dans [minMs, maxMs]
 *   2. candidate = receivedAt + jitter
 *   3. Si candidate est en heure ouvrée → return candidate
 *   4. Sinon → nextBusinessSlotStart(candidate) + jitter
 */
function computeScheduledAt(receivedAt, { minMs, maxMs, tz = DEFAULT_TZ, rng = Math.random } = {}) {
  const base = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  const jitter = randomJitterMs(minMs, maxMs, rng);
  const candidate = new Date(base.getTime() + jitter);
  if (isBusinessHour(candidate, tz)) {
    return candidate;
  }
  // Hors heures ouvrées : on tire un nouveau jitter et on l'ajoute au prochain
  // début de créneau ouvré (pour ne pas tomber à 9h pile robotique).
  const slot = nextBusinessSlotStart(candidate, tz);
  const slotJitter = randomJitterMs(minMs, maxMs, rng);
  return new Date(slot.getTime() + slotJitter);
}

/**
 * Renvoie la fenêtre de jitter (min/max ms) à appliquer selon le type
 * d'expéditeur classifié.
 *
 * `senderType` correspond à `decision.sender_type` retourné par Claude
 * (prospect | consultant | internal | spam). Spam n'est jamais envoyé en
 * réponse ; par défaut on retourne la fenêtre consultant (cas border).
 */
function getJitterWindowForSenderType(senderType) {
  if (senderType === 'prospect') {
    return { minMs: JITTER_PROSPECT_MIN_MS, maxMs: JITTER_PROSPECT_MAX_MS, kind: 'prospect' };
  }
  return { minMs: JITTER_CONSULTANT_MIN_MS, maxMs: JITTER_CONSULTANT_MAX_MS, kind: 'consultant' };
}

// ─── Helpers TZ (Intl.DateTimeFormat) ──────────────────────────────────────

const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function getDateParts(date, tz) {
  // Format en parts pour récupérer year/month/day/hour/weekday dans la TZ
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date instanceof Date ? date : new Date(date))) {
    parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
    weekdayNum: WEEKDAY_INDEX[parts.weekday] || 0,
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Interprète une chaîne ISO locale "YYYY-MM-DDTHH:mm:ss" comme une heure
 * dans la timezone `tz` et retourne le Date UTC correspondant.
 *
 * Note : Date doesn't have native "parse with TZ" so we compute the offset
 * for that local time at that point in the year (DST aware via Intl).
 */
function fromLocalIsoInTz(isoLocal, tz) {
  // Construire une Date UTC initiale comme si isoLocal était UTC, puis
  // calculer le décalage TZ pour cette date et corriger.
  const guess = new Date(`${isoLocal}Z`);
  const guessParts = getDateParts(guess, tz);
  // Reconstituer ce que cette TZ "voit" pour notre guess
  const seenIso = `${guessParts.year}-${pad2(guessParts.month)}-${pad2(guessParts.day)}T${pad2(guessParts.hour)}:${pad2(guessParts.minute)}:00Z`;
  const seenAsUtc = new Date(seenIso);
  const offsetMs = seenAsUtc.getTime() - guess.getTime();
  return new Date(guess.getTime() - offsetMs);
}

module.exports = {
  randomJitterMs,
  isBusinessHour,
  nextBusinessSlotStart,
  computeScheduledAt,
  getJitterWindowForSenderType,
  SENDER_TYPES,
  // Exports pour tests / observabilité
  _DEFAULT_TZ: DEFAULT_TZ,
  _BUSINESS_HOUR_START: BUSINESS_HOUR_START,
  _BUSINESS_HOUR_END: BUSINESS_HOUR_END,
  _JITTER_PROSPECT_MIN_MS: JITTER_PROSPECT_MIN_MS,
  _JITTER_PROSPECT_MAX_MS: JITTER_PROSPECT_MAX_MS,
  _JITTER_CONSULTANT_MIN_MS: JITTER_CONSULTANT_MIN_MS,
  _JITTER_CONSULTANT_MAX_MS: JITTER_CONSULTANT_MAX_MS,
};
