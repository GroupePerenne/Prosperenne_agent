/**
 * Tests unitaires — shared/leadSelector.js — mapBriefToFilters et helpers
 * de mapping (déduction département, exclusions, format sortie).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapBriefToFilters,
  applyExclusions,
  extractLeadFromEntity,
  inferDepartementFromBrief,
  deduceDepartements,
} = require('../../../shared/leadSelector');

// ─── mapBriefToFilters ──────────────────────────────────────────────────────

test('mapBriefToFilters — un seul secteur ESN + une tranche', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '10-20',
    zone: 'france',
  });
  assert.ok(f.nafCodes.includes('62.02A'));
  assert.ok(f.nafCodes.includes('62.01Z'));
  assert.deepEqual(f.effectifCodes, ['11']);
  assert.deepEqual(f.departements, []); // france entière
});

test('mapBriefToFilters — plusieurs secteurs : union dédupliquée et triée', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn,architecture',
    effectif: 'any',
    zone: 'france',
  });
  // 62.01Z (ESN) et 71.11Z (architecture) doivent être présents,
  // ordre alphabétique
  assert.ok(f.nafCodes.includes('62.01Z'));
  assert.ok(f.nafCodes.includes('71.11Z'));
  // pas de doublon
  assert.equal(new Set(f.nafCodes).size, f.nafCodes.length);
  // tranches "any" → 5 valeurs INSEE
  assert.deepEqual(f.effectifCodes, ['02', '03', '11', '12', '21']);
});

test('mapBriefToFilters — tag inconnu : warn + ignoré (pas de crash)', () => {
  const warns = [];
  const ctx = { warn: (m) => warns.push(m) };
  const f = mapBriefToFilters(
    {
      secteurs: 'esn,iautrechose,architecture',
      effectif: '10-20',
      zone: 'france',
    },
    { context: ctx },
  );
  assert.ok(warns.some((w) => w.includes('iautrechose')));
  // Les autres tags doivent quand même être traités
  assert.ok(f.nafCodes.includes('62.02A'));
  assert.ok(f.nafCodes.includes('71.11Z'));
});

test('mapBriefToFilters — secteurs_autres : codes NAF valides ajoutés, invalides warn', () => {
  const warns = [];
  const ctx = { warn: (m) => warns.push(m) };
  const f = mapBriefToFilters(
    {
      secteurs: 'esn',
      secteurs_autres: '70.22Z, INVALIDE, 12.34Y',
      effectif: '10-20',
      zone: 'france',
    },
    { context: ctx },
  );
  assert.ok(f.nafCodes.includes('70.22Z'));
  assert.ok(f.nafCodes.includes('12.34Y'));
  assert.ok(!f.nafCodes.includes('INVALIDE'));
  assert.ok(warns.some((w) => w.includes('INVALIDE')));
});

test('mapBriefToFilters — effectif vide : fallback 11/12/21', () => {
  const warns = [];
  const ctx = { warn: (m) => warns.push(m) };
  const f = mapBriefToFilters(
    { secteurs: 'esn', zone: 'france' },
    { context: ctx },
  );
  assert.deepEqual(f.effectifCodes, ['11', '12', '21']);
  assert.ok(warns.some((w) => w.includes('fallback')));
});

test('mapBriefToFilters — effectif "5-10,40-75" : union INSEE', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '5-10,40-75',
    zone: 'france',
  });
  // 5-10 → 02, 03 ; 40-75 → 12, 21
  assert.deepEqual(f.effectifCodes, ['02', '03', '12', '21']);
});

test('mapBriefToFilters — zone="region" + CP Paris : 8 dépts Île-de-France', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '10-20',
    zone: 'region',
    ville: '75003 Paris',
  });
  // IDF = 75, 77, 78, 91, 92, 93, 94, 95
  assert.equal(f.departements.length, 8);
  for (const d of ['75', '77', '78', '91', '92', '93', '94', '95']) {
    assert.ok(f.departements.includes(d), `missing dep ${d}`);
  }
});

test('mapBriefToFilters — zone="region" + CP Lyon : 12 dépts Auvergne-Rhône-Alpes', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '10-20',
    zone: 'region',
    ville: '69003 Lyon',
  });
  assert.equal(f.departements.length, 12);
  assert.ok(f.departements.includes('69'));
  assert.ok(f.departements.includes('38'));
  assert.ok(f.departements.includes('74'));
});

test('mapBriefToFilters — zone="region" sans CP exploitable : []', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '10-20',
    zone: 'region',
    ville: 'Paris', // pas de CP
  });
  assert.deepEqual(f.departements, []);
});

test('mapBriefToFilters — zone "adresse" + CP Paris : départements proches inclus', () => {
  const f = mapBriefToFilters({
    secteurs: 'esn',
    effectif: '10-20',
    zone: 'adresse',
    zone_rayon: '25',
    ville: '75003 Paris',
  });
  // Doit contenir 75 et au moins quelques voisins (92, 93, 94, 77, 78, 91, 95)
  assert.ok(f.departements.includes('75'));
  assert.ok(f.departements.includes('92'));
  assert.ok(f.departements.length > 1);
  assert.ok(f.departements.length < 90); // pas la France entière
});

test('mapBriefToFilters — pas de secteur mappé : nafCodes=[]', () => {
  const warns = [];
  const ctx = { warn: (m) => warns.push(m) };
  const f = mapBriefToFilters(
    { secteurs: 'totalement_inconnu', effectif: '10-20', zone: 'france' },
    { context: ctx },
  );
  assert.deepEqual(f.nafCodes, []);
});

// ─── inferDepartementFromBrief ──────────────────────────────────────────────

test('inferDepartementFromBrief — CP métropole', () => {
  assert.equal(inferDepartementFromBrief({ ville: '69003 Lyon' }), '69');
  assert.equal(inferDepartementFromBrief({ adresse: '1 rue Test, 75011 Paris' }), '75');
});

test('inferDepartementFromBrief — Corse 2A vs 2B (pivot 20200)', () => {
  assert.equal(inferDepartementFromBrief({ ville: '20000 Ajaccio' }), '2A');
  assert.equal(inferDepartementFromBrief({ ville: '20300 Bastia' }), '2B');
});

test('inferDepartementFromBrief — DOM (3 chars)', () => {
  assert.equal(inferDepartementFromBrief({ ville: '97400 Saint-Denis (974)' }), '974');
});

test('inferDepartementFromBrief — pas de CP : null', () => {
  assert.equal(inferDepartementFromBrief({ ville: 'Paris' }), null);
  assert.equal(inferDepartementFromBrief({}), null);
});

// ─── deduceDepartements direct ──────────────────────────────────────────────

test('deduceDepartements — france → []', () => {
  assert.deepEqual(deduceDepartements({ zone: 'france' }), []);
});

test('deduceDepartements — adresse Lyon avec rayon 0 → just 69 + voisins immédiats', () => {
  const out = deduceDepartements({ zone: 'adresse', ville: '69001 Lyon', zone_rayon: '0' });
  assert.ok(out.includes('69'));
  // 100km de marge : voisins comme 38, 42, 01 doivent figurer
  assert.ok(out.includes('38'));
});

test('deduceDepartements — pas de CP exploitable : []', () => {
  assert.deepEqual(deduceDepartements({ zone: 'adresse', ville: 'Paris' }), []);
});

// ─── applyExclusions ───────────────────────────────────────────────────────

test('applyExclusions — codes 69.10Z et 69.20Z exclus', () => {
  const entities = [
    { siren: '1', codeNaf: '62.02A' },
    { siren: '2', codeNaf: '69.10Z' },
    { siren: '3', codeNaf: '69.20Z' },
    { siren: '4', codeNaf: '70.22Z' },
  ];
  const { kept, excluded } = applyExclusions(entities);
  assert.equal(kept.length, 2);
  assert.equal(excluded.length, 2);
  assert.ok(kept.every((e) => e.codeNaf !== '69.10Z' && e.codeNaf !== '69.20Z'));
});

// ─── extractLeadFromEntity ─────────────────────────────────────────────────

test('extractLeadFromEntity — dirigeant avec email → lead complet', () => {
  const e = {
    siren: '111',
    nom: 'Acme SAS',
    codeNaf: '62.02A',
    ville: 'Paris',
    trancheEffectif: '11',
    dirigeants: JSON.stringify([
      { prenoms: 'Jean', nom: 'Dupont', email: 'j.dupont@acme.fr' },
    ]),
  };
  const lead = extractLeadFromEntity(e);
  // Extension Jalon 3 (Path additif b') : DTO enrichi avec siren pour
  // permettre à lead-exhauster de résoudre l'email côté pipeline aval.
  assert.deepEqual(lead, {
    siren: '111',
    prenom: 'Jean',
    nom: 'Dupont',
    entreprise: 'Acme SAS',
    email: 'j.dupont@acme.fr',
    secteur: '62.02A',
    ville: 'Paris',
    contexte: 'Acme SAS · NAF 62.02A · tranche 11 · Paris',
  });
});

test('extractLeadFromEntity — sans email → null (V1 stricte)', () => {
  const e = {
    siren: '111',
    nom: 'Acme SAS',
    codeNaf: '62.02A',
    dirigeants: JSON.stringify([{ prenoms: 'Jean', nom: 'Dupont' }]),
  };
  assert.equal(extractLeadFromEntity(e), null);
});

test('extractLeadFromEntity — dirigeants vide → null', () => {
  assert.equal(extractLeadFromEntity({ siren: '1', dirigeants: '[]' }), null);
});

test('extractLeadFromEntity — dirigeants JSON corrompu → null', () => {
  assert.equal(extractLeadFromEntity({ siren: '1', dirigeants: 'not-json' }), null);
});

test('extractLeadFromEntity — alias prenom (singulier) accepté', () => {
  const e = {
    siren: '1',
    nom: 'Acme',
    codeNaf: '62.02A',
    dirigeants: JSON.stringify([{ prenom: 'Marie', nom: 'Curie', email: 'mc@acme.fr' }]),
  };
  const lead = extractLeadFromEntity(e);
  assert.equal(lead.prenom, 'Marie');
  assert.equal(lead.email, 'mc@acme.fr');
});
