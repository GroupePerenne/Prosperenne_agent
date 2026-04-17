/**
 * Templates HTML pour les mails et pages de confirmation.
 *
 * Tous les templates utilisent la charte OSEYS :
 *   --oseys-orange : #F39561
 *   --oseys-cream  : #F7F5F2
 *   --oseys-ink    : #1a1714
 */

const fs = require('fs');
const path = require('path');

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

// Signature David chargée depuis identity.json, avec {{avatar_url}} substitué
// à l'exécution. Utilisée en fin des mails envoyés par David (onboarding, etc.).
let _davidIdentity = null;
function davidSignatureHtml() {
  if (!_davidIdentity) {
    const p = path.join(__dirname, '..', 'agents', 'david', 'identity.json');
    _davidIdentity = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return _davidIdentity.signature_html.replace(/\{\{avatar_url\}\}/g, avatarUrl('david'));
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
      <td style="padding-right:20px"><img src="${avatarUrl('david')}&variant=waving" width="112" height="112" alt="David" style="border-radius:50%;display:block"/></td>
      <td style="vertical-align:middle"><div style="font-size:20px;font-weight:600">David</div><div style="font-size:12px;color:${MUTED}">Responsable commercial — OSEYS</div></td>
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
      ${niveauButton(1, 'Mode fantôme', 'Je prospecte en ton nom, invisible. Tu reçois les retours quand ça matche.', choixNiveauBase)}
      ${niveauButton(2, 'Mode duo', 'Je suis ton assistante, tu es en copie. On construit ensemble, tu valides.', choixNiveauBase)}
      ${niveauButton(3, 'Mode autonome', 'Je prospecte et je fixe les RDV directement dans ton agenda.', choixNiveauBase)}
    </table>
  </td></tr>

  <tr><td style="padding-top:28px">
    <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${MUTED};margin-bottom:12px">2. Qui prospecte ?</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      ${prospecteurCard('martin', 'Martin', photoAvatar(avatarUrl('martin'), 'Martin'), 'Ton direct et chaleureux')}
      ${prospecteurCard('mila', 'Mila', photoAvatar(avatarUrl('mila'), 'Mila'), 'Ton ouvert et conversationnel')}
      ${prospecteurCard('both', 'Les deux', duoAvatar(), 'A/B test par secteur — recommandé')}
    </tr></table>
  </td></tr>

  <tr><td style="padding-top:28px;text-align:center">
    <a href="${formUrl}" style="display:inline-block;background:${ORANGE};color:white;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px">
      Remplir mon brief en 5 minutes →
    </a>
  </td></tr>

  <tr><td style="padding-top:32px;font-size:13px;color:${MUTED};line-height:1.6">
    <p style="margin:0">Tout se passe via le formulaire — ça prend 5 minutes. Et pour toute question, un simple retour sur ce mail suffit, je te réponds vite.</p>
  </td></tr>

  <tr><td>${davidSignatureHtml()}</td></tr>

  </table>
</td></tr>
</table>
</body></html>`;
}

function niveauButton(n, titre, desc, baseUrl) {
  return `<tr><td style="padding-bottom:8px">
    <a href="${baseUrl}&niveau=${n}" style="display:block;text-decoration:none;padding:14px 16px;border:1.5px solid #E2DDD8;border-radius:10px;background:${CREAM}">
      <div style="font-size:14px;font-weight:600;color:${INK}">${titre}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:2px">${desc}</div>
    </a>
  </td></tr>`;
}

function photoAvatar(url, alt) {
  return `<img src="${url}" width="80" height="80" style="border-radius:50%;display:block;margin:0 auto" alt="${alt}"/>`;
}

// Avatar composite pour "Les deux" : Martin + Mila en mini-avatars 40x40 côte
// à côte, centrés dans un container 80x80 pour que leur milieu s'aligne
// verticalement avec les photos solo 80x80 des autres cartes.
// Layout table-based pour compat Outlook.
function duoAvatar() {
  return `<table cellpadding="0" cellspacing="0" border="0" height="80" style="margin:0 auto">
    <tr>
      <td valign="middle" style="padding-right:2px"><img src="${avatarUrl('martin')}" width="40" height="40" style="border-radius:50%;display:block" alt="Martin"/></td>
      <td valign="middle" style="padding-left:2px"><img src="${avatarUrl('mila')}" width="40" height="40" style="border-radius:50%;display:block" alt="Mila"/></td>
    </tr>
  </table>`;
}

// 3 zones de hauteur fixe pour que les cartes s'alignent horizontalement
// (photo / titre / desc) peu importe le type d'avatar.
function prospecteurCard(key, nom, avatarHtml, desc) {
  return `<td width="33%" valign="top" style="padding:4px">
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1.5px solid #E2DDD8;border-radius:10px;background:${CREAM}">
      <tr>
        <td height="80" align="center" valign="middle" style="padding:20px 8px 0">${avatarHtml}</td>
      </tr>
      <tr>
        <td height="22" align="center" valign="middle" style="padding:10px 8px 0;font-size:15px;font-weight:600;color:${INK}">${nom}</td>
      </tr>
      <tr>
        <td height="36" align="center" valign="top" style="padding:4px 8px 20px;font-size:12px;color:${MUTED};line-height:1.4">${desc}</td>
      </tr>
    </table>
  </td>`;
}

// ─── Page HTML de confirmation après clic sur choix niveau/prospecteur ────
function confirmationPage({ consultantPrenom, niveau, prospecteur }) {
  const NIVEAU_LABELS = {
    1: 'Mode fantôme — je prospecte invisible',
    2: 'Mode duo — on construit ensemble',
    3: 'Mode autonome — je prospecte et je fixe les RDV',
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
  davidSignatureHtml,
  PIXEL_GIF,
};
