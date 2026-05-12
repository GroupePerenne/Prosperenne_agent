/**
 * Tests unitaires — functions/getConsultantBrief
 *
 * Stratégie identique à onQualification.test.js : handler extractible
 * handleGetConsultantBrief(request, context, deps) avec deps.getConsultant
 * injectable. Pas d'Azure Functions runtime réel, pas de réseau.
 *
 * Note auth : authLevel='function' est appliqué par le runtime Azure
 * Functions AVANT que le handler soit invoqué. Côté unit test on bypasse
 * cette couche — pas de sens de tester "function key manquante = 401",
 * c'est l'host qui filtre. À la place on couvre les cas business :
 * email requis, email inconnu, brief vide, brief complet, erreur storage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleGetConsultantBrief } = require('../../src/functions/getConsultantBrief');

function makeRequest({ method = 'GET', query = {} } = {}) {
  return {
    method,
    query: {
      get: (k) => (k in query ? query[k] : null),
    },
  };
}

function makeContext() {
  const calls = { warn: [], error: [], log: [], info: [] };
  return {
    calls,
    context: {
      warn: (...a) => calls.warn.push(a),
      error: (...a) => calls.error.push(a),
      log: (...a) => calls.log.push(a),
      info: (...a) => calls.info.push(a),
    },
  };
}

const RESPONSES_COMPLET = {
  display_name: 'Elie Mougel',
  preferred_tone: 'direct_cordial',
  tutoiement: true,
  favorite_sectors: ['agence_communication', 'conseil'],
  commercial_strategy: 'Copilotage économique des dirigeants TPE/PME',
  usable_anecdotes: [],
  autonomy_level: 'autonome',
  secteurs_autres: '',
  effectif: '10-20',
  zone: 'adresse',
  zone_rayon: 25,
  adresse: '',
  ville: 'Av Do Brasil 757 - 1',
  prospecteur: 'both',
  email: 'e.mougel@oseys.fr',
  offre_choisie: 'rdv-cale',
  mise_en_copie_consultant: false,
  cible_specifique: '',
  methode_consultant: '',
  anecdotes_anonymisees: [],
};

// ──────────────── handleGetConsultantBrief ────────────────

test('handleGetConsultantBrief — OPTIONS : retourne 204 sans appel storage', async () => {
  const getCalls = [];
  const getConsultant = async (email) => { getCalls.push(email); return null; };
  const { context } = makeContext();
  const res = await handleGetConsultantBrief({ method: 'OPTIONS', query: { get: () => null } }, context, { getConsultant });
  assert.equal(res.status, 204);
  assert.equal(getCalls.length, 0);
});

test('handleGetConsultantBrief — email absent : 400 email_required', async () => {
  const getCalls = [];
  const getConsultant = async (email) => { getCalls.push(email); return null; };
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(makeRequest({ query: {} }), context, { getConsultant });
  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'email_required');
  assert.equal(getCalls.length, 0);
});

test('handleGetConsultantBrief — email mal formé : 400 email_required', async () => {
  const getCalls = [];
  const getConsultant = async (email) => { getCalls.push(email); return null; };
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(makeRequest({ query: { email: 'pas-un-email' } }), context, { getConsultant });
  assert.equal(res.status, 400);
  assert.equal(res.jsonBody.error, 'email_required');
  assert.equal(getCalls.length, 0);
});

test('handleGetConsultantBrief — email inconnu (getConsultant=null) : 404 consultant_not_found', async () => {
  const getConsultant = async () => null;
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'inconnu@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'consultant_not_found');
});

test('handleGetConsultantBrief — responses null (consultant en status sent, brief non complété) : 404', async () => {
  const getConsultant = async () => ({
    consultantEmail: 'sent-only@oseys.fr',
    consultantName: 'Pas Encore Complete',
    status: 'sent',
    sentAt: '2026-05-12T08:00:00.000Z',
    completedAt: '',
    briefId: '',
    responses: null,
  });
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'sent-only@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'consultant_not_found');
});

test('handleGetConsultantBrief — responses objet vide {} : 404 (pas un brief complété)', async () => {
  const getConsultant = async () => ({
    consultantEmail: 'empty@oseys.fr',
    consultantName: 'Vide',
    status: 'completed',
    responses: {},
  });
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'empty@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 404);
  assert.equal(res.jsonBody.error, 'consultant_not_found');
});

test('handleGetConsultantBrief — brief complet : 200 + responses + métadonnées', async () => {
  const getConsultant = async (email) => {
    assert.equal(email, 'e.mougel@oseys.fr', 'email normalisé lowercase + trim');
    return {
      consultantEmail: 'e.mougel@oseys.fr',
      consultantName: 'Elie Mougel',
      status: 'completed',
      sentAt: '2026-05-10T08:00:00.000Z',
      completedAt: '2026-05-12T09:30:00.000Z',
      briefId: 'brief_1715500000_abc123',
      responses: RESPONSES_COMPLET,
    };
  };
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'E.Mougel@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.email, 'e.mougel@oseys.fr');
  assert.equal(res.jsonBody.consultantName, 'Elie Mougel');
  assert.equal(res.jsonBody.briefId, 'brief_1715500000_abc123');
  assert.equal(res.jsonBody.completedAt, '2026-05-12T09:30:00.000Z');
  assert.deepEqual(res.jsonBody.responses, RESPONSES_COMPLET);
});

test('handleGetConsultantBrief — CORS headers présents sur 200', async () => {
  const getConsultant = async () => ({
    consultantEmail: 'e.mougel@oseys.fr',
    consultantName: 'Elie Mougel',
    responses: RESPONSES_COMPLET,
  });
  const { context } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'e.mougel@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.match(res.headers['Access-Control-Allow-Methods'] || '', /GET/);
});

test('handleGetConsultantBrief — getConsultant throw : 500 + message propagé', async () => {
  const getConsultant = async () => { throw new Error('storage exploded'); };
  const { context, calls } = makeContext();
  const res = await handleGetConsultantBrief(
    makeRequest({ query: { email: 'e.mougel@oseys.fr' } }),
    context,
    { getConsultant }
  );
  assert.equal(res.status, 500);
  assert.equal(res.jsonBody.error, 'storage exploded');
  assert.ok(calls.error.length >= 1, 'erreur loggée via safeLog');
});
