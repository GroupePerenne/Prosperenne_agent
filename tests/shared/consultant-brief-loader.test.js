'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConsultantBrief } = require('../../shared/consultant-brief-loader');

const VALID_RESPONSES = {
  display_name: 'Morgane DE JESSEY',
  preferred_tone: 'posé',
  tutoiement: false,
  favorite_sectors: ['plomberie', 'electricite'],
  commercial_strategy: 'Je copilote les dirigeants TPE/PME BTP',
  zone: 'around',
  zone_rayon: 10,
  ville: 'Boulogne-Billancourt',
  prospecteur: 'martin',
  email: 'm.dejessey@oseys.fr',
};

test('storage hit avec responses display_name → payload Storage-only', async () => {
  let called = 0;
  const deps = {
    getConsultant: async () => {
      called++;
      return { consultantEmail: 'm.dejessey@oseys.fr', status: 'completed', responses: VALID_RESPONSES };
    },
  };
  const out = await loadConsultantBrief('m.dejessey@oseys.fr', null, deps);
  assert.equal(out.source, 'storage-table');
  assert.equal(out.consultant.nom, 'Morgane DE JESSEY');
  assert.equal(out.consultant.email, 'm.dejessey@oseys.fr');
  assert.equal(out.consultant.tutoiement, false);
  assert.equal(out.brief.prospecteur, 'martin');
  assert.equal(out.beneficiaryId, 'oseys-m.dejessey');
  assert.equal(out.originalBrief.zone_rayon, 10);
  assert.equal(out.originalBrief.vouvoiement, 'vous');
  assert.equal(called, 1);
});

test('storage record null → null', async () => {
  const deps = { getConsultant: async () => null };
  const out = await loadConsultantBrief('absent@oseys.fr', null, deps);
  assert.equal(out, null);
});

test('storage hit malformé (responses sans display_name) → null', async () => {
  const deps = {
    getConsultant: async () => ({ consultantEmail: 'x', status: 'completed', responses: { ville: 'X' } }),
  };
  const out = await loadConsultantBrief('x@oseys.fr', null, deps);
  assert.equal(out, null);
});

test('storage hit sans responses → null', async () => {
  const deps = {
    getConsultant: async () => ({ consultantEmail: 'x', status: 'sent', responses: null }),
  };
  const out = await loadConsultantBrief('x@oseys.fr', null, deps);
  assert.equal(out, null);
});

test('storage error throw → null (graceful, log only)', async () => {
  const deps = { getConsultant: async () => { throw new Error('Storage timeout'); } };
  const out = await loadConsultantBrief('m.dejessey@oseys.fr', null, deps);
  assert.equal(out, null);
});

test('consultantId null → null', async () => {
  const out = await loadConsultantBrief(null, null);
  assert.equal(out, null);
});

test('consultantId vide string → null', async () => {
  const out = await loadConsultantBrief('', null);
  assert.equal(out, null);
});

test('payload tutoiement=true mappé correctement depuis storage', async () => {
  const responses = { ...VALID_RESPONSES, tutoiement: true };
  const deps = {
    getConsultant: async () => ({ consultantEmail: 'j.serra@oseys.fr', status: 'completed', responses }),
  };
  const out = await loadConsultantBrief('j.serra@oseys.fr', null, deps);
  assert.equal(out.consultant.tutoiement, true);
  assert.equal(out.originalBrief.vouvoiement, 'tu');
});

test('beneficiaryId dérivé du consultantId (avant @)', async () => {
  const deps = {
    getConsultant: async () => ({ consultantEmail: 'j.serra@oseys.fr', status: 'completed', responses: VALID_RESPONSES }),
  };
  const out = await loadConsultantBrief('j.serra@oseys.fr', null, deps);
  assert.equal(out.beneficiaryId, 'oseys-j.serra');
});

test('logs émis via context.log si fourni', async () => {
  const logs = [];
  const ctx = { log: (m) => logs.push(m) };
  const deps = {
    getConsultant: async () => ({ consultantEmail: 'm.dejessey@oseys.fr', status: 'completed', responses: VALID_RESPONSES }),
  };
  await loadConsultantBrief('m.dejessey@oseys.fr', ctx, deps);
  assert.ok(logs.some((l) => l.includes('storage-hit')), 'log storage-hit attendu');
});
