'use strict';

/**
 * État onboarding consultant — 1 row par consultant, mis à jour au fil
 * du cycle de vie : envoi du mail d'onboarding (status=sent) puis
 * réception de la soumission du formulaire (status=completed + responses).
 *
 * Schéma :
 *   PartitionKey : 'consultant'             (constante, scan global facile)
 *   RowKey       : consultantEmail lowercase (unique par consultant)
 *   consultantEmail : email lowercase
 *   consultantName  : "Prénom NOM" si dispo
 *   status          : 'sent' | 'completed'
 *   sentAt          : ISO datetime envoi mail David sendOnboarding
 *   completedAt     : ISO datetime réception soumission onQualification
 *   briefId         : id du dernier brief reçu (vide si non complété)
 *   responses       : JSON stringifié du brief (consultantMemory) si complété
 *
 * Best effort : aucune erreur n'est propagée au caller. Si le storage est
 * indisponible la PWA verra simplement un consultant absent — pas de blocage
 * du flux mail nominal.
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.CONSULTANT_ONBOARDING_TABLE || 'consultantOnboarding';
const PARTITION_KEY = 'consultant';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function _withClient(fn) {
  const client = getTableClient(TABLE_NAME);
  if (!client) return null;
  try {
    await ensureTable(client, TABLE_NAME);
    return await fn(client);
  } catch {
    return null;
  }
}

/**
 * Marque l'envoi du mail d'onboarding au consultant. Upsert sur l'email :
 * si une row existe déjà (re-send) on garde la trace `completedAt` éventuelle
 * et on met juste à jour `sentAt` au plus récent.
 */
async function recordOnboardingSent({ consultantEmail, consultantName, sentAt } = {}) {
  const email = normalizeEmail(consultantEmail);
  if (!email) return null;
  const ts = sentAt || new Date().toISOString();

  return _withClient(async (client) => {
    const existing = await _safeGet(client, email);
    const entity = {
      partitionKey: PARTITION_KEY,
      rowKey: email,
      consultantEmail: email,
      consultantName: consultantName || (existing && existing.consultantName) || '',
      status: existing && existing.status === 'completed' ? 'completed' : 'sent',
      sentAt: ts,
      completedAt: (existing && existing.completedAt) || '',
      briefId: (existing && existing.briefId) || '',
      responses: (existing && existing.responses) || '',
    };
    await client.upsertEntity(entity, 'Replace');
    return entity;
  });
}

/**
 * Marque la réception de la soumission du formulaire. Upsert : si la row
 * "sent" existe on conserve `sentAt` et on ajoute completedAt + responses.
 * Si on reçoit une soumission sans avoir trace du sent (cas legacy / backfill
 * manqué), on crée la row avec sentAt = completedAt par défaut.
 */
async function recordOnboardingCompleted({ consultantEmail, consultantName, briefId, responses, completedAt } = {}) {
  const email = normalizeEmail(consultantEmail);
  if (!email) return null;
  const ts = completedAt || new Date().toISOString();

  return _withClient(async (client) => {
    const existing = await _safeGet(client, email);
    const entity = {
      partitionKey: PARTITION_KEY,
      rowKey: email,
      consultantEmail: email,
      consultantName: consultantName || (existing && existing.consultantName) || '',
      status: 'completed',
      sentAt: (existing && existing.sentAt) || ts,
      completedAt: ts,
      briefId: briefId || '',
      responses: typeof responses === 'string' ? responses : JSON.stringify(responses || {}),
    };
    await client.upsertEntity(entity, 'Replace');
    return entity;
  });
}

/**
 * Renvoie la liste de tous les consultants connus (1 row par consultant).
 * Tri antichronologique sur sentAt côté caller — le scan Azure ne trie pas.
 */
async function listAllConsultants() {
  const client = getTableClient(TABLE_NAME);
  if (!client) return [];
  try {
    await ensureTable(client, TABLE_NAME);
    const out = [];
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}'` },
    });
    for await (const e of iterator) {
      out.push(_serialize(e));
      if (out.length >= 5000) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function getConsultant(consultantEmail) {
  const email = normalizeEmail(consultantEmail);
  if (!email) return null;
  return _withClient(async (client) => {
    const entity = await _safeGet(client, email);
    return entity ? _serialize(entity) : null;
  });
}

async function _safeGet(client, rowKey) {
  try {
    return await client.getEntity(PARTITION_KEY, rowKey);
  } catch (err) {
    if (err && (err.statusCode === 404 || /ResourceNotFound/i.test(err.message || ''))) return null;
    return null;
  }
}

function _serialize(entity) {
  let parsedResponses = null;
  if (entity.responses) {
    try {
      parsedResponses = JSON.parse(entity.responses);
    } catch {
      parsedResponses = entity.responses;
    }
  }
  return {
    consultantEmail: entity.consultantEmail || entity.rowKey,
    consultantName: entity.consultantName || '',
    status: entity.status || 'sent',
    sentAt: entity.sentAt || '',
    completedAt: entity.completedAt || '',
    briefId: entity.briefId || '',
    responses: parsedResponses,
  };
}

module.exports = {
  recordOnboardingSent,
  recordOnboardingCompleted,
  listAllConsultants,
  getConsultant,
};
