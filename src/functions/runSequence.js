/**
 * POST /api/runSequence
 *
 * Déclenche une séquence de prospection pour un batch de leads au nom d'un
 * consultant. Utilisé par David après validation du brief.
 *
 * Body attendu :
 * {
 *   "consultant": { "nom": "...", "email": "...", "offre": "...", "ton": "...", "tutoiement": true },
 *   "brief":      { "prospecteur": "martin" | "mila" | "both" },
 *   "leads":      [ { "prenom": "...", "entreprise": "...", "email": "...", "secteur": "...", ... } ]
 * }
 */

const { app } = require('@azure/functions');
const { launchSequenceForConsultant } = require('../../agents/david/orchestrator');

app.http('runSequence', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const { consultant, brief, leads } = body;
      if (!consultant || !brief || !Array.isArray(leads) || leads.length === 0) {
        return { status: 400, jsonBody: { error: 'consultant, brief et leads[] requis' } };
      }

      const results = await launchSequenceForConsultant({ consultant, brief, leads, context });
      const ok = results.filter((r) => !r.error).length;
      const ko = results.length - ok;

      return { status: 200, jsonBody: { ok_count: ok, error_count: ko, results } };
    } catch (err) {
      context.error('runSequence error:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
