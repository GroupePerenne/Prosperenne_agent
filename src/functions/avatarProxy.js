/**
 * GET /api/avatarProxy?user=david|martin|mila
 *
 * Proxy vers Microsoft Graph : récupère la photo de profil M365 de
 * david@/martin@/mila@oseys.fr et la sert avec un cache de 1h.
 *
 * Permissions Graph requises sur l'app registration OSEYS-ProspectionAgent :
 *   - User.Read.All (Application)  — consentement admin déjà accordé
 *
 * Si la photo n'a pas encore été uploadée (Graph retourne 404), ou si un
 * appel Graph échoue pour toute autre raison, on retourne un SVG placeholder
 * (initiale dans un cercle orange OSEYS) avec le même cache — pas d'icône
 * cassée dans les mails/UI. Les erreurs sont loggées en warn pour ne pas
 * polluer Application Insights.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('@azure/functions');
const { getToken } = require('../../shared/graph-mail');

const USERS = {
  david: () => process.env.DAVID_EMAIL,
  martin: () => process.env.MARTIN_EMAIL,
  mila: () => process.env.MILA_EMAIL,
};

// Variantes d'avatar servies depuis le repo local plutôt que Graph M365.
// Utilisé pour des poses contextuelles (ex: David faisant coucou à
// l'onboarding) qu'on ne veut pas mettre en photo officielle M365.
const LOCAL_VARIANTS = {
  'david:waving': path.join(__dirname, '..', '..', 'agents', 'david', 'avatar_waving.jpeg'),
};

// Avatars standards servis depuis le repo (fallback garanti si Graph M365 vide
// ou down). Ordre de priorité dans le handler : variant local > avatar local
// standard > Graph M365 > SVG placeholder.
const LOCAL_STANDARD = {
  david: path.join(__dirname, '..', '..', 'agents', 'david', 'avatar.jpeg'),
  martin: path.join(__dirname, '..', '..', 'agents', 'martin', 'avatar.jpeg'),
  mila: path.join(__dirname, '..', '..', 'agents', 'mila', 'avatar.jpeg'),
};

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=3600' };

function placeholderSvg(initial) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="64" fill="#F39561"/><text x="64" y="82" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="56" font-weight="600">${initial}</text></svg>`;
}

function placeholderResponse(initial) {
  return {
    status: 200,
    headers: { ...CACHE_HEADERS, 'Content-Type': 'image/svg+xml; charset=utf-8' },
    body: placeholderSvg(initial),
  };
}

app.http('avatarProxy', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const user = (request.query.get('user') || '').toLowerCase();
    const variant = (request.query.get('variant') || '').toLowerCase();
    const emailResolver = USERS[user];
    if (!emailResolver) {
      return { status: 400, jsonBody: { error: 'user must be one of david, martin, mila' } };
    }

    // Variante locale : on court-circuite Graph et on sert un fichier du repo
    if (variant) {
      const localPath = LOCAL_VARIANTS[`${user}:${variant}`];
      if (localPath) {
        try {
          const buf = fs.readFileSync(localPath);
          return {
            status: 200,
            headers: { ...CACHE_HEADERS, 'Content-Type': 'image/jpeg' },
            body: buf,
          };
        } catch (err) {
          context.warn(`avatarProxy: local variant ${user}:${variant} missing (${err.message}), falling back to M365 photo`);
          // fallthrough : on tentera la photo M365 standard
        }
      }
    }

    // Priorité : avatar standard local (garantit l'affichage offline/Graph down)
    const localStandardPath = LOCAL_STANDARD[user];
    if (localStandardPath) {
      try {
        const buf = fs.readFileSync(localStandardPath);
        return {
          status: 200,
          headers: { ...CACHE_HEADERS, 'Content-Type': 'image/jpeg' },
          body: buf,
        };
      } catch (err) {
        context.warn(`avatarProxy: local standard ${user} missing (${err.message}), falling back to M365`);
      }
    }

    const email = emailResolver();
    if (!email) {
      context.warn(`avatarProxy: email env not set for user=${user}`);
      return placeholderResponse(user.charAt(0).toUpperCase());
    }

    try {
      const token = await getToken();
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/photo/$value`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (res.status === 404) {
        context.warn(`avatarProxy: Graph 404 for ${user} (${email}) — photo not yet propagated?`);
        return placeholderResponse(user.charAt(0).toUpperCase());
      }
      if (!res.ok) {
        const txt = await res.text();
        context.warn(`avatarProxy: Graph ${res.status} for ${user}: ${txt}`);
        return placeholderResponse(user.charAt(0).toUpperCase());
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      return {
        status: 200,
        headers: { ...CACHE_HEADERS, 'Content-Type': contentType },
        body: buf,
      };
    } catch (err) {
      context.warn(`avatarProxy: error for ${user}: ${err.message}`);
      return placeholderResponse(user.charAt(0).toUpperCase());
    }
  },
});
