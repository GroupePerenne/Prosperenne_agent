/**
 * Jours fériés français et helpers de jours ouvrés pour le scheduling
 * des envois Prospérenne.
 *
 * Règles produit (cf. CLAUDE.md §1.7) :
 * - Aucun envoi samedi / dimanche / jour férié
 * - Créneau cible : 9h-11h Paris
 * - Si un job tombe hors créneau → reporté au prochain jour ouvré à 9h
 *
 * La liste des jours fériés est statique (2026 et 2027) ; au-delà, il faut
 * l'étendre à la main. On préfère la lecture explicite à un calcul Pâques
 * dynamique pour éviter toute dépendance.
 */

const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // Jour de l'An
  '2026-04-06', // Lundi de Pâques
  '2026-05-01', // Fête du Travail
  '2026-05-08', // Victoire 1945
  '2026-05-14', // Ascension
  '2026-05-25', // Lundi de Pentecôte
  '2026-07-14', // Fête nationale
  '2026-08-15', // Assomption
  '2026-11-01', // Toussaint
  '2026-11-11', // Armistice
  '2026-12-25', // Noël
  // 2027
  '2027-01-01', // Jour de l'An
  '2027-03-29', // Lundi de Pâques
  '2027-05-01', // Fête du Travail
  '2027-05-06', // Ascension
  '2027-05-08', // Victoire 1945
  '2027-05-17', // Lundi de Pentecôte
  '2027-07-14', // Fête nationale
  '2027-08-15', // Assomption
  '2027-11-01', // Toussaint
  '2027-11-11', // Armistice
  '2027-12-25', // Noël
]);

const PARIS_TZ = 'Europe/Paris';
const BUSINESS_START_HOUR = 9;   // créneau d'envoi ouvre à 9h Paris
const BUSINESS_END_HOUR = 11;    // et se ferme à 11h Paris

/** Extrait date ISO (yyyy-mm-dd), heure et weekday d'une Date en heure Paris */
function parisDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    isoDate: `${get('year')}-${get('month')}-${get('day')}`,
    hour: parseInt(get('hour'), 10),
    weekday: get('weekday'),
  };
}

/** Vrai si la date (en heure Paris) est un jour ouvré (lun-ven hors férié) */
function isBusinessDay(date = new Date()) {
  const { isoDate, weekday } = parisDateParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return !HOLIDAYS.has(isoDate);
}

/** Ajoute N jours calendaires à une date ISO (yyyy-mm-dd) */
function addDaysToISODate(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dd = new Date(Date.UTC(y, m - 1, d));
  dd.setUTCDate(dd.getUTCDate() + days);
  return dd.toISOString().slice(0, 10);
}

/**
 * Construit une Date UTC qui correspond à l'heure locale Paris donnée.
 * Teste les 2 offsets possibles (+01:00 en hiver, +02:00 en été) et
 * retourne celui qui s'aligne sur Paris. Gère correctement les jours
 * de bascule CET/CEST.
 */
function parisDateTime(isoDate, hour, minute = 0) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  for (const offset of ['+01:00', '+02:00']) {
    const candidate = new Date(`${isoDate}T${hh}:${mm}:00${offset}`);
    if (parisDateParts(candidate).hour === hour) return candidate;
  }
  // Fallback (ne devrait pas arriver) : on prend +01:00
  return new Date(`${isoDate}T${hh}:${mm}:00+01:00`);
}

/**
 * Retourne le prochain créneau d'envoi (9h Paris par défaut) en jour ouvré.
 *
 * - Si la date passée est déjà dans un créneau valide (jour ouvré,
 *   9h ≤ heure Paris < 11h), elle est retournée telle quelle.
 * - Sinon, on avance jusqu'au prochain jour ouvré et on positionne à
 *   hourLocal:minuteLocal Paris.
 *
 * @param {Date} [date=new Date()]
 * @param {number} [hourLocal=9]
 * @param {number} [minuteLocal=0]
 * @returns {Date}
 */
function nextBusinessDayAt(date = new Date(), hourLocal = BUSINESS_START_HOUR, minuteLocal = 0) {
  const { isoDate: todayISO, hour: currentHour } = parisDateParts(date);

  // Déjà dans le créneau : on garde
  if (isBusinessDay(date) && currentHour >= BUSINESS_START_HOUR && currentHour < BUSINESS_END_HOUR) {
    return date;
  }

  // On avance si : jour non ouvré, ou on est déjà passé le créneau
  let targetISO = todayISO;
  if (!isBusinessDay(date) || currentHour >= BUSINESS_END_HOUR) {
    targetISO = addDaysToISODate(targetISO, 1);
  }

  // Avance jusqu'au prochain jour ouvré
  let slot = parisDateTime(targetISO, hourLocal, minuteLocal);
  while (!isBusinessDay(slot)) {
    targetISO = addDaysToISODate(targetISO, 1);
    slot = parisDateTime(targetISO, hourLocal, minuteLocal);
  }
  return slot;
}

/**
 * Ajoute N jours ouvrés à une date, en repositionnant le résultat sur
 * le créneau d'envoi 9h Paris.
 *
 * Utilisé pour calculer les échéances J+4 / J+10 / J+18 / J+28 en jours ouvrés.
 *
 * @param {Date} date
 * @param {number} n — nombre de jours ouvrés à ajouter
 * @param {number} [hourLocal=9]
 * @returns {Date}
 */
function addBusinessDays(date, n, hourLocal = BUSINESS_START_HOUR) {
  if (n <= 0) return date;
  let cur = parisDateParts(date).isoDate;
  let added = 0;
  while (added < n) {
    cur = addDaysToISODate(cur, 1);
    const candidate = parisDateTime(cur, hourLocal, 0);
    if (isBusinessDay(candidate)) added++;
  }
  return parisDateTime(cur, hourLocal, 0);
}

module.exports = {
  HOLIDAYS,
  BUSINESS_START_HOUR,
  BUSINESS_END_HOUR,
  isBusinessDay,
  nextBusinessDayAt,
  addBusinessDays,
  parisDateParts,
};
