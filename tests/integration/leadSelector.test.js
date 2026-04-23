/**
 * Tests d'intégration — selectLeadsForConsultant end-to-end avec
 * LeadBaseAdapter et trace mockés.
 *
 * Couvre les 4 cas de status (ok, insufficient, empty, error) et les
 * comportements de tri / exclusions / format de sortie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { LeadBaseAdapter } = require('../../shared/adapters/leadbase/leadbase-table');
const { selectLeadsForConsultant } = require('../../shared/leadSelector');

function dirigeantsJson(opts = {}) {
  return JSON.stringify([{
    prenoms: opts.prenom || 'Jean',
    nom: opts.nom || 'Dupont',
    email: opts.email || 'j.dupont@example.fr',
  }]);
}

function entity({ siren, nom, codeNaf = '62.02A', ville = 'Paris', tranche = '11', email, lat, lon }) {
  return {
    siren, nom, codeNaf, ville,
    trancheEffectif: tranche,
    latitude: lat,
    longitude: lon,
    dirigeants: dirigeantsJson({ email, prenom: 'Lead', nom: nom }),
  };
}

function makeMockTableClient(entities) {
  return {
    listEntities: () => (async function* () { for (const e of entities) yield e; })(),
  };
}

function makeAdapters(entities) {
  const tableClient = makeMockTableClient(entities);
  const leadBase = new LeadBaseAdapter({ tableClient });
  const traceCalls = [];
  const trace = async (event) => {
    traceCalls.push(event);
    return event;
  };
  return { leadBase, trace, traceCalls };
}

const BRIEF_PARIS = {
  nom: 'Morgane De Jessey',
  email: 'm.dejessey@oseys.fr',
  secteurs: 'esn',
  effectif: '10-20,20-40',
  zone: 'adresse',
  zone_rayon: '30',
  ville: '75003 Paris',
};

// ─── Cas nominal : status='ok' ───────────────────────────────────────────────

test('integration — status=ok : 12 candidats, batch 10 retourné, tri distance desc', async () => {
  // 12 entités, lat/lon variées : la plus loin de Paris doit arriver en tête
  const entities = [];
  for (let i = 0; i < 12; i++) {
    entities.push(entity({
      siren: `1110${i}`,
      nom: `Entreprise ${i}`,
      codeNaf: '62.02A',
      ville: `Ville${i}`,
      tranche: '11',
      email: `lead${i}@co.fr`,
      lat: 48.5 + i * 0.1,
      lon: 2.0 + i * 0.5,
    }));
  }
  const { leadBase, trace, traceCalls } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'ok');
  assert.equal(res.leads.length, 10);
  assert.equal(res.meta.requested, 10);
  assert.equal(res.meta.candidatesCount, 12);
  assert.equal(res.meta.returned, 10);
  // Le premier lead (le plus loin) doit avoir le lon le plus à l'est
  // (entités 11 a lon = 2.0 + 11*0.5 = 7.5, entité 0 a lon = 2.0)
  assert.equal(res.leads[0].entreprise, 'Entreprise 11');
  // Trace appelée 1 fois
  assert.equal(traceCalls.length, 1);
  assert.equal(traceCalls[0].status, 'ok');
});

// ─── Cas insuffisant ────────────────────────────────────────────────────────

test('integration — status=insufficient : 3 candidats avec email, batch 10 demandé', async () => {
  const entities = [
    entity({ siren: '1', nom: 'Co1', email: 'a@co.fr', lat: 48.5, lon: 2.0 }),
    entity({ siren: '2', nom: 'Co2', email: 'b@co.fr', lat: 48.7, lon: 2.4 }),
    entity({ siren: '3', nom: 'Co3', email: 'c@co.fr', lat: 49.0, lon: 2.5 }),
  ];
  const { leadBase, trace, traceCalls } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'insufficient');
  assert.equal(res.leads.length, 3);
  assert.equal(res.meta.returned, 3);
  assert.equal(traceCalls[0].status, 'insufficient');
});

// ─── Cas vide : pas de secteur mappé ────────────────────────────────────────

test('integration — status=empty : aucun secteur mappé', async () => {
  const { leadBase, trace, traceCalls } = makeAdapters([]);

  const res = await selectLeadsForConsultant({
    brief: { ...BRIEF_PARIS, secteurs: 'inconnu_xyz' },
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'empty');
  assert.equal(res.leads.length, 0);
  assert.equal(res.meta.reason, 'no_sector_mapped');
  assert.equal(traceCalls[0].status, 'empty');
});

// ─── Cas vide : 100% sans email ─────────────────────────────────────────────

test('integration — status=empty : tous les candidats sans email exploitable', async () => {
  const entities = [
    // dirigeants présent mais sans email
    {
      siren: '1', nom: 'Co1', codeNaf: '62.02A', ville: 'Paris', trancheEffectif: '11',
      latitude: 48.5, longitude: 2.0,
      dirigeants: JSON.stringify([{ prenoms: 'Jean', nom: 'D' }]),
    },
    {
      siren: '2', nom: 'Co2', codeNaf: '62.02A', ville: 'Paris', trancheEffectif: '11',
      latitude: 48.6, longitude: 2.0,
      dirigeants: '[]',
    },
  ];
  const { leadBase, trace, traceCalls } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'empty');
  assert.equal(res.meta.candidatesCount, 2);
  assert.equal(res.meta.excludedNoEmail, 2);
  assert.equal(res.meta.returned, 0);
  assert.equal(traceCalls[0].status, 'empty');
});

// ─── Exclusions produit ─────────────────────────────────────────────────────

test('integration — exclusions 69.10Z et 69.20Z appliquées', async () => {
  const entities = [
    entity({ siren: '1', nom: 'Cabinet Avocats', codeNaf: '69.10Z', email: 'av@co.fr', lat: 48.5, lon: 2.0 }),
    entity({ siren: '2', nom: 'Cabinet Compta', codeNaf: '69.20Z', email: 'co@co.fr', lat: 48.5, lon: 2.0 }),
    entity({ siren: '3', nom: 'ESN OK', codeNaf: '62.02A', email: 'esn@co.fr', lat: 48.5, lon: 2.0 }),
  ];
  // Brief volontairement avec esn (62.02A) mais on simule que la base
  // remonte aussi des 69.* (cas où Constantin remonte large)
  const { leadBase, trace } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.meta.excludedByRules, 2);
  assert.equal(res.leads.length, 1);
  assert.equal(res.leads[0].entreprise, 'ESN OK');
});

// ─── Cas error : LeadBase throw ─────────────────────────────────────────────

test('integration — status=error : LeadBase plante', async () => {
  const tableClient = {
    listEntities: () => (async function* () { throw new Error('table boom'); })(),
  };
  const leadBase = new LeadBaseAdapter({ tableClient });
  const traceCalls = [];
  const trace = async (e) => { traceCalls.push(e); return e; };

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'error');
  assert.equal(res.leads.length, 0);
  assert.ok(res.meta.errorMessage);
  assert.equal(traceCalls[0].status, 'error');
});

// ─── Format de sortie compatible launchSequenceForConsultant ────────────────

test('integration — format lead conforme à launchSequenceForConsultant', async () => {
  const entities = [
    entity({
      siren: '1', nom: 'Acme', codeNaf: '62.02A', ville: 'Lyon', tranche: '12',
      email: 'jd@acme.fr', lat: 45.76, lon: 4.83,
    }),
  ];
  const { leadBase, trace } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: { ...BRIEF_PARIS, zone: 'france' },
    batchSize: 10,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'insufficient');
  const lead = res.leads[0];
  assert.equal(lead.entreprise, 'Acme');
  assert.equal(lead.email, 'jd@acme.fr');
  assert.equal(lead.secteur, '62.02A');
  assert.equal(lead.ville, 'Lyon');
  assert.match(lead.contexte, /Acme/);
  assert.match(lead.contexte, /62\.02A/);
  // champs obligatoires pour launchSequenceForConsultant
  assert.ok('prenom' in lead);
  assert.ok('nom' in lead);
});

// ─── BatchSize custom ───────────────────────────────────────────────────────

test('integration — batchSize=3 retourne 3 leads max', async () => {
  const entities = Array.from({ length: 20 }, (_, i) =>
    entity({ siren: `${i}`, nom: `Co${i}`, email: `e${i}@co.fr`, lat: 48 + i * 0.05, lon: 2.0 + i * 0.05 }),
  );
  const { leadBase, trace } = makeAdapters(entities);

  const res = await selectLeadsForConsultant({
    brief: BRIEF_PARIS,
    batchSize: 3,
    adapters: { leadBase, trace },
  });

  assert.equal(res.status, 'ok');
  assert.equal(res.leads.length, 3);
  assert.equal(res.meta.requested, 3);
});
