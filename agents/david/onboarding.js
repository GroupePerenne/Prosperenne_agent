/**
 * Envoi du mail d'onboarding au consultant par David.
 *
 * Le mail contient :
 *  - Une présentation de l'équipe (David + Martin + Mila)
 *  - 3 boutons "Niveau 1 / 2 / 3" qui pointent vers /api/choixNiveau
 *  - 3 cartes "Martin / Mila / Les deux" en visuel
 *  - Un bouton principal vers le formulaire de qualification avec pré-remplissage URL
 */

const { sendMail } = require('../../shared/graph-mail');
const { onboardingEmailHtml } = require('../../shared/templates');

/**
 * @param {Object} consultant
 * @param {string} consultant.prenom
 * @param {string} consultant.nom
 * @param {string} consultant.email
 */
async function sendOnboardingEmail({ consultant }) {
  const formBase = process.env.PUBLIC_FORMS_BASE_URL || 'https://groupeperenne.github.io/Prosperenne_agent/forms';
  const formUrl = `${formBase}/qualification.html?` + new URLSearchParams({
    nom: `${consultant.prenom} ${consultant.nom || ''}`.trim(),
    email: consultant.email,
  }).toString();

  // L'URL de base de choixNiveau avec les infos du consultant — on y ajoutera
  // &niveau=X et/ou &prospecteur=Y dans les boutons du template
  const sendMailFuncCode = process.env.CHOIXNIVEAU_FUNC_CODE || '';
  const choixNiveauHost = process.env.FUNCTION_APP_HOST || 'oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net';
  const choixNiveauBase = `https://${choixNiveauHost}/api/choixNiveau?`
    + new URLSearchParams({
      code: sendMailFuncCode,
      consultant: `${consultant.prenom} ${consultant.nom || ''}`.trim(),
      email: consultant.email,
    }).toString();

  const html = onboardingEmailHtml({
    consultantPrenom: consultant.prenom,
    formUrl,
    choixNiveauBase,
  });

  return sendMail({
    from: process.env.DAVID_EMAIL,
    to: consultant.email,
    subject: `Bienvenue dans le réseau OSEYS, ${consultant.prenom}`,
    html,
  });
}

module.exports = { sendOnboardingEmail };
