/**
 * Microsoft Graph — envoi et lecture de mail
 *
 * Utilise le flow client_credentials (permission Application Mail.Send accordée)
 * pour envoyer depuis n'importe quelle boîte du tenant sans interaction utilisateur.
 *
 * Variables d'environnement requises :
 *   TENANT_ID
 *   CLIENT_ID
 *   CLIENT_SECRET
 */

const TOKEN_URL = () => `https://login.microsoftonline.com/${requireEnv('TENANT_ID')}/oauth2/v2.0/token`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let cachedToken = null;
let cachedUntil = 0;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} non défini`);
  return v;
}

/** Obtient un token OAuth applicatif, avec cache */
async function getToken() {
  if (cachedToken && Date.now() < cachedUntil - 60_000) return cachedToken;

  const body = new URLSearchParams({
    client_id: requireEnv('CLIENT_ID'),
    client_secret: requireEnv('CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token OAuth échoué : ${res.status} ${err}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedUntil = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

/**
 * Envoie un mail depuis l'adresse `from` (doit être une UPN du tenant).
 *
 * @param {Object} opts
 * @param {string} opts.from          — UPN (ex: "martin@oseys.fr")
 * @param {string|string[]} opts.to   — destinataires
 * @param {string[]} [opts.cc]
 * @param {string} opts.subject
 * @param {string} opts.html          — corps HTML
 * @param {string} [opts.replyTo]     — override reply-to (utile pour Martin/Mila → consultant)
 */
async function sendMail({ from, to, cc = [], bcc = [], subject, html, replyTo }) {
  const token = await getToken();

  const recipients = (Array.isArray(to) ? to : [to]).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } }));
  const bccRecipients = (Array.isArray(bcc) ? bcc : [bcc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } }));

  const messagePayload = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: recipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
    ...(bccRecipients.length ? { bccRecipients } : {}),
    ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
  };

  // Plan v3.1 Pilier 2 — thread mail : on remplace POST /sendMail (202
  // Accepted sans retour metadata) par POST /messages (création draft,
  // retourne internetMessageId + conversationId + id Graph) puis POST
  // /messages/{id}/send. Surcoût : +1 round-trip Graph. Gain : les
  // sortants exposent leur internetMessageId pour audit Pipedrive +
  // threading conversationnel. Indispensable pour Sujet 2 (David
  // répond dans le thread via /reply) et Sujet 5 (lit fil compacté).
  const createDraftUrl = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages`;
  const draftRes = await fetch(createDraftUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messagePayload),
  });
  if (!draftRes.ok) {
    const err = await draftRes.text();
    throw new Error(`Graph createDraft ${draftRes.status} : ${err}`);
  }
  const draft = await draftRes.json();
  const graphMessageId = draft.id;
  const internetMessageId = draft.internetMessageId || null;
  const conversationId = draft.conversationId || null;

  const sendUrl = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages/${encodeURIComponent(graphMessageId)}/send`;
  const sendRes = await fetch(sendUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!sendRes.ok) {
    const err = await sendRes.text();
    throw new Error(`Graph sendDraft ${sendRes.status} : ${err}`);
  }

  return {
    ok: true,
    from,
    to: recipients.map((r) => r.emailAddress.address),
    internetMessageId,
    conversationId,
    graphMessageId,
  };
}

/**
 * Répond à un message reçu en s'appuyant sur le natif Graph `/reply`, qui
 * chaîne automatiquement les headers `In-Reply-To` + `References` côté
 * client mail destinataire — David apparaît dans le thread du prospect,
 * pas dans un nouveau mail unrelated.
 *
 * Cf. doc Graph : POST /users/{userId}/messages/{id}/reply
 * https://learn.microsoft.com/en-us/graph/api/message-reply
 *
 * @param {Object} opts
 * @param {string} opts.from         UPN auteur de la réponse (boîte qui a reçu le mail prospect)
 * @param {string} opts.messageId    ID Graph du mail prospect auquel répondre
 * @param {string} opts.html         Corps HTML de la réponse (positionné en haut, citation auto par Graph)
 * @returns {Promise<{ok:true, from:string, messageId:string}>}
 */
async function replyToMessage({ from, messageId, html }) {
  if (!from) throw new Error('replyToMessage: from requis');
  if (!messageId) throw new Error('replyToMessage: messageId requis');
  if (!html) throw new Error('replyToMessage: html requis');
  const token = await getToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages/${encodeURIComponent(messageId)}/reply`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { body: { contentType: 'HTML', content: html } },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph reply ${res.status} : ${err}`);
  }
  return { ok: true, from, messageId };
}

/**
 * Récupère tous les messages d'une conversation Graph (in + out), triés par
 * date croissante. Utilisé par davidInbox pour reconstituer le fil
 * complet avant classification + génération réponse (Sujet 5 plan v3.1).
 *
 * On filtre côté `conversationId` (champ stable Graph qui groupe les
 * messages du même thread, transverse aux dossiers Inbox/SentItems).
 *
 * @param {Object} opts
 * @param {string} opts.mailbox        UPN propriétaire de la conversation
 * @param {string} opts.conversationId Valeur de conversationId du mail entrant
 * @param {number} [opts.top=50]       Limite messages (default 50, large pour fils long)
 * @returns {Promise<Array<{id:string,subject:string,from:Object,toRecipients:Array,receivedDateTime:string,sentDateTime?:string,bodyPreview:string,body:Object,internetMessageId:string,conversationId:string}>>}
 */
async function getConversationMessages({ mailbox, conversationId, top = 50 }) {
  if (!mailbox) throw new Error('getConversationMessages: mailbox requis');
  if (!conversationId) throw new Error('getConversationMessages: conversationId requis');
  const token = await getToken();
  const filter = encodeURIComponent(`conversationId eq '${conversationId}'`);
  const select = encodeURIComponent('id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,body,internetMessageId,conversationId');
  const orderby = encodeURIComponent('receivedDateTime asc');
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages?$filter=${filter}&$select=${select}&$orderby=${orderby}&$top=${top}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph getConversation ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.value || [];
}

/**
 * Liste les mails non lus d'une boîte (utile pour David qui lit son inbox).
 * Limité aux N plus récents.
 */
async function listUnreadMessages({ mailbox, top = 20 }) {
  const token = await getToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview,body,conversationId`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph list ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.value || [];
}

async function markAsRead({ mailbox, messageId }) {
  const token = await getToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages/${messageId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });
  if (!res.ok) throw new Error(`Graph markAsRead ${res.status}`);
  return true;
}

/**
 * Forward un mail existant à un ou plusieurs destinataires, en maintenant le
 * thread original (conversationId préservé côté destinataire). Utilisé par
 * davidInbox pour transmettre les réponses prospects au consultant sans créer
 * un nouveau mail unrelated (BL-52 audit, fix spam notifications).
 *
 * Cf. doc Graph : POST /users/{userId}/messages/{id}/forward
 * https://learn.microsoft.com/en-us/graph/api/message-forward
 *
 * @param {Object} opts
 * @param {string} opts.from         UPN propriétaire du mail à forwarder
 *                                   (ex: "martin@oseys.fr" si le mail prospect
 *                                   est arrivé dans la boîte de Martin)
 * @param {string} opts.messageId    ID Graph du mail à forwarder
 * @param {string|string[]} opts.to  Destinataire(s) du forward
 * @param {string[]} [opts.cc]
 * @param {string} [opts.comment]    Texte HTML à insérer en tête du mail forwardé
 *                                   (commentaire David expliquant le contexte)
 */
async function forwardMessage({ from, messageId, to, cc = [], comment = '' }) {
  if (!from) throw new Error('forwardMessage: from requis');
  if (!messageId) throw new Error('forwardMessage: messageId requis');
  const token = await getToken();
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/messages/${encodeURIComponent(messageId)}/forward`;

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } }));

  if (recipients.length === 0) throw new Error('forwardMessage: au moins un destinataire requis');

  const payload = {
    comment: comment || '',
    toRecipients: recipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph forward ${res.status} : ${err}`);
  }
  return { ok: true, from, messageId, to: recipients.map((r) => r.emailAddress.address) };
}

module.exports = {
  sendMail,
  listUnreadMessages,
  markAsRead,
  forwardMessage,
  replyToMessage,
  getConversationMessages,
  getToken,
};
