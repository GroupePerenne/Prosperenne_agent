/**
 * Tests — shared/prospect-research/sources/apiGouv.js
 *
 * Vérifie :
 *   - normalize : tolérance aux champs manquants, match correct du siren
 *   - sanitizeSiren : rejette les entrées invalides
 *   - fetchCompanyFromApiGouv :
 *       * siren invalide → null sans appel réseau
 *       * payload 200 conforme → shape normalisée
 *       * 404 → null
 *       * erreur réseau → null
 *       * timeout → null
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchCompanyFromApiGouv,
  sanitizeSiren,
  _normalize,
} = require('../../../shared/prospect-research/sources/apiGouv');

test('sanitizeSiren — accepte 9 chiffres, rejette le reste', () => {
  assert.equal(sanitizeSiren('123456789'), '123456789');
  assert.equal(sanitizeSiren('  123456789 '), '123456789');
  assert.equal(sanitizeSiren('12345678'), null);
  assert.equal(sanitizeSiren('12345678A'), null);
  assert.equal(sanitizeSiren(null), null);
  assert.equal(sanitizeSiren(undefined), null);
  assert.equal(sanitizeSiren(''), null);
});

test('normalize — payload minimal avec match siren', () => {
  const res = _normalize('123456789', {
    results: [
      {
        siren: '123456789',
        nom_complet: 'ACME SAS',
        activite_principale: '62.01Z',
        activite_principale_libelle: 'Programmation informatique',
        tranche_effectif_salarie: '11',
        etat_administratif: 'A',
        date_creation: '2015-03-12',
        siege: {
          adresse: '10 rue de Paris, 75001 Paris',
          libelle_commune: 'Paris',
        },
      },
    ],
  });
  assert.equal(res.siren, '123456789');
  assert.equal(res.nomEntreprise, 'ACME SAS');
  assert.equal(res.activiteDeclaree, 'Programmation informatique');
  assert.equal(res.codeNaf, '62.01Z');
  assert.equal(res.trancheEffectif, '11');
  assert.equal(res.adresseSiege, '10 rue de Paris, 75001 Paris');
  assert.equal(res.commune, 'Paris');
  assert.equal(res.estActive, true);
  assert.equal(res.dateCreation, '2015-03-12');
});

test('normalize — prend le résultat dont le siren matche quand plusieurs', () => {
  const res = _normalize('123456789', {
    results: [
      { siren: '999999999', nom_complet: 'AUTRE' },
      { siren: '123456789', nom_complet: 'ACME SAS' },
    ],
  });
  assert.equal(res.nomEntreprise, 'ACME SAS');
});

test('normalize — champs manquants → null partout sans throw', () => {
  const res = _normalize('123456789', { results: [{ siren: '123456789' }] });
  assert.equal(res.siren, '123456789');
  assert.equal(res.nomEntreprise, null);
  assert.equal(res.activiteDeclaree, null);
  assert.equal(res.codeNaf, null);
  assert.equal(res.trancheEffectif, null);
  assert.equal(res.adresseSiege, null);
  assert.equal(res.commune, null);
  assert.equal(res.estActive, null);
});

test('normalize — results vide retourne null', () => {
  assert.equal(_normalize('123456789', { results: [] }), null);
  assert.equal(_normalize('123456789', {}), null);
  assert.equal(_normalize('123456789', null), null);
});

test('fetchCompanyFromApiGouv — siren invalide → null sans fetch', async () => {
  let called = false;
  const res = await fetchCompanyFromApiGouv('abc', {
    fetchImpl: () => {
      called = true;
      return Promise.resolve({ ok: true, json: () => ({}) });
    },
  });
  assert.equal(res, null);
  assert.equal(called, false);
});

test('fetchCompanyFromApiGouv — 200 ok → shape normalisée', async () => {
  const fake = {
    ok: true,
    json: async () => ({
      results: [
        {
          siren: '552032534',
          nom_complet: 'RENAULT',
          activite_principale: '29.10Z',
          etat_administratif: 'A',
          siege: { libelle_commune: 'Boulogne-Billancourt' },
        },
      ],
    }),
  };
  const res = await fetchCompanyFromApiGouv('552032534', {
    fetchImpl: async () => fake,
  });
  assert.equal(res.siren, '552032534');
  assert.equal(res.nomEntreprise, 'RENAULT');
  assert.equal(res.estActive, true);
  assert.equal(res.commune, 'Boulogne-Billancourt');
});

test('fetchCompanyFromApiGouv — 404 → null', async () => {
  const res = await fetchCompanyFromApiGouv('123456789', {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.equal(res, null);
});

test('fetchCompanyFromApiGouv — erreur réseau → null', async () => {
  const res = await fetchCompanyFromApiGouv('123456789', {
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.equal(res, null);
});

test('fetchCompanyFromApiGouv — timeout → null', async () => {
  const res = await fetchCompanyFromApiGouv('123456789', {
    timeoutMs: 10,
    fetchImpl: (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }),
  });
  assert.equal(res, null);
});
