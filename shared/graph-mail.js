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
  const url = `${GRAPH_BASE}/users/${encodeURIComponent(from)}/sendMail`;

  const recipients = (Array.isArray(to) ? to : [to]).map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = (Array.isArray(cc) ? cc : [cc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } }));
  const bccRecipients = (Array.isArray(bcc) ? bcc : [bcc]).filter(Boolean).map((addr) => ({ emailAddress: { address: addr } }));

  const message = {
    subject,
    body: { contentType: 'HTML', content: html },
    toRecipients: recipients,
    ...(ccRecipients.length ? { ccRecipients } : {}),
    ...(bccRecipients.length ? { bccRecipients } : {}),
    ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph sendMail ${res.status} : ${err}`);
  }
  return { ok: true, from, to: recipients.map((r) => r.emailAddress.address) };
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

module.exports = { sendMail, listUnreadMessages, markAsRead, forwardMessage, getToken };
