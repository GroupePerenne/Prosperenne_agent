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
const { getMem0 } = require('./adapters/memory/mem0');

/**
 * Résout l'adresse Smart BCC Pipedrive d'un consultant à partir de son
 * email. La liste est petite et connue (MVP pilotes Morgane + Johnny) ;
 * on étend au fil des nouveaux consultants.
 */
function getConsultantBCC(consultantEmail) {
  if (!consultantEmail) return null;
  const email = consultantEmail.toLowerCase();
  if (email.includes('dejessey') || email.includes('morgane')) return process.env.PIPEDRIVE_BCC_MORGANE || null;
  if (email.includes('serra') || email.includes('johnny')) return process.env.PIPEDRIVE_BCC_JOHNNY || null;
  return null;
}

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

// ─── Mem0 enrichments (pur, testable en isolation) ─────────────────────────
// Skip prospect si lead.siren absent (pas d'email-as-fallback — cf. CLAUDE.md
// et arbitrage produit session 21 avril 2026). Patterns retrievés quoi qu'il
// arrive. Les deux retrieves s'exécutent en parallèle.
async function resolveMem0Enrichments({ mem0, lead, context }) {
  if (!mem0) return { prospectMemories: [], patternMemories: [] };

  const tasks = [];
  if (lead && lead.siren) {
    tasks.push(mem0.retrieveProspect(lead.siren));
  } else {
    warnLog(context, `[mem0] prospect retrieve skipped: no SIREN for lead ${(lead && lead.email) || '(no email)'}`);
    tasks.push(Promise.resolve([]));
  }
  tasks.push(mem0.retrievePatterns({ sector: lead && lead.secteur }));

  const [prospectMemories, patternMemories] = await Promise.all(tasks);
  return { prospectMemories, patternMemories };
}

function warnLog(context, message) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(message);
  else if (typeof context.log === 'function') context.log(message);
}

// ─── Item 2 — Escalation match flou (même org, autre person) ───────────────
/**
 * Prévient le consultant owner du deal existant qu'on renonce à prospecter
 * ce lead pour éviter un doublon de contact côté client.
 *
 * Résolution de l'owner (ordre de préférence) :
 *   1. deal.user_id.email (si embedded dans la réponse Pipedrive)
 *   2. pipedrive.getUserEmail(deal.user_id.id)
 *   3. Fallback direction@oseys.fr (env ESCALATION_EMAIL) si non résolvable
 *
 * Best effort : toute erreur de sendMail est swallow + warn log.
 * deps injectable pour tests (sendMail, pipedriveMod).
 */
async function sendFuzzyMatchEscalation({ fuzzyDeal, lead, context, deps = {} }) {
  const sendMailImpl = deps.sendMail || sendMail;
  const pipedriveMod = deps.pipedriveMod || pipedrive;

  try {
    const davidEmail = process.env.DAVID_EMAIL;
    const direction = process.env.ESCALATION_EMAIL || 'direction@oseys.fr';
    const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN || 'oseys';
    const dealLink = `https://${domain}.pipedrive.com/deal/${fuzzyDeal.id}`;

    let ownerEmail = (fuzzyDeal.user_id && fuzzyDeal.user_id.email) || null;
    if (!ownerEmail && fuzzyDeal.user_id && fuzzyDeal.user_id.id) {
      try {
        ownerEmail = await pipedriveMod.getUserEmail(fuzzyDeal.user_id.id);
      } catch {
        ownerEmail = null;
      }
    }

    const ownerFullName = (fuzzyDeal.user_id && fuzzyDeal.user_id.name) || '';
    const ownerPrenom = ownerFullName.split(/\s+/)[0] || '';

    if (ownerEmail) {
      await sendMailImpl({
        from: davidEmail,
        to: ownerEmail,
        subject: `[David] Prospect déjà en suivi : ${lead.entreprise || ''}`,
        html: renderFuzzyMatchEmailHtml({ ownerPrenom, lead, dealLink }),
      });
      return { sent: true, to: ownerEmail };
    }

    // Owner non résolvable → escalade à direction
    await sendMailImpl({
      from: davidEmail,
      to: direction,
      subject: `[David] Escalation non attribuable : ${lead.entreprise || ''}`,
      html: renderUnattributableEmailHtml({ lead, dealLink }),
    });
    return { sent: true, to: direction, unattributable: true };
  } catch (err) {
    warnLog(context, `[dedup] escalation email failed: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

function renderFuzzyMatchEmailHtml({ ownerPrenom, lead, dealLink }) {
  const greet = ownerPrenom || 'équipe';
  const prospectName = `${lead.prenom || ''} ${lead.nom || ''}`.trim();
  return `<p>Bonjour ${escapeHtml(greet)},</p>

<p>Un de tes prospects actuellement en suivi dans ton pipeline apparaît aussi dans la base qu'on voulait contacter via David :</p>

<ul>
  <li><strong>Prospect :</strong> ${escapeHtml(prospectName)} — ${escapeHtml(lead.entreprise || '')}</li>
  <li><strong>Email :</strong> ${escapeHtml(lead.email || '')}</li>
  <li><strong>Ton deal en cours :</strong> <a href="${escapeHtml(dealLink)}">${escapeHtml(dealLink)}</a></li>
</ul>

<p>Pour éviter tout doublon, David ne lancera aucune séquence sur ce prospect. Si tu veux qu'on passe le suivi à David (parce que tu n'as plus d'action prévue), il suffit de nous le dire.</p>

<p>--<br>David (agent IA Prospérenne)</p>`;
}

function renderUnattributableEmailHtml({ lead, dealLink }) {
  const prospectName = `${lead.prenom || ''} ${lead.nom || ''}`.trim();
  return `<p>Un prospect apparaît dans la base à prospecter mais est déjà suivi dans un pipeline Pipedrive dont le propriétaire ne peut pas être résolu (user_id orphelin ou désactivé).</p>

<ul>
  <li><strong>Prospect :</strong> ${escapeHtml(prospectName)} — ${escapeHtml(lead.entreprise || '')} (${escapeHtml(lead.email || '')})</li>
  <li><strong>Deal existant :</strong> <a href="${escapeHtml(dealLink)}">${escapeHtml(dealLink)}</a></li>
</ul>

<p>Intervention humaine requise : décider si on transfère le suivi à David ou si on laisse au consultant propriétaire.</p>

<p>--<br>David (agent IA Prospérenne)</p>`;
}

// ─── Bootstrap d'une séquence : check leads existants, génère les 5 messages,
//     envoie J0 (ou le schedule si hors créneau), programme J+4/J+10/J+18/J+28
async function bootstrapSequence({ agent, consultant, lead, dealId, personId, orgId, context, mem0: mem0Override }) {
  const identity = loadIdentity(agent);

  // 0. Filtrage leads existants : si le prospect est déjà dans un deal actif
  // d'un autre pipeline Pipedrive, on skippe.
  // - Match clair (même person_id) → skip silencieux, pas d'envoi
  // - Match flou (même org_id mais person_id différent) → skip + mail
  //   d'escalation au consultant owner du deal existant (best effort).
  if (personId || orgId) {
    try {
      const existing = await pipedrive.findExistingDealsAcrossAllPipes({ personId, orgId });
      if (existing.length > 0) {
        const clearMatch = personId ? existing.find((d) => d.person_id?.value === personId) : null;
        if (clearMatch) {
          return { skipped: true, reason: 'existing_deal_clear', matchDealId: clearMatch.id, matchPipeline: clearMatch.pipeline_id };
        }
        const fuzzyMatch = orgId ? existing.find((d) => d.org_id?.value === orgId) : null;
        if (fuzzyMatch) {
          await sendFuzzyMatchEscalation({ fuzzyDeal: fuzzyMatch, lead, context });
          return { skipped: true, reason: 'existing_deal_fuzzy', matchDealId: fuzzyMatch.id, matchPipeline: fuzzyMatch.pipeline_id, needsEscalation: true, escalationSent: true };
        }
      }
    } catch (err) {
      // Si Pipedrive est down, on log mais on ne bloque pas l'envoi.
      // (l'appelant aura les infos via le log ; on préfère envoyer que de rater)
      console.warn(`bootstrapSequence: findExistingDeals failed (${err.message}), continuing`);
    }
  }

  // 1. Génération des 5 messages via Claude, enrichie par Mem0 si disponible
  const adjustedConsultant = {
    ...consultant,
    ton: consultant.ton || identity.ton_ajustements.registre_par_defaut,
  };

  const mem0 = mem0Override !== undefined ? mem0Override : getMem0(context);
  const enrichments = await resolveMem0Enrichments({ mem0, lead, context });

  const steps = await generateSequence({
    consultant: adjustedConsultant,
    agent: { prenom: identity.prenom, mail: identity.email, signature: identity.signature_html },
    lead,
    enrichments,
  });

  // 2. Détermine le slot J0 (maintenant si on est dans le créneau ouvré
  // 9h-11h Paris, sinon prochain créneau ouvré à 9h Paris)
  const now = new Date();
  const j0Slot = nextBusinessDayAt(now);
  const j0IsImmediate = j0Slot.getTime() - now.getTime() < 60_000; // < 1 min = on considère immédiat

  const results = { scheduled: [], sent: [] };

  // 3. J0 : envoi direct si dans le créneau, sinon push en queue
  const j0 = steps[0];
  const consultantBCC = getConsultantBCC(adjustedConsultant.email);
  if (j0IsImmediate) {
    const html = renderEmailHtml({
      identity, consultant: adjustedConsultant, corps: j0.corps, dealId, personId, day: 'J0',
    });
    await sendMail({
      from: identity.email,
      to: lead.email,
      bcc: consultantBCC ? [consultantBCC] : [],
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
    // Fire-and-forget feedback exhauster : le mail vient de sortir, on
    // l'enregistre comme 'delivered' (Graph n'émet pas d'accusé réception
    // immédiat, on prend le succès sendMail comme proxy). Les bounces
    // futurs corrigeront ce statut via davidInbox.handleBounceAction.
    reportExhausterDelivered(lead).catch(() => {});
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

  const consultantBCC = getConsultantBCC(consultant?.email);
  await sendMail({
    from: identity.email,
    to: lead.email,
    bcc: consultantBCC ? [consultantBCC] : [],
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

  reportExhausterDelivered(lead).catch(() => {});
  return { sent: jour };
}

/**
 * Fire-and-forget hook : notifie lead-exhauster qu'un mail vient d'être
 * délivré par Graph. Alimente LeadContacts.feedbackStatus='delivered'.
 *
 * Si le lead n'a pas de siren (ancien format DTO) ou pas de nom exploitable,
 * le no-op est silencieux. Aucune exception n'est propagée.
 */
async function reportExhausterDelivered(lead) {
  if (!lead || !lead.siren) return;
  try {
    const { leadExhauster } = require('./lead-exhauster');
    await leadExhauster.reportFeedback({
      siren: lead.siren,
      firstName: lead.prenom || '',
      lastName: lead.nom || '',
      status: 'delivered',
      timestamp: new Date().toISOString(),
    });
  } catch {
    // swallow
  }
}

module.exports = {
  loadIdentity,
  bootstrapSequence,
  sendScheduledStep,
  resolveMem0Enrichments,
  sendFuzzyMatchEscalation,
};
