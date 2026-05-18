'use strict';

/**
 * Mémoire conversationnelle David — perpétuelle, brute, backée Azure Storage.
 *
 * Doctrine (validée Paul 18 mai 2026 PM, Sprint 1 mémoire David v2) :
 *   - Stockage 100% Azure Storage Table, AUCUN appel LLM pour la maintenance.
 *   - Stockage brut intégral des messages échangés (subject + body html-strippé).
 *   - Au moment de générer une réponse David, on charge la mémoire de
 *     l'interlocuteur et on injecte les messages bruts dans le prompt Sonnet
 *     4.6 (context 200K largement suffisant — projection 6m = ~50K tokens
 *     pour 1 consultant actif, ~22€ de tokens Anthropic sur 6 mois).
 *   - Pas de synthèse destructive, pas de Haiku async. Le brut est la source
 *     de vérité.
 *   - Doctrine Mem0 respectée : ceci N'EST PAS la mémoire Charli — c'est la
 *     mémoire opérationnelle David (échanges mails consultants + prospects).
 *
 * Schéma :
 *   PartitionKey : 'interlocutor:{email lowercase}'
 *   RowKey       : '{ISO timestamp Z}_{rand6}' (chronologique ascendant naturel)
 *   direction    : 'inbound' | 'outbound'
 *   mailbox      : email de la boîte concernée (david@, martin@, mila@)
 *   subject      : string (max 1024)
 *   body         : string raw html-strippé (Storage Table limite 64KB par
 *                  prop ; on tronque à 60KB par sécurité)
 *   messageId    : Graph message ID (idempotence + dédoublonnage)
 *   conversationId : Graph conversation ID (optionnel)
 *   classification : JSON stringifié de la décision Claude si inbound classifié
 *   sentAt       : ISO datetime du message d'origine
 *   recordedAt   : ISO datetime de l'enregistrement
 *
 * Best effort : aucune erreur Storage ne doit interrompre le pipeline.
 * Idempotence : si la même messageId + direction est ré-enregistrée, on
 * remplace l'entité (upsert) — pas de duplication.
 */

const { getTableClient, ensureTable } = require('./client');

const TABLE_NAME = process.env.DAVID_MEMORY_TABLE || 'DavidMemory';
const MAX_BODY_CHARS = 60_000; // sous la limite Azure Storage 64KB par prop
const DEFAULT_LIST_LIMIT = 200;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makePartitionKey(interlocutorEmail) {
  const email = normalizeEmail(interlocutorEmail);
  return email ? `interlocutor:${email}` : null;
}

function makeRowKey(sentAt) {
  const ts = sentAt instanceof Date ? sentAt.toISOString() : (sentAt || new Date().toISOString());
  const safe = String(ts).replace(/[^0-9A-Za-z.\-]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${safe}_${rand}`;
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Enregistre un message dans la mémoire David. Best effort, ne throw jamais.
 *
 * @param {Object} msg
 * @param {string} msg.interlocutorEmail   email du correspondant (PK)
 * @param {'inbound'|'outbound'} msg.direction
 * @param {string} [msg.mailbox]
 * @param {string} [msg.subject]
 * @param {string} [msg.body]              html ou texte (html-strippé en interne)
 * @param {string} [msg.messageId]
 * @param {string} [msg.conversationId]
 * @param {Object} [msg.classification]    décision Claude pour inbound
 * @param {string|Date} [msg.sentAt]       ISO ou Date du message d'origine
 * @returns {Promise<{partitionKey, rowKey}|null>}
 */
async function recordMessage(msg = {}) {
  const partitionKey = makePartitionKey(msg.interlocutorEmail);
  if (!partitionKey) return null;
  if (msg.direction !== 'inbound' && msg.direction !== 'outbound') return null;

  const client = getTableClient(TABLE_NAME);
  if (!client) return null;

  const sentAt = msg.sentAt
    ? (msg.sentAt instanceof Date ? msg.sentAt.toISOString() : msg.sentAt)
    : new Date().toISOString();
  const rowKey = makeRowKey(sentAt);

  const rawBody = stripHtml(msg.body);
  const truncatedBody = rawBody.length > MAX_BODY_CHARS
    ? rawBody.slice(0, MAX_BODY_CHARS) + `\n[…tronqué ${rawBody.length - MAX_BODY_CHARS}c]`
    : rawBody;

  const entity = {
    partitionKey,
    rowKey,
    direction: msg.direction,
    mailbox: normalizeEmail(msg.mailbox),
    subject: String(msg.subject || '').slice(0, 1024),
    body: truncatedBody,
    messageId: String(msg.messageId || '').slice(0, 256),
    conversationId: String(msg.conversationId || '').slice(0, 256),
    classification: msg.classification ? JSON.stringify(msg.classification).slice(0, 8000) : '',
    sentAt,
    recordedAt: new Date().toISOString(),
  };

  try {
    await ensureTable(client, TABLE_NAME);
    await client.createEntity(entity);
    return { partitionKey, rowKey };
  } catch {
    return null;
  }
}

/**
 * Liste la mémoire complète d'un interlocuteur, ordre chronologique
 * (du plus ancien au plus récent) — c'est l'ordre RowKey ASC naturel.
 *
 * @param {string} interlocutorEmail
 * @param {Object} [opts]
 * @param {number} [opts.limit=200]
 * @returns {Promise<Array<{direction, subject, body, sentAt, mailbox, messageId, conversationId, classification}>>}
 */
async function listMemoryFor(interlocutorEmail, opts = {}) {
  const partitionKey = makePartitionKey(interlocutorEmail);
  if (!partitionKey) return [];

  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIST_LIMIT;
  const client = getTableClient(TABLE_NAME);
  if (!client) return [];

  try {
    await ensureTable(client, TABLE_NAME);
    const out = [];
    const iterator = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${partitionKey}'` },
    });
    for await (const e of iterator) {
      let classification = null;
      if (e.classification) {
        try { classification = JSON.parse(e.classification); } catch { /* ignore */ }
      }
      out.push({
        direction: e.direction,
        mailbox: e.mailbox,
        subject: e.subject || '',
        body: e.body || '',
        messageId: e.messageId || '',
        conversationId: e.conversationId || '',
        classification,
        sentAt: e.sentAt || '',
        recordedAt: e.recordedAt || '',
      });
      if (out.length >= limit) break;
    }
    // RowKey ASC → ordre chronologique
    return out.sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
  } catch {
    return [];
  }
}

/**
 * Format compact prêt à injecter dans un system prompt LLM, du plus ancien
 * au plus récent. Préserve le brut (subject + body complet).
 *
 * @param {Array} messages   sortie de listMemoryFor
 * @returns {string}
 */
function formatMemoryForPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const lines = ['MÉMOIRE DES ÉCHANGES PRÉCÉDENTS AVEC CE CORRESPONDANT (du plus ancien au plus récent) :', ''];
  for (const m of messages) {
    const dir = m.direction === 'outbound' ? '→ envoyé par nous' : '← reçu de lui';
    const date = String(m.sentAt || '').slice(0, 16).replace('T', ' ');
    lines.push(`[${date}] ${dir} ${m.mailbox ? `(via ${m.mailbox})` : ''}`);
    if (m.subject) lines.push(`SUJET : ${m.subject}`);
    if (m.body) {
      lines.push('CORPS :');
      lines.push('"""');
      lines.push(m.body);
      lines.push('"""');
    }
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  recordMessage,
  listMemoryFor,
  formatMemoryForPrompt,
  stripHtml,
  TABLE_NAME,
  _internals: { makePartitionKey, makeRowKey, MAX_BODY_CHARS },
};
