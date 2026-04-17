/**
 * Templates HTML pour les mails et pages de confirmation.
 *
 * Tous les templates utilisent la charte OSEYS :
 *   --oseys-orange : #F39561
 *   --oseys-cream  : #F7F5F2
 *   --oseys-ink    : #1a1714
 */

const ORANGE = '#F39561';
const ORANGE_DARK = '#D47646';
const CREAM = '#F7F5F2';
const INK = '#1a1714';
const MUTED = '#7a756f';
const TINT = '#FFF2EB';

// Les avatars sont servis par la Function App via /api/avatarProxy (proxy Graph
// vers la photo M365 de david@/martin@/mila@, avec fallback SVG placeholder).
// On évalue l'URL au runtime pour ne pas figer FUNCTION_APP_URL au require time.
function avatarUrl(user) {
  const base = process.env.FUNCTION_APP_URL || 'http://localhost:7071';
  return `${base}/api/avatarProxy?user=${user}`;
}

// ─── Mail d'onboarding envoyé par David au consultant ─────────────────────
function onboardingEmailHtml({ consultantPrenom, formUrl, choixNiveauBase }) {
  // choixNiveauBase inclut déjà le code et les paramètres consultant/email
  // On ajoute juste &niveau=X&prospecteur=Y dans les boutons
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:${CREAM};font-family:Arial,Helvetica,sans-serif;color:${INK}">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CREAM};padding:40px 20px">
<tr><td align="center">
  <table cellpadding="0" cellspacing="0" border="0" width="560" style="background:white;border-radius:16px;padding:40px 36px;max-width:560px">

  <tr><td style="padding-bottom:24px">
    <table cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="padding-right:14px"><img src="${avatarUrl('david')}" width="56" height="56" alt="David" style="border-radius:50%;display:block"/></td>
      <td style="vertical-align:middle"><div style="font-size:16px;font-weight:600">David</div><div style="font-size:12px;color:${MUTED}">Responsable commercial — OSEYS</div></td>
    </tr></table>
  </td></tr>

  <tr><td style="font-size:15px;line-height:1.6">
    <p>Salut ${consultantPrenom},</p>
    <p>Je suis David, responsable commercial OSEYS. Je manage une petite équipe de deux prospecteurs — <strong>Martin</strong> et <strong>Mila</strong> — qui peuvent aller chercher des rendez-vous à ta place auprès des entreprises qui correspondent à ta cible.</p>
    <p>Avant qu'on s'y mette, deux choses à me dire :</p>
  </td></tr>

  <tr><td style="padding-top:24px">
    <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${MUTED};margin-bottom:12px">1. Ton niveau d'autonomie</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${niveauButton(1, 'Prospecte pour moi', 'Martin/Mila envoient depuis leur boîte. Zéro friction côté toi.', choixNiveauBase)}
      ${niveauButton(2, 'Je valide avant envoi', 'Tu reçois les messages en brouillon, tu ajustes et tu envoies en un clic.', choixNiveauBase)}
      ${niveauButton(3, 'Déploie chez moi', 'Les agents tournent dans ton environnement. Tu es propriétaire.', choixNiveauBase)}
    </table>
  </td></tr>

  <tr><td style="padding-top:28px">
    <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${MUTED};margin-bottom:12px">2. Qui prospecte ?</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      ${prospecteurCard('martin', 'Martin', avatarUrl('martin'), 'Ton direct et chaleureux')}
      ${prospecteurCard('mila', 'Mila', avatarUrl('mila'), 'Ton ouvert et conversationnel')}
      ${prospecteurCard('both', 'Les deux', null, 'A/B test par secteur — recommandé')}
    </tr></table>
    <p style="font-size:12px;color:${MUTED};margin-top:14px">Tu pourras me dire ça dans le formulaire juste après, ou directement en répondant à ce mail.</p>
  </td></tr>

  <tr><td style="padding-top:28px;text-align:center">
    <a href="${formUrl}" style="display:inline-block;background:${ORANGE};color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px">
      Remplir mon brief en 5 minutes →
    </a>
  </td></tr>

  <tr><td style="padding-top:32px;font-size:13px;color:${MUTED};line-height:1.6">
    <p style="margin:0">Si tu as une question avant, réponds-moi directement — je lis toutes les réponses.</p>
    <p style="margin:8px 0 0">David<br><span style="font-size:12px">david@oseys.fr</span></p>
  </td></tr>

  </table>
</td></tr>
</table>
</body></html>`;
}

function niveauButton(n, titre, desc, baseUrl) {
  return `<tr><td style="padding-bottom:8px">
    <a href="${baseUrl}&niveau=${n}" style="display:block;text-decoration:none;padding:14px 16px;border:1.5px solid #E2DDD8;border-radius:10px;background:${CREAM}">
      <div style="font-size:14px;font-weight:600;color:${INK}">Niveau ${n} — ${titre}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:2px">${desc}</div>
    </a>
  </td></tr>`;
}

function prospecteurCard(key, nom, avatar, desc) {
  const avatarHtml = avatar
    ? `<img src="${avatar}" width="40" height="40" style="border-radius:50%;display:block;margin:0 auto 6px"/>`
    : `<div style="width:40px;height:40px;background:${TINT};color:${ORANGE_DARK};border-radius:50%;display:block;margin:0 auto 6px;line-height:40px;text-align:center;font-size:18px">👥</div>`;
  return `<td width="33%" style="padding:4px;vertical-align:top">
    <div style="border:1.5px solid #E2DDD8;border-radius:10px;padding:14px 8px;text-align:center;background:${CREAM};min-height:130px;display:flex;flex-direction:column;justify-content:center">
      ${avatarHtml}
      <div style="font-size:13px;font-weight:600">${nom}</div>
      <div style="font-size:11px;color:${MUTED};margin-top:4px;line-height:1.4">${desc}</div>
    </div>
  </td>`;
}

// ─── Page HTML de confirmation après clic sur choix niveau/prospecteur ────
function confirmationPage({ consultantPrenom, niveau, prospecteur }) {
  const NIVEAU_LABELS = {
    1: 'Niveau 1 — on prospecte pour toi',
    2: 'Niveau 2 — on rédige, tu valides',
    3: 'Niveau 3 — déploiement chez toi',
  };
  const PROSPECTEUR_LABELS = {
    martin: 'Martin',
    mila: 'Mila',
    both: 'Martin & Mila (A/B test)',
  };

  const badges = [];
  if (niveau && NIVEAU_LABELS[niveau]) badges.push(NIVEAU_LABELS[niveau]);
  if (prospecteur && PROSPECTEUR_LABELS[prospecteur]) badges.push(PROSPECTEUR_LABELS[prospecteur]);
  if (badges.length === 0) badges.push('Choix enregistré');

  const badgesHtml = badges.map((b) => `<div class="choice">${b}</div>`).join('\n    ');

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<title>C'est noté</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:${CREAM};min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.card{background:white;border-radius:16px;padding:2.5rem 2rem;max-width:480px;width:100%;text-align:center;border:1px solid #E2DDD8}
.icon{width:56px;height:56px;border-radius:50%;background:${TINT};display:flex;align-items:center;justify-content:center;margin:0 auto 1.25rem;font-size:24px;color:${ORANGE_DARK}}
h1{font-family:'Syne',sans-serif;font-size:24px;margin-bottom:.5rem;color:${INK}}
.choice{display:inline-block;background:${TINT};color:${ORANGE_DARK};font-size:13px;font-weight:500;padding:6px 14px;border-radius:100px;margin:4px}
p{color:${MUTED};font-weight:300;font-size:14px;line-height:1.6;margin-top:1rem}
</style>
</head>
<body>
<div class="card">
  <div class="icon">✓</div>
  <h1>C'est noté, ${consultantPrenom} !</h1>
  <div>
    ${badgesHtml}
  </div>
  <p>David revient vers toi très vite pour la suite.</p>
</div>
</body></html>`;
}

// ─── Pixel de tracking (1x1 transparent GIF) ──────────────────────────────
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

module.exports = {
  onboardingEmailHtml,
  confirmationPage,
  PIXEL_GIF,
};
