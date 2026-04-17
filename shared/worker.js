/**
 * Worker partagé entre Martin et Mila.
 *
 * Rôle : envoyer un step d'une séquence (J0, J3, J7, J14) pour un lead donné,
 * au nom d'un consultant, depuis la boîte de l'agent (martin@ ou mila@).
 *
 * Le worker n'est jamais appelé directement par un humain — il est déclenché :
 *   - par la function `runSequence` pour le J0 (bootstrap)
 *   - par la function `scheduler` pour les J3/J7/J14 (consommation de queue)
 */

const path = require('path');
const fs = require('fs');
const { sendMail } = require('./graph-mail');
const { generateSequence, SCHEDULE } = require('./sequence');
const { scheduleRelance } = require('./queue');
const { nextBusinessDayAt, addBusinessDays } = require('./holidays');
const pipedrive = require('./pipedrive');

// ─── Chargement des identités ─────────────────────────────────────────────
function loadIdentity(agent) {
  if (!['martin', 'mila'].includes(agent)) {
    throw new Error(`Agent inconnu : ${agent}`);
  }
  const p = path.join(__dirname, '..', 'agents', agent, 'identity.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── Pixel de tracking ────────────────────────────────────────────────────
function buildTrackingPixel({ identity, dealId, personId, day }) {
  if (!identity.tracking?.pixel_enabled) return '';
  const url = new URL(identity.tracking.pixel_endpoint);
  if (dealId) url.searchParams.set('deal', dealId);
  if (personId) url.searchParams.set('person', personId);
  url.searchParams.set('agent', identity.prenom.toLowerCase());
  url.searchParams.set('day', day);
  return `<img src="${url.toString()}" width="1" height="1" alt="" style="display:none" />`;
}

// ─── Rendu du corps HTML avec signature + pixel ───────────────────────────
function renderEmailHtml({ identity, consultant, corps, dealId, personId, day }) {
  const avatarBase = process.env.FUNCTION_APP_URL || 'http://localhost:7071';
  const signatureHtml = identity.signature_html
    .replace(/\{\{avatar_url\}\}/g, `${avatarBase}/api/avatarProxy?user=${identity.avatar_user}`)
    .replace(/\{\{consultant_nom\}\}/g, consultant.nom);

  const bodyHtml = corps
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1714">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const pixel = buildTrackingPixel({ identity, dealId, personId, day });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;color:#1a1714">
${bodyHtml}
${signatureHtml}
${pixel}
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ─── Bootstrap d'une séquence : génère les 5 messages, envoie J0 (ou le
//     schedule si hors créneau ouvré), programme J+4/J+10/J+18/J+28 ──────────
async function bootstrapSequence({ agent, consultant, lead, dealId, personId }) {
  const identity = loadIdentity(agent);

  // 1. Génération des 5 messages via Claude
  const adjustedConsultant = {
    ...consultant,
    ton: consultant.ton || identity.ton_ajustements.registre_par_defaut,
  };
  const steps = await generateSequence({
    consultant: adjustedConsultant,
    agent: { prenom: identity.prenom, mail: identity.email, signature: identity.signature_html },
    lead,
  });

  // 2. Détermine le slot J0 (maintenant si on est dans le créneau ouvré
  // 9h-11h Paris, sinon prochain créneau ouvré à 9h Paris)
  const now = new Date();
  const j0Slot = nextBusinessDayAt(now);
  const j0IsImmediate = j0Slot.getTime() - now.getTime() < 60_000; // < 1 min = on considère immédiat

  const results = { scheduled: [], sent: [] };

  // 3. J0 : envoi direct si dans le créneau, sinon push en queue
  const j0 = steps[0];
  if (j0IsImmediate) {
    const html = renderEmailHtml({
      identity, consultant: adjustedConsultant, corps: j0.corps, dealId, personId, day: 'J0',
    });
    await sendMail({
      from: identity.email,
      to: lead.email,
      subject: j0.objet,
      html,
      replyTo: process.env.DAVID_EMAIL,
    });
    if (dealId || personId) {
      await pipedrive.logEmailSent({
        dealId, personId, sender: identity.prenom, day: 'J0',
        subject: j0.objet, bodyPreview: j0.corps.slice(0, 200),
      });
    }
    results.sent.push('J0');
  } else {
    await scheduleRelance({
      agent, day: 'J0',
      targetDate: j0Slot.toISOString(),
      consultant: adjustedConsultant, lead, dealId, personId,
      preGeneratedStep: { jour: 'J0', objet: j0.objet, corps: j0.corps },
    });
    results.scheduled.push('J0');
  }

  // 4. J+4, J+10, J+18, J+28 — tous poussés dans la queue, dates relatives à j0Slot
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const targetDate = addBusinessDays(j0Slot, s.offsetBusinessDays);
    await scheduleRelance({
      agent, day: s.jour,
      targetDate: targetDate.toISOString(),
      consultant: adjustedConsultant, lead, dealId, personId,
      preGeneratedStep: { jour: s.jour, objet: s.objet, corps: s.corps },
    });
    results.scheduled.push(s.jour);
  }

  return results;
}

// ─── Envoi d'un step programmé (consommé par le scheduler) ──────────────────
async function sendScheduledStep(job) {
  const { agent, consultant, lead, dealId, personId, preGeneratedStep } = job;
  const identity = loadIdentity(agent);

  const { jour, objet, corps } = preGeneratedStep;
  const html = renderEmailHtml({
    identity, consultant, corps, dealId, personId, day: jour,
  });

  await sendMail({
    from: identity.email,
    to: lead.email,
    subject: objet,
    html,
    replyTo: process.env.DAVID_EMAIL,
  });

  if (dealId || personId) {
    await pipedrive.logEmailSent({
      dealId, personId,
      sender: identity.prenom,
      day: jour,
      subject: objet,
      bodyPreview: corps.slice(0, 200),
    });
  }

  return { sent: jour };
}

module.exports = {
  loadIdentity,
  bootstrapSequence,
  sendScheduledStep,
};
