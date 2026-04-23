'use strict';

/**
 * Géocodage simple pour le Lead Selector.
 *
 * Trois capacités :
 *  - geocodeAddress(addr) : résout une adresse libre en {lat, lon} via Nominatim
 *    (gratuit, sans clé). Cache mémoire par adresse normalisée.
 *  - haversineKm(a, b)    : distance grand-cercle en km.
 *  - departementCentroid(dep) : centroïde approximatif (chef-lieu) des
 *    101 départements français (96 métropolitains + Corse 2A/2B + 5 DOM).
 *
 * Note rate-limit Nominatim : 1 req/s max. Le Lead Selector n'appelle
 * geocodeAddress qu'une seule fois par exécution (l'adresse du consultant),
 * donc pas de risque de hit ce plafond. User-Agent obligatoire pour éviter
 * un blocage côté Nominatim.
 */

const CENTRE_FRANCE_METROPOLITAINE = { lat: 46.603354, lon: 1.888334 };

const NOMINATIM_BASE = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const DEFAULT_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT || 'Pereneo-agents/1.0 (direction@oseys.fr)';
const DEFAULT_TIMEOUT_MS = 3000;

// Cache in-memory volontaire en V1 : vit le temps d'un warm container Azure
// Functions, reset à chaque cold start. Suffisant pour le pilote interne
// OSEYS (Morgane/Johnny, 1 brief ≠ /consultant/jour).
//
// TODO post-pilote (avant ouverture commerciale Prospérenne) : persister en
// Azure Table `GeocodingCache` (PartitionKey=hash(address), RowKey=fixed).
// Sinon on risque des 429 Nominatim lors de batches de briefs simultanés
// post cold-start (Nominatim : 1 req/s et hard-throttle par IP sur abus).
const _cache = new Map();

function normalizeAddress(addr) {
  return String(addr || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

async function geocodeAddress(address, opts = {}) {
  const key = normalizeAddress(address);
  if (!key) return null;
  if (_cache.has(key)) {
    const hit = _cache.get(key);
    return hit ? { ...hit, source: 'cache' } : null;
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const url = `${NOMINATIM_BASE}/search?format=json&limit=1&countrycodes=fr&q=${encodeURIComponent(address)}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) {
      _cache.set(key, null);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      _cache.set(key, null);
      return null;
    }
    const top = data[0];
    const lat = parseFloat(top.lat);
    const lon = parseFloat(top.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      _cache.set(key, null);
      return null;
    }
    const point = { lat, lon };
    _cache.set(key, point);
    return { ...point, source: 'nominatim' };
  } catch {
    _cache.set(key, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  if (typeof a.lat !== 'number' || typeof a.lon !== 'number') return Infinity;
  if (typeof b.lat !== 'number' || typeof b.lon !== 'number') return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

const DEPARTEMENT_CENTROIDS = {
  '01': { lat: 46.20, lon: 5.22 },   '02': { lat: 49.56, lon: 3.62 },
  '03': { lat: 46.57, lon: 3.33 },   '04': { lat: 44.10, lon: 6.24 },
  '05': { lat: 44.56, lon: 6.08 },   '06': { lat: 43.70, lon: 7.27 },
  '07': { lat: 44.74, lon: 4.60 },   '08': { lat: 49.77, lon: 4.72 },
  '09': { lat: 42.97, lon: 1.61 },   '10': { lat: 48.30, lon: 4.08 },
  '11': { lat: 43.21, lon: 2.35 },   '12': { lat: 44.35, lon: 2.57 },
  '13': { lat: 43.30, lon: 5.40 },   '14': { lat: 49.18, lon: -0.37 },
  '15': { lat: 44.93, lon: 2.45 },   '16': { lat: 45.65, lon: 0.16 },
  '17': { lat: 46.16, lon: -1.15 },  '18': { lat: 47.08, lon: 2.40 },
  '19': { lat: 45.27, lon: 1.77 },   '2A': { lat: 41.92, lon: 8.74 },
  '2B': { lat: 42.70, lon: 9.45 },   '21': { lat: 47.32, lon: 5.04 },
  '22': { lat: 48.51, lon: -2.77 },  '23': { lat: 46.17, lon: 1.87 },
  '24': { lat: 45.18, lon: 0.72 },   '25': { lat: 47.24, lon: 6.02 },
  '26': { lat: 44.93, lon: 4.89 },   '27': { lat: 49.02, lon: 1.15 },
  '28': { lat: 48.45, lon: 1.49 },   '29': { lat: 48.10, lon: -4.10 },
  '30': { lat: 43.84, lon: 4.36 },   '31': { lat: 43.60, lon: 1.44 },
  '32': { lat: 43.65, lon: 0.59 },   '33': { lat: 44.84, lon: -0.58 },
  '34': { lat: 43.61, lon: 3.88 },   '35': { lat: 48.11, lon: -1.68 },
  '36': { lat: 46.81, lon: 1.69 },   '37': { lat: 47.39, lon: 0.69 },
  '38': { lat: 45.19, lon: 5.72 },   '39': { lat: 46.67, lon: 5.55 },
  '40': { lat: 43.89, lon: -0.50 },  '41': { lat: 47.59, lon: 1.33 },
  '42': { lat: 45.43, lon: 4.39 },   '43': { lat: 45.04, lon: 3.88 },
  '44': { lat: 47.22, lon: -1.55 },  '45': { lat: 47.90, lon: 1.91 },
  '46': { lat: 44.45, lon: 1.44 },   '47': { lat: 44.20, lon: 0.62 },
  '48': { lat: 44.52, lon: 3.50 },   '49': { lat: 47.47, lon: -0.55 },
  '50': { lat: 49.12, lon: -1.09 },  '51': { lat: 48.96, lon: 4.36 },
  '52': { lat: 48.11, lon: 5.14 },   '53': { lat: 48.07, lon: -0.77 },
  '54': { lat: 48.69, lon: 6.18 },   '55': { lat: 48.77, lon: 5.16 },
  '56': { lat: 47.66, lon: -2.76 },  '57': { lat: 49.12, lon: 6.18 },
  '58': { lat: 46.99, lon: 3.16 },   '59': { lat: 50.63, lon: 3.07 },
  '60': { lat: 49.43, lon: 2.08 },   '61': { lat: 48.43, lon: 0.09 },
  '62': { lat: 50.29, lon: 2.78 },   '63': { lat: 45.78, lon: 3.08 },
  '64': { lat: 43.30, lon: -0.37 },  '65': { lat: 43.23, lon: 0.07 },
  '66': { lat: 42.69, lon: 2.89 },   '67': { lat: 48.58, lon: 7.75 },
  '68': { lat: 48.08, lon: 7.36 },   '69': { lat: 45.76, lon: 4.83 },
  '70': { lat: 47.62, lon: 6.15 },   '71': { lat: 46.31, lon: 4.83 },
  '72': { lat: 48.00, lon: 0.20 },   '73': { lat: 45.57, lon: 5.92 },
  '74': { lat: 45.90, lon: 6.13 },   '75': { lat: 48.86, lon: 2.35 },
  '76': { lat: 49.44, lon: 1.10 },   '77': { lat: 48.54, lon: 2.66 },
  '78': { lat: 48.80, lon: 2.13 },   '79': { lat: 46.32, lon: -0.46 },
  '80': { lat: 49.89, lon: 2.30 },   '81': { lat: 43.93, lon: 2.15 },
  '82': { lat: 44.02, lon: 1.36 },   '83': { lat: 43.12, lon: 5.93 },
  '84': { lat: 43.95, lon: 4.81 },   '85': { lat: 46.67, lon: -1.43 },
  '86': { lat: 46.58, lon: 0.34 },   '87': { lat: 45.83, lon: 1.26 },
  '88': { lat: 48.18, lon: 6.45 },   '89': { lat: 47.80, lon: 3.57 },
  '90': { lat: 47.64, lon: 6.86 },   '91': { lat: 48.63, lon: 2.45 },
  '92': { lat: 48.89, lon: 2.21 },   '93': { lat: 48.91, lon: 2.45 },
  '94': { lat: 48.79, lon: 2.46 },   '95': { lat: 49.05, lon: 2.10 },
  '971': { lat: 16.27, lon: -61.55 },'972': { lat: 14.64, lon: -61.02 },
  '973': { lat: 4.90, lon: -52.32 }, '974': { lat: -21.11, lon: 55.53 },
  '976': { lat: -12.83, lon: 45.16 },
};

function departementCentroid(dep) {
  if (!dep) return null;
  const key = String(dep).trim().toUpperCase();
  return DEPARTEMENT_CENTROIDS[key] || null;
}

function _resetCacheForTests() {
  _cache.clear();
}

module.exports = {
  geocodeAddress,
  haversineKm,
  departementCentroid,
  CENTRE_FRANCE_METROPOLITAINE,
  DEPARTEMENT_CENTROIDS,
  _resetCacheForTests,
};
