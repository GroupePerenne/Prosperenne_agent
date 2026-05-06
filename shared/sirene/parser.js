'use strict';

/**
 * Parser CSV RFC 4180 minimal pour les exports SIRENE OpenDataSoft.
 *
 * Format ciblé :
 *   - Séparateur configurable (`;` par défaut, le CSV OpenDataSoft).
 *   - Encoding UTF-8 avec BOM optionnel en début de fichier.
 *   - Champs entre guillemets (`"..."`) si contiennent séparateur, retour ligne,
 *     ou guillemet doublé (`""`).
 *   - Première ligne = entêtes.
 *
 * Pas de dépendance externe. ~50 lignes utiles. Choix conscient pour respecter
 * l'invariant I-1 (réduction des dépendances tierces) et la discipline du capital
 * permanent V-1 (code Pereneo, audit possible).
 *
 * Limites assumées :
 *   - Pas de support des escape `\` style POSIX (le CSV INSEE ne l'utilise pas).
 *   - Lecture en mémoire — utilisable jusqu'à ~1M lignes (~600 MB à 600 octets/ligne).
 *     Pour les volumes plus gros, utiliser `parseStream` qui yield ligne par ligne.
 */

const DEFAULT_SEPARATOR = ';';
const BOM = '﻿';

/**
 * Parse un texte CSV complet en mémoire.
 *
 * @param {string} text          CSV complet (BOM toléré en tête)
 * @param {Object} [opts]
 * @param {string} [opts.separator]  Défaut ';'
 * @returns {{ headers: string[], rows: Array<Object> }}
 *   rows[i] = { headerName: cellValue, ... }
 */
function parse(text, opts = {}) {
  const separator = opts.separator || DEFAULT_SEPARATOR;
  if (typeof text !== 'string') {
    throw new TypeError('parse: text doit être une string');
  }
  // Strip BOM
  const clean = text.charCodeAt(0) === 0xFEFF || text.startsWith(BOM)
    ? text.slice(1)
    : text;
  const records = parseRecords(clean, separator);
  if (records.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = records[0].map((h) => String(h || '').trim());
  const rows = records.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = r[i] !== undefined ? r[i] : '';
    }
    return obj;
  });
  return { headers, rows };
}

/**
 * Parse en mode streaming : pour chaque ligne, yield un objet { ...headers }.
 * À utiliser avec un grand CSV stocké sur disque (lecture par chunks).
 *
 * Note V1 : le CSV INSEE filtré sweet spot fait < 100 MB, parse() in-memory
 * suffit. parseStream est le hook pour Phase 5+ scale France entière.
 *
 * @param {AsyncIterable<string>|Iterable<string>} chunks  Itérateur de chunks
 * @param {Object} [opts]                                  cf. parse()
 * @returns {AsyncGenerator<Object>}
 */
async function* parseStream(chunks, opts = {}) {
  const separator = opts.separator || DEFAULT_SEPARATOR;
  let buffer = '';
  let headers = null;
  let bomStripped = false;

  for await (const chunk of chunks) {
    buffer += String(chunk);
    if (!bomStripped) {
      if (buffer.charCodeAt(0) === 0xFEFF) buffer = buffer.slice(1);
      bomStripped = true;
    }
    // Sépare les lignes complètes (en respectant les guillemets multilignes)
    const records = parseRecords(buffer, separator, /* keepRemainder */ true);
    buffer = records._remainder || '';
    for (const r of records.records || []) {
      if (!headers) {
        headers = r.map((h) => String(h || '').trim());
        continue;
      }
      const obj = {};
      for (let i = 0; i < headers.length; i++) {
        obj[headers[i]] = r[i] !== undefined ? r[i] : '';
      }
      yield obj;
    }
  }
  // Flush du buffer résiduel
  if (buffer.trim()) {
    const final = parseRecords(buffer, separator, false);
    for (const r of final) {
      if (!headers) {
        headers = r.map((h) => String(h || '').trim());
        continue;
      }
      const obj = {};
      for (let i = 0; i < headers.length; i++) {
        obj[headers[i]] = r[i] !== undefined ? r[i] : '';
      }
      yield obj;
    }
  }
}

/**
 * Parser RFC 4180 état machine. Retourne un Array<Array<string>>.
 * Si `keepRemainder=true`, ne consomme pas la dernière ligne incomplète et
 * retourne `{ records, _remainder }` à la place.
 */
function parseRecords(text, separator, keepRemainder) {
  const records = [];
  let row = [];
  let field = '';
  let inQuote = false;
  let i = 0;
  let lastCompleteIdx = 0; // pour le mode streaming

  while (i < text.length) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    // Hors guillemets
    if (c === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (c === separator) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      i += 2;
      lastCompleteIdx = i;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      i++;
      lastCompleteIdx = i;
      continue;
    }
    field += c;
    i++;
  }

  if (keepRemainder) {
    return {
      records,
      _remainder: text.slice(lastCompleteIdx),
    };
  }
  // Flush dernière ligne (pas de \n en fin de fichier)
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

module.exports = {
  parse,
  parseStream,
  // Exposé pour tests
  _internals: { parseRecords },
};
