/**
 * Tests mapper SIRENE → LeadBase — shared/sirene/mapper.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapSireneRowToLeadBase,
  decodeTrancheLabel,
  extractDepartement,
  composeNom,
  composeAdresse,
  getConfiguredTranches,
  TRANCHE_LABEL_TO_CODE,
  DEFAULT_TRANCHES,
} = require('../../../shared/sirene/mapper');

// ─── decodeTrancheLabel ────────────────────────────────────────────────────

test('decodeTrancheLabel — labels sweet spot 6-49', () => {
  assert.equal(decodeTrancheLabel('6 à 9 salariés'), '03');
  assert.equal(decodeTrancheLabel('10 à 19 salariés'), '11');
  assert.equal(decodeTrancheLabel('20 à 49 salariés'), '12');
});

test('decodeTrancheLabel — labels élargis', () => {
  assert.equal(decodeTrancheLabel('50 à 99 salariés'), '21');
  assert.equal(decodeTrancheLabel('Etablissement non employeur'), 'NN');
  assert.equal(decodeTrancheLabel('10 000 salariés et plus'), '53');
});

test('decodeTrancheLabel — label inconnu → null', () => {
  assert.equal(decodeTrancheLabel('999 salariés'), null);
  assert.equal(decodeTrancheLabel(''), null);
  assert.equal(decodeTrancheLabel(null), null);
});

// ─── extractDepartement ────────────────────────────────────────────────────

test('extractDepartement — métropole 2 chars', () => {
  assert.equal(extractDepartement('75017'), '75');
  assert.equal(extractDepartement('13001'), '13');
  assert.equal(extractDepartement('44000'), '44');
});

test('extractDepartement — Corse 2A/2B', () => {
  assert.equal(extractDepartement('20000'), '2A');
  assert.equal(extractDepartement('20100'), '2A');
  assert.equal(extractDepartement('20200'), '2B');
  assert.equal(extractDepartement('20620'), '2B');
});

test('extractDepartement — DOM 3 chars', () => {
  assert.equal(extractDepartement('97400'), '974');
  assert.equal(extractDepartement('97100'), '971');
});

test('extractDepartement — code postal absent → null', () => {
  assert.equal(extractDepartement(''), null);
  assert.equal(extractDepartement(null), null);
  assert.equal(extractDepartement('1'), null);
});

// ─── composeNom ────────────────────────────────────────────────────────────

test('composeNom — denominationunitelegale prioritaire', () => {
  assert.equal(composeNom({
    denominationunitelegale: 'ACME SAS',
    denominationusuelle1unitelegale: 'ACME',
    sigleunitelegale: 'A',
  }), 'ACME SAS');
});

test('composeNom — fallback denominationusuelle si denominationunitelegale vide', () => {
  assert.equal(composeNom({
    denominationunitelegale: '',
    denominationusuelle1unitelegale: 'ACME USUAL',
  }), 'ACME USUAL');
});

test('composeNom — entreprise individuelle : prénom + nom upper', () => {
  assert.equal(composeNom({
    prenom1unitelegale: 'Pierre',
    nomunitelegale: 'Hertel',
  }), 'PIERRE HERTEL');
});

test('composeNom — fallback prenomusuel si prenom1 vide', () => {
  assert.equal(composeNom({
    prenomusuelunitelegale: 'Marie',
    nomunitelegale: 'Martin',
  }), 'MARIE MARTIN');
});

test('composeNom — fallback sigle ou enseigne', () => {
  assert.equal(composeNom({ sigleunitelegale: 'IBM' }), 'IBM');
  assert.equal(composeNom({ enseigne1etablissement: 'Chez Pierre' }), 'Chez Pierre');
});

test('composeNom — tout vide → string vide', () => {
  assert.equal(composeNom({}), '');
});

// ─── composeAdresse ────────────────────────────────────────────────────────

test('composeAdresse — adresse complète', () => {
  const adr = composeAdresse({
    numerovoieetablissement: '85',
    typevoieetablissement: 'Rue',
    libellevoieetablissement: 'JOUFFROY D\'ABBANS',
  });
  assert.equal(adr, '85 Rue JOUFFROY D\'ABBANS');
});

test('composeAdresse — avec indice répétition (bis/ter)', () => {
  const adr = composeAdresse({
    numerovoieetablissement: '12',
    indicerepetitionetablissement: 'bis',
    typevoieetablissement: 'Avenue',
    libellevoieetablissement: 'DE LA REPUBLIQUE',
  });
  assert.equal(adr, '12 bis Avenue DE LA REPUBLIQUE');
});

test('composeAdresse — adresse partielle', () => {
  assert.equal(composeAdresse({ libellevoieetablissement: 'PARC INDUSTRIEL' }), 'PARC INDUSTRIEL');
});

// ─── mapSireneRowToLeadBase — cas nominaux ────────────────────────────────

function buildSireneRow(overrides = {}) {
  return {
    siren: '834462061',
    nic: '00012',
    denominationunitelegale: 'AUDION',
    trancheeffectifsetablissement: '20 à 49 salariés',
    activiteprincipaleetablissement: '70.22Z',
    categoriejuridiqueunitelegale: '5710',
    numerovoieetablissement: '85',
    typevoieetablissement: 'Rue',
    libellevoieetablissement: 'JOUFFROY D\'ABBANS',
    codepostaletablissement: '75017',
    libellecommuneetablissement: 'PARIS',
    datecreationetablissement: '2018-03-12',
    datederniertraitementetablissement: '2026-01-15T10:00:00',
    etatadministratifetablissement: 'Actif',
    etablissementsiege: 'oui',
    ...overrides,
  };
}

test('mapper — entité société complète mappée correctement', () => {
  const row = buildSireneRow();
  const r = mapSireneRowToLeadBase(row, { runId: 'run-1', snapshot: '2026-05' });
  assert.equal(r.valid, true);
  assert.equal(r.entity.partitionKey, '75');
  assert.equal(r.entity.rowKey, '834462061');
  assert.equal(r.entity.siren, '834462061');
  assert.equal(r.entity.nom, 'AUDION');
  assert.equal(r.entity.codeNaf, '70.22Z');
  assert.equal(r.entity.trancheEffectif, '12');
  assert.equal(r.entity.trancheEffectifLabel, '20 à 49 salariés');
  assert.equal(r.entity.adresse, '85 Rue JOUFFROY D\'ABBANS');
  assert.equal(r.entity.codePostal, '75017');
  assert.equal(r.entity.ville, 'PARIS');
  assert.equal(r.entity.dateCreation, '2018-03-12');
  assert.equal(r.entity.sireneRunId, 'run-1');
  assert.equal(r.entity.sireneSnapshotVersion, '2026-05');
  // Pas de prénomDirigeant pour catégorie juridique 5710 (société)
  assert.equal(r.entity.prenomDirigeant, undefined);
});

test('mapper — entreprise individuelle : prénom/nom dirigeant exposés', () => {
  const row = buildSireneRow({
    categoriejuridiqueunitelegale: '1000',
    denominationunitelegale: '',
    prenom1unitelegale: 'Pierre',
    nomunitelegale: 'Hertel',
  });
  const r = mapSireneRowToLeadBase(row);
  assert.equal(r.valid, true);
  assert.equal(r.entity.nom, 'PIERRE HERTEL');
  assert.equal(r.entity.prenomDirigeant, 'Pierre');
  assert.equal(r.entity.nomDirigeant, 'Hertel');
});

// ─── mapSireneRowToLeadBase — invalides ───────────────────────────────────

test('mapper — siren invalide → invalid', () => {
  assert.equal(mapSireneRowToLeadBase(buildSireneRow({ siren: 'abc' })).reason, 'invalid_siren');
  assert.equal(mapSireneRowToLeadBase(buildSireneRow({ siren: '' })).reason, 'invalid_siren');
  assert.equal(mapSireneRowToLeadBase(buildSireneRow({ siren: '12345' })).reason, 'invalid_siren');
});

test('mapper — tranche label inconnue → invalid', () => {
  const r = mapSireneRowToLeadBase(buildSireneRow({
    trancheeffectifsetablissement: '999 employees',
  }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'unknown_tranche_label');
});

test('mapper — code postal invalide → invalid', () => {
  const r = mapSireneRowToLeadBase(buildSireneRow({ codepostaletablissement: '' }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'cannot_extract_departement');
});

test('mapper — pas de dénomination → invalid', () => {
  const r = mapSireneRowToLeadBase(buildSireneRow({
    denominationunitelegale: '',
    denominationusuelle1unitelegale: '',
    sigleunitelegale: '',
    enseigne1etablissement: '',
    prenom1unitelegale: '',
    nomunitelegale: '',
  }));
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'no_denomination');
});

test('mapper — row null → invalid', () => {
  assert.equal(mapSireneRowToLeadBase(null).valid, false);
  assert.equal(mapSireneRowToLeadBase(undefined).valid, false);
});

// ─── getConfiguredTranches ────────────────────────────────────────────────

test('getConfiguredTranches — défaut sweet spot 6-49', () => {
  delete process.env.SIRENE_TRANCHES_INCLUDE;
  assert.deepEqual(getConfiguredTranches(), DEFAULT_TRANCHES);
});

test('getConfiguredTranches — override env mode LARGE', () => {
  process.env.SIRENE_TRANCHES_INCLUDE = '03,11,12,21';
  try {
    assert.deepEqual(getConfiguredTranches(), ['03', '11', '12', '21']);
  } finally {
    delete process.env.SIRENE_TRANCHES_INCLUDE;
  }
});

// ─── Cohérence interne ────────────────────────────────────────────────────

test('TRANCHE_LABEL_TO_CODE — bijection complète sweet spot', () => {
  // Vérif cohérence : tous les codes du sweet spot ont un label
  for (const code of ['03', '11', '12', '21']) {
    const label = Object.keys(TRANCHE_LABEL_TO_CODE).find((l) => TRANCHE_LABEL_TO_CODE[l] === code);
    assert.ok(label, `pas de label pour code ${code}`);
  }
});
