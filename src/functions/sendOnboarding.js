/**
 * POST /api/sendOnboarding
 *
 * Déclenche l'envoi du mail d'onboarding David → consultant.
 *
 * Body : { "prenom": "Jean", "nom": "Dupont", "email": "jean@cabinet.fr" }
 */

const { app } = require('@azure/functions');
const { sendOnboardingEmail } = require('../../agents/david/onboarding');

app.http('sendOnboarding', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { prenom, nom, email } = body;
      if (!prenom || !email) {
        return { status: 400, jsonBody: { error: 'prenom et email requis' } };
      }

      const result = await sendOnboardingEmail({
        consultant: { prenom, nom: nom || '', email },
      });

      return { status: 200, jsonBody: { ok: true, ...result } };
    } catch (err) {
      context.error('sendOnboarding error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
