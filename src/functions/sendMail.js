/**
 * POST /api/sendMail
 *
 * Body :
 * {
 *   "from": "david@oseys.fr" | "martin@oseys.fr" | "mila@oseys.fr",
 *   "to":   "constantin@example.fr" | ["a@x", "b@y"],
 *   "cc":   ["c@z"]  (optionnel),
 *   "subject": "...",
 *   "html": "...",
 *   "replyTo": "..."  (optionnel)
 * }
 *
 * Les `from` autorisés sont validés contre les variables d'env
 * DAVID_EMAIL / MARTIN_EMAIL / MILA_EMAIL pour éviter les abus.
 */

const { app } = require('@azure/functions');
const { sendMail } = require('../../shared/graph-mail');

app.http('sendMail', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { from, to, subject, html } = body;

      if (!from || !to || !subject || !html) {
        return { status: 400, jsonBody: { error: 'Champs requis : from, to, subject, html' } };
      }

      const allowed = [
        process.env.DAVID_EMAIL,
        process.env.MARTIN_EMAIL,
        process.env.MILA_EMAIL,
      ].filter(Boolean);

      if (!allowed.includes(from)) {
        return { status: 403, jsonBody: { error: `Adresse d'envoi non autorisée : ${from}` } };
      }

      const result = await sendMail({
        from,
        to,
        cc: body.cc,
        subject,
        html,
        replyTo: body.replyTo,
      });

      return { status: 200, jsonBody: { success: true, ...result } };
    } catch (err) {
      context.error('sendMail error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
