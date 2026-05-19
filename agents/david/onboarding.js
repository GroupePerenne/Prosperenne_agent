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
const { recordOnboardingSent } = require('../../shared/storage-tables/consultantOnboarding');
const { recordAction } = require('../../shared/storage-tables/davidActions');

/**
 * @param {Object} consultant
 * @param {string} consultant.prenom
 * @param {string} consultant.nom
 * @param {string} consultant.email
 */
async function sendOnboardingEmail({ consultant }) {
  const formBase = process.env.PUBLIC_FORMS_BASE_URL || 'https://groupeperenne.github.io/Pereneo_agents/forms';
  // Path GitHub Pages : on garde formulaire-oseys.html tant que le rename
  // côté repo GitHub Pages n'est pas fait (chantier séparé côté Paul / autre
  // instance). Le nom du fichier HTML public est invisible côté consultant
  // (lien cliquable, pas affiché en clair).
  const formUrl = `${formBase}/formulaire-oseys.html?` + new URLSearchParams({
    nom: `${consultant.prenom} ${consultant.nom || ''}`.trim(),
    email: consultant.email,
  }).toString();

  // L'URL de base de choixNiveau avec les infos du consultant — on y ajoutera
  // &niveau=X et/ou &prospecteur=Y dans les boutons du template
  const sendMailFuncCode = process.env.CHOIXNIVEAU_FUNC_CODE || '';
  const choixNiveauHost = process.env.FUNCTION_APP_HOST || 'pereneo-mail-sender.azurewebsites.net';
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

  const result = await sendMail({
    from: process.env.DAVID_EMAIL,
    to: consultant.email,
    subject: `Bienvenue dans le réseau Pérenne, ${consultant.prenom}`,
    html,
  });

  // Best-effort tracking PWA-M Cycle 1 — n'altère pas le retour caller.
  const consultantName = `${consultant.prenom} ${consultant.nom || ''}`.trim();
  const sentAt = new Date().toISOString();
  await Promise.all([
    recordOnboardingSent({
      consultantEmail: consultant.email,
      consultantName,
      sentAt,
    }).catch(() => null),
    recordAction({
      consultantEmail: consultant.email,
      type: 'onboarding_sent',
      summary: `Mail d'onboarding David envoyé à ${consultantName}`,
      metadata: { from: process.env.DAVID_EMAIL || 'david@perennereseau.fr' },
      at: sentAt,
    }).catch(() => null),
  ]);

  return result;
}

module.exports = { sendOnboardingEmail };
