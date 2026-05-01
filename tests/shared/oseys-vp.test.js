'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vp = require('../../shared/oseys-vp');

// ─── Cohérence structurelle ────────────────────────────────────────────────

test('module expose les 9 constantes critiques + 3 fonctions de sélection', () => {
  for (const key of [
    'IDENTITY', 'BASELINE', 'FORMULATIONS', 'TARGET', 'EXCLUSIONS',
    'VERBATIMS_DIRIGEANTS', 'VALEURS_CONSULTANT', 'ANGLES_ENTREE',
    'MODULATION_DISC', 'ANTI_PATTERNS_VOCABULAIRE', 'REGLES_HONNEUR',
    'PROOF_POINTS_SOURCABLES', 'POSITIONNEMENT_ETHIQUE', 'OFFER_TYPES',
  ]) {
    assert.ok(vp[key], `constante ${key} manquante`);
  }
  for (const fn of ['selectAngleFromEnrichment', 'selectDiscModulation', 'selectProofPoints']) {
    assert.equal(typeof vp[fn], 'function', `fonction ${fn} manquante`);
  }
});

test('BASELINE est exactement la formulation validée Paul', () => {
  assert.equal(vp.BASELINE, 'Vos décisions méritent un allié.');
});

test('5 angles d\'entrée présents avec ids canoniques', () => {
  const expectedIds = ['croissance', 'stagnation', 'transmission', 'mutation_sectorielle', 'pas_de_signal'];
  const actualIds = vp.ANGLES_ENTREE.map((a) => a.id);
  assert.deepEqual(actualIds.sort(), expectedIds.sort());
});

test('angle transmission a manier_avec_precaution=true et garde_fou explicite', () => {
  const transmission = vp.ANGLES_ENTREE.find((a) => a.id === 'transmission');
  assert.equal(transmission.manier_avec_precaution, true);
  assert.match(transmission.garde_fou, /NE JAMAIS PRÉSUMER/);
});

test('angle pas_de_signal est marqué cas_le_plus_frequent', () => {
  const fallback = vp.ANGLES_ENTREE.find((a) => a.id === 'pas_de_signal');
  assert.equal(fallback.cas_le_plus_frequent, true);
});

test('modulation DISC couvre les 4 axes avec consigne_ton et longueur_cible_J0', () => {
  for (const axe of ['D', 'I', 'S', 'C']) {
    assert.ok(vp.MODULATION_DISC[axe], `axe ${axe} manquant`);
    assert.ok(vp.MODULATION_DISC[axe].consigne_ton, `consigne_ton manquante pour ${axe}`);
    assert.ok(vp.MODULATION_DISC[axe].longueur_cible_J0, `longueur_cible_J0 manquante pour ${axe}`);
  }
});

test('OFFER_TYPES expose lead et rdv-cale avec call_to_action et handle_positive_reply', () => {
  for (const offer of ['lead', 'rdv-cale']) {
    assert.ok(vp.OFFER_TYPES[offer], `offer ${offer} manquant`);
    assert.ok(vp.OFFER_TYPES[offer].call_to_action_J0);
    assert.ok(vp.OFFER_TYPES[offer].handle_positive_reply);
  }
});

test('POSITIONNEMENT_ETHIQUE acte agent_never_impersonates et reply_to_is_sender', () => {
  assert.equal(vp.POSITIONNEMENT_ETHIQUE.agent_never_impersonates, true);
  assert.equal(vp.POSITIONNEMENT_ETHIQUE.reply_to_is_sender, true);
});

test('TARGET définit la fenêtre 5-75 et sweet spot 10-40', () => {
  assert.equal(vp.TARGET.size_min, 5);
  assert.equal(vp.TARGET.size_max, 75);
  assert.equal(vp.TARGET.sweet_spot_min, 10);
  assert.equal(vp.TARGET.sweet_spot_max, 40);
});

test('EXCLUSIONS bloque compta+avocats, <5, B2C', () => {
  assert.ok(vp.EXCLUSIONS.partner_only_sectors.some((s) => /comptable/i.test(s)));
  assert.ok(vp.EXCLUSIONS.partner_only_sectors.some((s) => /avocat/i.test(s)));
  assert.equal(vp.EXCLUSIONS.size_under, 5);
  assert.ok(vp.EXCLUSIONS.business_models.some((m) => /B2C/i.test(m)));
});

test('VERBATIMS_DIRIGEANTS contient les 6 phrases ground truth Paul', () => {
  assert.equal(vp.VERBATIMS_DIRIGEANTS.length, 6);
  const allText = vp.VERBATIMS_DIRIGEANTS.join(' ');
  assert.match(allText, /expert-comptable/);
  assert.match(allText, /seul/);
  assert.match(allText, /argent sur la table/);
});

test('ANTI_PATTERNS_VOCABULAIRE inclut les 7 patterns critiques', () => {
  const allText = JSON.stringify(vp.ANTI_PATTERNS_VOCABULAIRE).toLowerCase();
  assert.match(allText, /clé en main/);
  assert.match(allText, /méthode propriétaire|framework éprouvé|roi garanti/i);
  assert.match(allText, /disruption|scale-up|hypercroissance/i);
  assert.match(allText, /promesse chiffrée|charlatan/);
  assert.match(allText, /chiffrage|tarif|devis/i);
  assert.match(allText, /ia|automatisation/i);
});

test('REGLES_HONNEUR contient au moins les 6 règles structurelles', () => {
  assert.ok(vp.REGLES_HONNEUR.length >= 6);
  const allText = vp.REGLES_HONNEUR.join(' ').toLowerCase();
  assert.match(allText, /jamais inventer/);
  assert.match(allText, /jamais promettre/);
  assert.match(allText, /jamais proposer un chiffrage/);
  assert.match(allText, /jamais mentionner l'ia/);
  assert.match(allText, /jamais usurper/);
  assert.match(allText, /escalader|escalation/);
});

// ─── selectAngleFromEnrichment — heuristique de priorité ──────────────────

test('selectAngleFromEnrichment retourne croissance si signal hiring/fundraising', () => {
  const result = vp.selectAngleFromEnrichment({
    companyProfile: { recentSignals: [{ type: 'hiring', description: 'recrutement développeur' }] },
  });
  assert.equal(result.id, 'croissance');
});

test('selectAngleFromEnrichment retourne mutation si signal press réglementaire', () => {
  const result = vp.selectAngleFromEnrichment({
    companyProfile: { recentSignals: [{ type: 'press', description: 'nouvelle réglementation sectorielle' }] },
  });
  assert.equal(result.id, 'mutation_sectorielle');
});

test('selectAngleFromEnrichment retourne transmission seulement si âge 25+ ET signal cession', () => {
  // Sans signal cession → pas transmission
  const r1 = vp.selectAngleFromEnrichment({
    decisionMakerProfile: { career: { tenure: '30 ans' } },
  });
  assert.notEqual(r1.id, 'transmission');

  // Avec signal cession → transmission
  const r2 = vp.selectAngleFromEnrichment({
    companyProfile: { recentSignals: [{ type: 'press', description: 'cession en cours' }] },
    decisionMakerProfile: { career: { tenure: '30 ans' } },
  });
  assert.equal(r2.id, 'transmission');
});

test('selectAngleFromEnrichment retourne stagnation si tenure 10+ et 0 signal', () => {
  const result = vp.selectAngleFromEnrichment({
    companyProfile: { recentSignals: [] },
    decisionMakerProfile: { career: { tenure: '15 ans' } },
  });
  assert.equal(result.id, 'stagnation');
});

test('selectAngleFromEnrichment retourne pas_de_signal en fallback', () => {
  const result = vp.selectAngleFromEnrichment({});
  assert.equal(result.id, 'pas_de_signal');
});

test('selectAngleFromEnrichment retourne pas_de_signal si tenure récente sans signal', () => {
  const result = vp.selectAngleFromEnrichment({
    companyProfile: { recentSignals: [] },
    decisionMakerProfile: { career: { tenure: '3 ans' } },
  });
  assert.equal(result.id, 'pas_de_signal');
});

// ─── selectDiscModulation ──────────────────────────────────────────────────

test('selectDiscModulation retourne la modulation pour D/I/S/C', () => {
  for (const axe of ['D', 'I', 'S', 'C']) {
    const r = vp.selectDiscModulation({ primary: axe });
    assert.ok(r);
    assert.ok(r.consigne_ton);
  }
});

test('selectDiscModulation retourne null si DISC unknown ou absent', () => {
  assert.equal(vp.selectDiscModulation({ primary: 'unknown' }), null);
  assert.equal(vp.selectDiscModulation(null), null);
  assert.equal(vp.selectDiscModulation({}), null);
});

// ─── selectProofPoints ─────────────────────────────────────────────────────

test('selectProofPoints retourne au moins 1 proof point pour chaque angle', () => {
  for (const angleId of ['croissance', 'stagnation', 'transmission', 'mutation_sectorielle', 'pas_de_signal']) {
    const points = vp.selectProofPoints(angleId);
    assert.ok(points.length >= 1, `pas de proof point pour ${angleId}`);
    for (const p of points) {
      assert.ok(p.stat);
      assert.ok(p.source);
    }
  }
});

test('selectProofPoints retourne fallback visibilité si angle inconnu', () => {
  const points = vp.selectProofPoints('inconnu-xyz');
  assert.ok(points.length >= 1);
});

// ─── Doctrine vs implémentation — alignement ──────────────────────────────

test('FORMULATIONS contient bien les 3 références Paul (très court / phrase / pitch 2 phrases)', () => {
  assert.match(vp.FORMULATIONS.tres_court, /copilote/i);
  assert.match(vp.FORMULATIONS.phrase, /pilotage économique/i);
  assert.match(vp.FORMULATIONS.pitch_2_phrases, /réseau de consultants indépendants/i);
});

test('IDENTITY déclare role=copilote et metier=pilotage économique', () => {
  assert.equal(vp.IDENTITY.role, 'copilote');
  assert.equal(vp.IDENTITY.metier, 'pilotage économique');
});
