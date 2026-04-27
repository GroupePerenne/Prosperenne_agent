/**
 * GET /api/trackOpen?deal=<id>&person=<id>&agent=<martin|mila>&day=<J0|J3|J7|J14>
 *
 * Injecté en fin de mail par Martin/Mila :
 *   <img src="https://.../api/trackOpen?deal=42&agent=martin&day=J0" width="1" height="1">
 *
 * Quand le client mail du prospect charge l'image, on logge l'ouverture
 * dans Pipedrive comme activité "email_open". On retourne toujours le pixel
 * GIF transparent, même en cas d'erreur, pour ne pas afficher d'icône cassée.
 */

const { app } = require('@azure/functions');
const pipedrive = require('../../shared/pipedrive');
const { PIXEL_GIF } = require('../../shared/templates');

app.http('trackOpen', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const dealId = parseInt(request.query.get('deal') || '', 10);
      const personId = parseInt(request.query.get('person') || '', 10);
      const agent = (request.query.get('agent') || '').toLowerCase();
      const day = request.query.get('day') || 'J?';

      if ((dealId || personId) && ['martin', 'mila'].includes(agent)) {
        await pipedrive.logEmailOpened({
          dealId: dealId || undefined,
          personId: personId || undefined,
          sender: agent,
          day,
        });
      }
    } catch (err) {
      context.warn('trackOpen log failed:', err.message);
    }

    return {
      status: 200,
      headers: {
        'Content-Type': 'image/gif',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
      },
      body: PIXEL_GIF,
    };
  },
});
