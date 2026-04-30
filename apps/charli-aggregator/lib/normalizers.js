/**
 * lib/normalizers — transformation event entrant → mémoire Mem0 (Option B).
 *
 * Convention Option B (CHARLI v1.5 §9.3) :
 *   - content : texte sémantique pur, lisible, sans préfixe [date source: X]
 *   - metadata : structurée { date, source, agent, event_type, event_id, ...contextuels }
 *
 * Défense en profondeur PII : le caller (ex. David FA) doit déjà fournir un
 * summary anonymisé. Si malgré tout un email subsiste, le normalizer le
 * remplace par "le dirigeant de SIREN <siren>" (si metadata.siren disponible)
 * ou "le dirigeant de l'entreprise" (sinon).
 *
 * Date absolue obligatoire dans le content : si aucune date détectée,
 * préfixe "Le DD MOIS YYYY, ..." dérivé du event.timestamp ISO.
 *
 * Dispatch par agent : un normalizer dédié par agent est enregistré dans
 * NORMALIZERS. normalizeDavidEvent en place. Alicia/Richard à venir.
 */

'use strict';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

const MOIS_FR_RE_SOURCE = MOIS_FR.join('|');
const FR_DATE_RE = new RegExp(`\\b\\d{1,2}\\s+(?:${MOIS_FR_RE_SOURCE})\\s+\\d{4}\\b`, 'i');

function formatAbsoluteDateFr(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `Le ${d.getUTCDate()} ${MOIS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function anonymizeSummary(summary, metadata = {}) {
  if (typeof summary !== 'string') return summary;
  const replacement = metadata && metadata.siren
    ? `le dirigeant de SIREN ${metadata.siren}`
    : 'le dirigeant de l\'entreprise';
  return summary.replace(EMAIL_RE, replacement);
}

function ensureAbsoluteDate(summary, isoTimestamp) {
  if (typeof summary !== 'string') return summary;
  if (ISO_DATE_RE.test(summary)) return summary;
  if (FR_DATE_RE.test(summary)) return summary;
  const prefix = formatAbsoluteDateFr(isoTimestamp);
  if (!prefix) return summary;
  const tail = summary.length > 0
    ? `${summary[0].toLowerCase()}${summary.slice(1)}`
    : '';
  return `${prefix}, ${tail}`;
}

function buildMetadataOptionB(event, source) {
  const md = { ...(event.metadata || {}) };
  md.date = (event.timestamp || '').slice(0, 10);
  md.source = source;
  md.agent = event.agent;
  md.event_type = event.eventType;
  md.event_id = event.eventId;
  return md;
}

function normalizeDavidEvent(event) {
  const anonymized = anonymizeSummary(event.summary, event.metadata);
  const content = ensureAbsoluteDate(anonymized, event.timestamp);
  const metadata = buildMetadataOptionB(event, 'david-fa');
  return { content, metadata };
}

const NORMALIZERS = {
  david: normalizeDavidEvent,
  // alicia: normalizeAliciaEvent (à venir)
  // richard: normalizeRichardEvent (à venir)
};

function normalizeEvent(event) {
  const fn = NORMALIZERS[event && event.agent];
  if (!fn) {
    throw new Error(`No normalizer registered for agent='${event && event.agent}'`);
  }
  return fn(event);
}

const _internals = {
  anonymizeSummary,
  ensureAbsoluteDate,
  formatAbsoluteDateFr,
  normalizeDavidEvent,
  buildMetadataOptionB,
  NORMALIZERS,
};

module.exports = {
  normalizeEvent,
  _internals,
};
