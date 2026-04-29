'use strict';

/**
 * Normalisation d'URL pour site-finder.
 *
 * Sortie canonique : `https://<host>[/<path>]` sans www., sans trailing slash
 * (sauf si le path est juste `/`), schéma forcé en https.
 *
 * Cible : sortie utilisée comme RowKey de cache et comme valeur retournée au
 * caller. Doit être idempotente (normalize(normalize(x)) === normalize(x)).
 *
 * Diffère de `shared/lead-exhauster/patterns.js#normalizeDomain` :
 *   - patterns.normalizeDomain retourne `acme.fr` (host seul)
 *   - urlNormalizer.normalize retourne `https://acme.fr` (URL complète)
 *
 * Les deux co-existent volontairement : domain seul est la sortie naturelle de
 * resolveDomain (lead-exhauster), URL complète est la sortie du site-finder.
 */

/**
 * Normalise une URL en forme canonique. Retourne null si l'entrée est invalide
 * (pas de host, host malformé, scheme non HTTP).
 *
 * @param {string} input
 * @returns {string|null}
 */
function normalize(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Préfixe scheme si absent — l'URL constructor exige un scheme
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let host = parsed.hostname.toLowerCase();
  if (!host) return null;
  if (host.startsWith('www.')) host = host.slice(4);

  // Validation host : doit contenir au moins un point, TLD ≥ 2 chars, pas
  // d'espace, pas de caractère invalide
  if (!/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  const tldMatch = /\.([a-z0-9-]+)$/.exec(host);
  if (!tldMatch || tldMatch[1].length < 2) return null;

  let pathname = parsed.pathname || '';
  // Strip trailing slash sauf si le path est juste "/"
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (pathname === '/') pathname = '';

  // On force https systématiquement (cf. doc en-tête)
  return `https://${host}${pathname}`;
}

/**
 * Extrait le host canonique (sans scheme, sans www., lowercase) d'une URL.
 * Utilisé pour comparer deux URLs au niveau host.
 *
 * @param {string} input
 * @returns {string|null}
 */
function extractHost(input) {
  const normalized = normalize(input);
  if (!normalized) return null;
  return new URL(normalized).hostname;
}

module.exports = {
  normalize,
  extractHost,
};
