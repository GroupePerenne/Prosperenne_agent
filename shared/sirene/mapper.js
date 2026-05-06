'use strict';

/**
 * Transforme une ligne SIRENE OpenDataSoft (champs `*etablissement` et
 * `*unitelegale`) en entité LeadBase format Pereneo.
 *
 * Décodage critique : OpenDataSoft expose les codes INSEE déjà décodés en
 * labels texte. Notre LeadBase utilise les codes INSEE traditionnels pour
 * cohérence avec `mappings/effectif-to-tranche-insee.json` et
 * `enrich-leadbase-continuous.js`. Ce mapper réencode les labels OpenDataSoft
 * vers les codes INSEE.
 *
 * Audit : la valeur label brute est conservée dans `trancheEffectifLabel`
 * pour permettre vérification a posteriori en cas de drift INSEE.
 *
 * Compatibilité multi-tenant V-2 : pas de hardcoding OSEYS. Les filtres
 * tranche / NAF sont appliqués en amont (orchestrateur), pas dans ce mapper.
 */

// Décodage label OpenDataSoft → code INSEE traditionnel.
// Source : nomenclature INSEE TEFEN (Tranche d'EFfectifs salariés au 31/12).
// https://www.insee.fr/fr/information/2028273
const TRANCHE_LABEL_TO_CODE = Object.freeze({
  'Etablissement non employeur': 'NN',
  '0 salarié': '00',
  '1 ou 2 salariés': '01',
  '3 à 5 salariés': '02',
  '6 à 9 salariés': '03',
  '10 à 19 salariés': '11',
  '20 à 49 salariés': '12',
  '50 à 99 salariés': '21',
  '100 à 199 salariés': '22',
  '200 à 249 salariés': '31',
  '250 à 499 salariés': '32',
  '500 à 999 salariés': '41',
  '1 000 à 1 999 salariés': '42',
  '2 000 à 4 999 salariés': '51',
  '5 000 à 9 999 salariés': '52',
  '10 000 salariés et plus': '53',
});

/**
 * Tranches sweet spot OSEYS par défaut (6-49 salariés).
 * Override par env SIRENE_TRANCHES_INCLUDE='03,11,12,21' pour mode LARGE.
 */
const DEFAULT_TRANCHES = ['03', '11', '12'];

function getConfiguredTranches() {
  const env = process.env.SIRENE_TRANCHES_INCLUDE;
  if (!env) return DEFAULT_TRANCHES;
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Décode un label tranche OpenDataSoft en code INSEE.
 * Retourne null si label inconnu.
 */
function decodeTrancheLabel(label) {
  if (!label) return null;
  return TRANCHE_LABEL_TO_CODE[String(label).trim()] || null;
}

/**
 * Code département extrait du code postal (2 premiers chars).
 * Cas spéciaux : Corse 2A/2B (codes postaux 200xx-201xx → 2A, 202xx-206xx → 2B
 * approximation v1, à raffiner si besoin), DOM 97x.
 */
function extractDepartement(codePostal) {
  if (!codePostal) return null;
  const cp = String(codePostal).trim();
  if (cp.length < 2) return null;
  // DOM (97x)
  if (cp.startsWith('97') && cp.length >= 3) return cp.slice(0, 3);
  // Corse : approximation par CP
  if (cp.startsWith('20')) {
    const num = parseInt(cp, 10);
    if (Number.isFinite(num)) {
      if (num >= 20000 && num <= 20190) return '2A';
      if (num >= 20200 && num <= 20620) return '2B';
    }
  }
  return cp.slice(0, 2);
}

/**
 * Compose une adresse postale lisible à partir des champs SIRENE.
 */
function composeAdresse(row) {
  const parts = [];
  const num = (row.numerovoieetablissement || '').trim();
  const indice = (row.indicerepetitionetablissement || '').trim();
  const type = (row.typevoieetablissement || '').trim();
  const libelle = (row.libellevoieetablissement || '').trim();
  if (num) parts.push(num + (indice ? ` ${indice}` : ''));
  if (type) parts.push(type);
  if (libelle) parts.push(libelle);
  return parts.join(' ').trim();
}

/**
 * Détermine la dénomination la plus utilisable.
 * Pour les sociétés : denominationunitelegale (nom officiel)
 * Pour les entreprises individuelles : composition prénom + nom
 * Fallback : denominationusuelle1unitelegale, sigleunitelegale, enseigne1etablissement
 */
function composeNom(row) {
  const denom = (row.denominationunitelegale || '').trim();
  if (denom) return denom;
  const usuelle = (row.denominationusuelle1unitelegale || '').trim();
  if (usuelle) return usuelle;
  const prenom = (row.prenom1unitelegale || row.prenomusuelunitelegale || '').trim();
  const nom = (row.nomunitelegale || '').trim();
  if (prenom || nom) return [prenom, nom].filter(Boolean).join(' ').toUpperCase();
  const sigle = (row.sigleunitelegale || '').trim();
  if (sigle) return sigle;
  const enseigne = (row.enseigne1etablissement || '').trim();
  return enseigne;
}

/**
 * Transforme une ligne SIRENE OpenDataSoft en entité LeadBase Pereneo.
 *
 * @param {Object} row              ligne CSV parsée (clés = headers OpenDataSoft)
 * @param {Object} [opts]
 * @param {string} [opts.runId]     UUID de la run d'ingestion
 * @param {string} [opts.snapshot]  Version snapshot ('YYYY-MM' ou date dump)
 * @returns {{ valid: boolean, entity?: Object, reason?: string }}
 */
function mapSireneRowToLeadBase(row, opts = {}) {
  if (!row || typeof row !== 'object') {
    return { valid: false, reason: 'invalid_row' };
  }
  const siren = String(row.siren || '').trim();
  if (!/^\d{9}$/.test(siren)) {
    return { valid: false, reason: 'invalid_siren' };
  }
  const trancheLabel = (row.trancheeffectifsetablissement || '').trim();
  const trancheCode = decodeTrancheLabel(trancheLabel);
  if (!trancheCode) {
    return { valid: false, reason: 'unknown_tranche_label' };
  }
  const codePostal = String(row.codepostaletablissement || '').trim();
  const dept = extractDepartement(codePostal);
  if (!dept) {
    return { valid: false, reason: 'cannot_extract_departement' };
  }
  const nom = composeNom(row);
  if (!nom) {
    return { valid: false, reason: 'no_denomination' };
  }
  const codeNaf = (row.activiteprincipaleetablissement || row.activiteprincipaleunitelegale || '').trim();

  const entity = {
    partitionKey: dept,
    rowKey: siren,
    siren,
    nom,
    sigle: (row.sigleunitelegale || '').trim() || undefined,
    codeNaf: codeNaf || undefined,
    categorieJuridique: (row.categoriejuridiqueunitelegale || '').trim() || undefined,
    trancheEffectif: trancheCode,
    trancheEffectifLabel: trancheLabel,
    adresse: composeAdresse(row) || undefined,
    codePostal: codePostal || undefined,
    ville: (row.libellecommuneetablissement || '').trim() || undefined,
    dateCreation: (row.datecreationetablissement || '').trim() || undefined,
    sireneSourcedAt: new Date().toISOString(),
    sireneSnapshotVersion: opts.snapshot || (row.datederniertraitementetablissement || '').trim() || undefined,
    sireneRunId: opts.runId || undefined,
  };

  // Personne physique (entreprise individuelle) : on garde le dirigeant
  // directement depuis SIRENE. Catégorie juridique commençant par '1' = PP.
  if (entity.categorieJuridique && entity.categorieJuridique.startsWith('1')) {
    const prenom = (row.prenom1unitelegale || row.prenomusuelunitelegale || '').trim();
    const nomDir = (row.nomunitelegale || '').trim();
    if (prenom) entity.prenomDirigeant = prenom;
    if (nomDir) entity.nomDirigeant = nomDir;
  }

  // Strip undefined pour rester lisible côté Storage Tables
  for (const k of Object.keys(entity)) {
    if (entity[k] === undefined) delete entity[k];
  }

  return { valid: true, entity };
}

module.exports = {
  mapSireneRowToLeadBase,
  decodeTrancheLabel,
  extractDepartement,
  composeNom,
  composeAdresse,
  getConfiguredTranches,
  // Constantes exposées
  TRANCHE_LABEL_TO_CODE,
  DEFAULT_TRANCHES,
};
