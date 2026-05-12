/**
 * GET /api/getConsultantBrief?email=<email>&code=<function-key>
 *
 * Retourne le brief consultant (responses) déjà soumis via le formulaire
 * d'onboarding, lu depuis la Storage Table `consultantOnboarding`.
 *
 * Sert au pré-remplissage complet du formulaire HTML quand un consultant
 * doit corriger une coquille dans un brief déjà soumis (cas Elie Mougel
 * 12 mai 2026 : ville erronée saisie en valeur d'adresse libre, refonte
 * complète du formulaire évitée si on peut hydrater les 8 champs texte
 * libre depuis le brief existant).
 *
 * Auth `function` : la clé Azure Function key sert de bearer simplifié.
 * Pas d'Entra Bearer ici — le formulaire HTML est public, il ne peut pas
 * porter de token. Le compromis est acceptable pour un endpoint lecture
 * d'un brief consultant déjà en self-service (R-CRED §11.1).
 *
 * Réponses :
 *   - 200 + { ok: true, email, consultantName, responses, briefId, completedAt }
 *   - 400 { error: 'email_required' } si email absent / mal formé
 *   - 404 { error: 'consultant_not_found' } si email inconnu OU brief non complété
 *     (responses null/vide) — le formulaire continuera avec champs vides
 *   - 500 { error: <msg> } sur erreur runtime
 */

const { app } = require('@azure/functions');
const { makeSafeLogger } = require('../../shared/safe-log');
const {
  getConsultant: defaultGetConsultant,
} = require('../../shared/storage-tables/consultantOnboarding');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function isLikelyEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isEmptyResponses(responses) {
  if (responses == null) return true;
  if (typeof responses === 'string') return responses.trim().length === 0;
  if (typeof responses === 'object') {
    return Object.keys(responses).length === 0;
  }
  return false;
}

/**
 * Handler extractible pour les tests. `getConsultant` injectable via deps.
 */
async function handleGetConsultantBrief(request, context, deps = {}) {
  const log = makeSafeLogger(context);
  const getConsultant = deps.getConsultant || defaultGetConsultant;

  if (request.method === 'OPTIONS') {
    return { status: 204, headers: CORS_HEADERS };
  }

  try {
    const email = String(request.query.get('email') || '').trim().toLowerCase();
    if (!email || !isLikelyEmail(email)) {
      return {
        status: 400,
        headers: CORS_HEADERS,
        jsonBody: { error: 'email_required' },
      };
    }

    const consultant = await getConsultant(email);
    if (!consultant || isEmptyResponses(consultant.responses)) {
      log.info('getConsultantBrief.not_found', { email });
      return {
        status: 404,
        headers: CORS_HEADERS,
        jsonBody: { error: 'consultant_not_found' },
      };
    }

    log.info('getConsultantBrief.ok', { email, briefId: consultant.briefId || '' });
    return {
      status: 200,
      headers: CORS_HEADERS,
      jsonBody: {
        ok: true,
        email: consultant.consultantEmail || email,
        consultantName: consultant.consultantName || '',
        briefId: consultant.briefId || '',
        completedAt: consultant.completedAt || '',
        responses: consultant.responses,
      },
    };
  } catch (err) {
    log.error('getConsultantBrief error:', err);
    return {
      status: 500,
      headers: CORS_HEADERS,
      jsonBody: { error: err.message || 'internal_error' },
    };
  }
}

app.http('getConsultantBrief', {
  methods: ['GET', 'OPTIONS'],
  authLevel: 'function',
  handler: (request, context) => handleGetConsultantBrief(request, context),
});

module.exports = {
  handleGetConsultantBrief,
};
