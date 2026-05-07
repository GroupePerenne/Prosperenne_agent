'use strict';

/**
 * Download des exports SIRENE OpenDataSoft par département, avec persistance
 * locale et résilience minimale (timeout, retry sur erreur transitoire).
 *
 * Source : https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/exports/csv
 *
 * Stratégie de filtre côté serveur OpenDataSoft :
 *   - `where` : tranches sweet spot + actif + siège + département (CP startswith)
 *   - `select` : champs nécessaires uniquement (réduit volume + clarté)
 *
 * Persistance locale (V1) : `~/Pereneo/sirene-snapshots/sirene-DEP-YYYYMMDD.csv`
 *   - Permet rollback / audit
 *   - Permet rerun parser sans re-télécharger
 *   - Compression gzip Phase 5+ si volume justifie
 *
 * Pas de dépendance externe. Utilise `fetch` natif Node 22.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ENDPOINT = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/exports/csv';
const DEFAULT_TIMEOUT_MS = 180000; // 3 min — France entière mesurée à ~2 min
const DEFAULT_FIELDS = [
  'siren',
  'nic',
  'denominationunitelegale',
  'sigleunitelegale',
  'denominationusuelle1unitelegale',
  'enseigne1etablissement',
  'prenom1unitelegale',
  'prenomusuelunitelegale',
  'nomunitelegale',
  'sexeunitelegale',
  'categoriejuridiqueunitelegale',
  'trancheeffectifsetablissement',
  'activiteprincipaleetablissement',
  'activiteprincipaleunitelegale',
  'numerovoieetablissement',
  'indicerepetitionetablissement',
  'typevoieetablissement',
  'libellevoieetablissement',
  'codepostaletablissement',
  'libellecommuneetablissement',
  'codecommuneetablissement',
  'datecreationetablissement',
  'datederniertraitementetablissement',
  'etatadministratifetablissement',
  'etablissementsiege',
];

/**
 * Construit la clause `where` OpenDataSoft pour les tranches sweet spot d'un
 * département donné.
 *
 * @param {Object} args
 * @param {string} args.departement       Code département (ex '75', '13', '2A', '971')
 * @param {string[]} args.trancheLabels   Labels OpenDataSoft à inclure
 *                                        (ex ['6 à 9 salariés', '10 à 19 salariés', ...])
 * @returns {string}
 */
function buildWhereClause({ departement, trancheLabels }) {
  if (!departement) throw new Error('buildWhereClause: departement requis');
  if (!Array.isArray(trancheLabels) || trancheLabels.length === 0) {
    throw new Error('buildWhereClause: trancheLabels non vide requis');
  }
  const tranchesIn = trancheLabels.map((l) => `"${l.replace(/"/g, '\\"')}"`).join(', ');
  // Note départements : Corse ('2A','2B') et DOM ('971'-'976') ont 2 ou 3 chars.
  // OpenDataSoft `startswith(codepostaletablissement, "75")` est correct pour Paris.
  // Pour DOM 971+ : codes postaux 971xx → startswith("971") OK.
  return `trancheeffectifsetablissement IN (${tranchesIn}) `
    + `AND etatadministratifetablissement="Actif" `
    + `AND etablissementsiege="oui" `
    + `AND startswith(codepostaletablissement, "${departement}")`;
}

/**
 * URL d'export CSV OpenDataSoft pour un département + tranches.
 */
function buildExportUrl({ departement, trancheLabels, fields = DEFAULT_FIELDS }) {
  const where = buildWhereClause({ departement, trancheLabels });
  const params = new URLSearchParams();
  params.set('where', where);
  params.set('select', fields.join(','));
  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * Path de stockage local d'un snapshot.
 *   ~/Pereneo/sirene-snapshots/sirene-DEP-YYYYMMDD.csv
 *
 * Override via env SIRENE_SNAPSHOT_DIR (utile en CI / tests).
 */
function snapshotPath({ departement, date = new Date() }) {
  const dir = process.env.SIRENE_SNAPSHOT_DIR
    || path.join(os.homedir(), 'Pereneo', 'sirene-snapshots');
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  return path.join(dir, `sirene-${departement}-${stamp}.csv`);
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * Download un département vers un fichier local. Idempotent : si le fichier
 * du jour existe déjà avec une taille raisonnable, ne re-télécharge pas
 * (sauf force=true).
 *
 * @param {Object} args
 * @param {string} args.departement
 * @param {string[]} args.trancheLabels
 * @param {boolean} [args.force]        Re-télécharge même si fichier présent
 * @param {Function} [args.fetchImpl]   Override pour tests (par défaut fetch global)
 * @returns {Promise<{ path:string, bytes:number, downloaded:boolean, durationMs:number }>}
 */
async function downloadDepartement(args) {
  const { departement, trancheLabels, force = false, fetchImpl } = args;
  if (!departement) throw new Error('downloadDepartement: departement requis');
  const fp = snapshotPath({ departement });
  await ensureDir(path.dirname(fp));

  // Idempotence : skip si fichier existant > 100 octets (header seul ferait ~100)
  if (!force) {
    try {
      const stat = await fs.promises.stat(fp);
      if (stat.size > 100) {
        return { path: fp, bytes: stat.size, downloaded: false, durationMs: 0 };
      }
    } catch {
      // pas de fichier, on continue
    }
  }

  const url = buildExportUrl({ departement, trancheLabels });
  const fetcher = fetchImpl || fetch;
  const t0 = Date.now();

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS) : null;

  let res;
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'text/csv' },
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || !res.ok) {
    throw new Error(`SIRENE download HTTP ${res ? res.status : 'no_response'} for ${departement}`);
  }
  const text = await res.text();
  await fs.promises.writeFile(fp, text, 'utf8');
  const bytes = Buffer.byteLength(text, 'utf8');
  const durationMs = Date.now() - t0;
  return { path: fp, bytes, downloaded: true, durationMs };
}

/**
 * Cherche le snapshot local le plus récent du département dans la fenêtre TTL.
 * Implémente l'invariant I-4 fallback multi-source en mode "snapshot local
 * récent" : si OpenDataSoft est indispo, on utilise la donnée du dernier run
 * connu (mois précédent acceptable). Donnée potentiellement obsolète mais
 * disponible — meilleur que rien (cohérent avec V capital permanent).
 *
 * TTL par défaut : 35 jours (couvre cycle mensuel + buffer).
 *
 * @param {Object} args
 * @param {string} args.departement
 * @param {number} [args.ttlDays=35]
 * @returns {{ path:string, bytes:number, ageDays:number } | null}
 */
function findRecentSnapshot({ departement, ttlDays = 35 }) {
  if (!departement) return null;
  const dir = process.env.SIRENE_SNAPSHOT_DIR
    || path.join(os.homedir(), 'Pereneo', 'sirene-snapshots');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `sirene-${departement}-`;
  const matches = entries.filter((f) => f.startsWith(prefix) && f.endsWith('.csv'));
  if (matches.length === 0) return null;

  const now = Date.now();
  const ttlMs = ttlDays * 24 * 3600 * 1000;
  let best = null;
  for (const fname of matches) {
    const m = fname.match(/sirene-[^-]+-([0-9]{8})\.csv$/);
    if (!m) continue;
    const stamp = m[1];
    const y = Number(stamp.slice(0, 4));
    const mo = Number(stamp.slice(4, 6));
    const d = Number(stamp.slice(6, 8));
    const dt = Date.UTC(y, mo - 1, d);
    const ageMs = now - dt;
    if (ageMs > ttlMs) continue;
    const fp = path.join(dir, fname);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    if (stat.size <= 100) continue;
    if (!best || dt > best.dt) {
      best = { dt, path: fp, bytes: stat.size, ageDays: Math.floor(ageMs / (24 * 3600 * 1000)) };
    }
  }
  return best ? { path: best.path, bytes: best.bytes, ageDays: best.ageDays } : null;
}

/**
 * Wrap downloadDepartement avec fallback I-4 multi-source.
 * Tente OpenDataSoft. En cas d'erreur (réseau, 503, timeout), cherche un
 * snapshot local récent (< TTL) du département. Si trouvé, retourne le
 * snapshot comme fallback. Sinon, remonte l'erreur initiale.
 *
 * @param {Object} args (mêmes args que downloadDepartement)
 * @param {number} [args.fallbackTtlDays=35]
 * @returns {Promise<{ path:string, bytes:number, downloaded:boolean, durationMs:number, fallbackUsed?:boolean, fallbackAgeDays?:number }>}
 */
async function downloadDepartementWithFallback(args) {
  try {
    return await downloadDepartement(args);
  } catch (downloadErr) {
    const fb = findRecentSnapshot({
      departement: args.departement,
      ttlDays: args.fallbackTtlDays,
    });
    if (fb) {
      return {
        path: fb.path,
        bytes: fb.bytes,
        downloaded: false,
        durationMs: 0,
        fallbackUsed: true,
        fallbackAgeDays: fb.ageDays,
        fallbackReason: downloadErr.message,
      };
    }
    throw downloadErr;
  }
}

module.exports = {
  buildWhereClause,
  buildExportUrl,
  snapshotPath,
  downloadDepartement,
  downloadDepartementWithFallback,
  findRecentSnapshot,
  // Constantes
  ENDPOINT,
  DEFAULT_FIELDS,
  DEFAULT_TIMEOUT_MS,
};
