/**
 * Orchestrator David.
 *
 * Deux points d'entrée :
 *   1. `handleInboxPoll()` — appelé périodiquement par le timer trigger
 *      `davidInbox` pour lire les mails non lus et les router.
 *   2. `launchSequenceForConsultant(brief, leads)` — appelé par David après
 *      validation d'un brief consultant, pour déclencher Martin et/ou Mila.
 *
 * David est le seul agent qui parle aux consultants. Martin et Mila ont
 * leur `replyTo` configuré sur david@oseys.fr : toute réponse d'un prospect
 * atterrit donc dans la boîte de David, qui décide quoi en faire.
 *
 * Classification fine des réponses prospects (6 classes — cf. CLAUDE.md §1.7
 * et prompt.md) :
 *   positive / question / neutre / negative / out_of_office / bounce
 * Si confidence < 0.7 → escalation à direction@oseys.fr (avec consultant en CC).
 */

const fs = require('fs');
const path = require('path');
const { listUnreadMessages, markAsRead, sendMail } = require('../../shared/graph-mail');
const { callClaude, parseJson } = require('../../shared/anthropic');
const { davidSignatureHtml } = require('../../shared/templates');
const { purgeByDealId } = require('../../shared/queue');
const martin = require('../martin/worker');
const mila = require('../mila/worker');
const pipedrive = require('../../shared/pipedrive');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompt.md'), 'utf8');
const CONFIDENCE_THRESHOLD = 0.7;

// ─── Détection bounce pré-Claude ───────────────────────────────────────────
// Les NDR (Non-Delivery Reports) ont des patterns stables. On détecte
// avant l'appel LLM pour gagner du temps et avoir une reconnaissance fiable.
const BOUNCE_FROM_PATTERNS = [
  /postmaster@/i,
  /mailer-daemon@/i,
  /noreply-bounce@/i,
  /bounce@/i,
];
const BOUNCE_SUBJECT_PATTERNS = [
  /undeliverable/i,
  /delivery status notification/i,
  /échec de la remise/i,
  /impossible de remettre/i,
  /returned mail/i,
  /failure notice/i,
];

function isBounce(msg) {
  const from = msg.from?.emailAddress?.address || '';
  const subject = msg.subject || '';
  if (BOUNCE_FROM_PATTERNS.some((r) => r.test(from))) return true;
  if (BOUNCE_SUBJECT_PATTERNS.some((r) => r.test(subject))) return true;
  return false;
}

function extractBouncedAddress(msg) {
  const body = msg.body?.content || msg.bodyPreview || '';
  // Cherche une adresse email dans le corps (souvent dans <address> ou en plain text)
  const match = body.match(/<([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>/i)
    || body.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1].toLowerCase() : null;
}

// ─── Lecture et routage de l'inbox ─────────────────────────────────────────
async function handleInboxPoll() {
  const mailbox = process.env.DAVID_EMAIL;
  const unread = await listUnreadMessages({ mailbox, top: 20 });

  const results = [];
  for (const msg of unread) {
    try {
      const decision = await routeMessage(msg);
      results.push({ id: msg.id, subject: msg.subject, ...decision });
      await markAsRead({ mailbox, messageId: msg.id });
    } catch (err) {
      results.push({ id: msg.id, error: err.message });
    }
  }
  return results;
}

// ─── Routage d'un message ──────────────────────────────────────────────────
async function routeMessage(msg) {
  // 1. Détection bounce (pré-Claude, patterns fiables)
  if (isBounce(msg)) {
    return handleBounceMessage(msg);
  }

  // 2. Classification via Claude
  const fromAddress = msg.from?.emailAddress?.address || 'inconnu';
  const bodyText = (msg.body?.content || msg.bodyPreview || '').replace(/<[^>]+>/g, '').slice(0, 3000);

  const prompt = `Message reçu dans la boîte david@oseys.fr :

DE : ${fromAddress}
OBJET : ${msg.subject}
CORPS :
"""
${bodyText}
"""

Classe ce message. Réponds UNIQUEMENT en JSON strict, sans texte autour :
{
  "sender_type": "prospect" | "consultant" | "internal" | "spam",
  "prospect_class": "positive" | "question" | "neutre" | "negative" | "out_of_office" | "bounce" | null,
  "confidence": 0.0 à 1.0,
  "resume_humain": "1 phrase courte pour comprendre le contenu",
  "reply_draft": "corps du mail à envoyer, ou null si rien à envoyer. Respect strict de la règle d'honneur : aucun chiffre inventé, aucune promesse.",
  "reply_to": "adresse destinataire, ou null",
  "reply_subject": "objet du mail, ou null"
}

Règles :
- Si sender_type = "prospect", tu DOIS renseigner prospect_class et confidence.
- Si sender_type = "consultant" / "internal" / "spam", prospect_class = null, confidence = 1.0.
- Si tu hésites sur la classe prospect → baisse la confidence plutôt que de deviner.`;

  const { text } = await callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
    temperature: 0.3,
  });

  let decision;
  try {
    decision = parseJson(text);
  } catch (e) {
    return { classe: 'unparseable', raw: text.slice(0, 200) };
  }

  // 3. Dispatch selon sender_type
  if (decision.sender_type === 'prospect') {
    return handleProspectReply(msg, decision);
  }

  // Consultant / internal : exécute l'action si reply_draft fourni
  if (decision.reply_draft && decision.reply_to && decision.reply_subject) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject,
      html: wrapHtml(decision.reply_draft),
    });
  }
  return { classe: decision.sender_type, ...decision };
}

// ─── Réponses prospects — 6 classes + escalation ───────────────────────────
async function handleProspectReply(msg, decision) {
  const fromAddress = (msg.from?.emailAddress?.address || '').toLowerCase();
  const { prospect_class, confidence } = decision;
  const ctx = await findDealContext(fromAddress);

  // Confidence trop faible → escalation systématique
  if (!prospect_class || typeof confidence !== 'number' || confidence < CONFIDENCE_THRESHOLD) {
    await escalateToDirection({
      subject: `Réponse prospect ambiguë — ${fromAddress}`,
      contexte: `Message reçu de ${fromAddress} avec objet "${msg.subject}". Classification incertaine (class=${prospect_class}, confidence=${confidence}).`,
      extraitMessage: (msg.body?.content || msg.bodyPreview || '').replace(/<[^>]+>/g, '').slice(0, 600),
      propositions: [
        'Traiter comme positive : arrêter la séquence, répondre avec lien Bookings',
        'Traiter comme question : répondre avec clarification, laisser le deal ouvert',
        'Ignorer temporairement et attendre un 2e signal du prospect',
      ],
      recommendation: decision.resume_humain || '(pas de reco générée)',
      consultantEmail: ctx.consultantEmail,
    });
    return { classe: 'escalated', reason: 'low_confidence', prospect_class, confidence, dealId: ctx.dealId };
  }

  switch (prospect_class) {
    case 'out_of_office':
      // Rien à faire : la séquence continue au prochain jour ouvré
      return { classe: 'out_of_office', confidence, note: 'sequence continues', dealId: ctx.dealId };

    case 'bounce':
      return handleBounceAction(fromAddress, ctx);

    case 'positive':
      return handlePositive(msg, decision, ctx);

    case 'question':
      return handleQuestion(msg, decision, ctx);

    case 'neutre':
      return handleNeutre(msg, decision, ctx);

    case 'negative':
      return handleNegative(msg, decision, ctx);

    default:
      return { classe: 'unknown', prospect_class };
  }
}

async function handlePositive(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_QUALIFIED));
  }
  // Réponse au prospect (inclut idéalement le lien Bookings du consultant —
  // en MVP : le reply_draft de Claude ne contient pas encore le lien ;
  // à ajouter quand on aura l'URL Bookings par consultant dans le brief)
  if (decision.reply_draft && decision.reply_to) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'positive');
  return { classe: 'positive', confidence: decision.confidence, action: 'stopped+qualified', dealId: ctx.dealId };
}

async function handleQuestion(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_REPLIED));
  }
  if (decision.reply_draft && decision.reply_to) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      cc: ctx.consultantEmail ? [ctx.consultantEmail] : [],
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
    });
  }
  return { classe: 'question', confidence: decision.confidence, action: 'stopped+replied_cc_consultant', dealId: ctx.dealId };
}

async function handleNeutre(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_REPLIED));
  }
  if (decision.reply_draft && decision.reply_to) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'neutre');
  return { classe: 'neutre', confidence: decision.confidence, action: 'stopped+ack', dealId: ctx.dealId };
}

async function handleNegative(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.markLeadPermanentOptOut(ctx.dealId);
  }
  if (decision.reply_draft && decision.reply_to) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'negative');
  return { classe: 'negative', confidence: decision.confidence, action: 'stopped+opt_out_permanent', dealId: ctx.dealId };
}

async function handleBounceMessage(msg) {
  const targetAddress = extractBouncedAddress(msg);
  if (!targetAddress) {
    return { classe: 'bounce', action: 'detected_but_no_address_extracted' };
  }
  const ctx = await findDealContext(targetAddress);
  return handleBounceAction(targetAddress, ctx);
}

async function handleBounceAction(targetAddress, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_CLOSED_REFUSAL));
  }
  if (ctx.personId) {
    const fieldKey = process.env.PIPEDRIVE_PERSON_FIELD_EMAIL_BOUNCED_AT;
    if (fieldKey) {
      await pipedrive.updatePersonField(ctx.personId, fieldKey, new Date().toISOString().slice(0, 10));
    }
  }
  // Alerter consultant + admin
  const admin = process.env.ADMIN_EMAIL;
  const to = ctx.consultantEmail || admin;
  const cc = ctx.consultantEmail && admin && admin !== ctx.consultantEmail ? [admin] : [];
  if (to) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to,
      cc,
      subject: `[Prospérenne] Email invalide détecté — ${targetAddress}`,
      html: wrapHtml(
        `L'adresse ${targetAddress} a généré un bounce (NDR). Séquence arrêtée, deal fermé. ` +
        `Le champ email_bounced_at est posé sur le contact Pipedrive : aucune future campagne ne ciblera cette adresse.`
      ),
    });
  }
  return { classe: 'bounce', action: 'stopped+flagged_pipedrive', targetAddress, dealId: ctx.dealId, personId: ctx.personId };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function stopSequence(dealId) {
  if (!dealId) return { purged: 0 };
  return purgeByDealId(dealId);
}

/**
 * Trouve le deal Prospérenne actif pour une adresse email de prospect,
 * ainsi que l'email du consultant owner du deal. Best effort : retourne
 * des champs vides si pas trouvé.
 */
async function findDealContext(prospectEmail) {
  const ctx = { personId: null, dealId: null, consultantEmail: null };
  if (!prospectEmail) return ctx;
  try {
    const persons = await pipedrive.searchPerson(prospectEmail);
    const person = persons[0];
    if (!person) return ctx;
    ctx.personId = person.id;
    const deals = await pipedrive.findOpenDealsForPersonInOurPipe(person.id);
    if (deals.length > 0) {
      const deal = deals[0];
      ctx.dealId = deal.id;
      if (deal.user_id?.id) {
        ctx.consultantEmail = await pipedrive.getUserEmail(deal.user_id.id);
      }
    }
  } catch {
    // Best effort : on ne bloque pas la classification sur un échec Pipedrive
  }
  return ctx;
}

async function alertConsultant(consultantEmail, msg, decision, classe) {
  if (!consultantEmail) return;
  const fromAddress = msg.from?.emailAddress?.address || '';
  await sendMail({
    from: process.env.DAVID_EMAIL,
    to: consultantEmail,
    subject: `[Prospérenne] ${classe} — ${fromAddress}`,
    html: wrapHtml(
      `Réponse classée "${classe}" de ${fromAddress}.\n\n` +
      `Résumé : ${decision.resume_humain || '(pas de résumé)'}\n\n` +
      `Objet du mail original : ${msg.subject}`
    ),
  });
}

async function escalateToDirection({ subject, contexte, extraitMessage, propositions, recommendation, consultantEmail }) {
  const escalationTo = process.env.ESCALATION_EMAIL || 'direction@oseys.fr';
  const cc = consultantEmail ? [consultantEmail] : [];
  const body =
    `Contexte : ${contexte}\n\n` +
    (extraitMessage ? `Extrait du message :\n"""\n${extraitMessage}\n"""\n\n` : '') +
    `Propositions d'action :\n` +
    propositions.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\n\nRecommandation David : ${recommendation}\n\n` +
    `Attente : validation humaine avant toute action.`;
  await sendMail({
    from: process.env.DAVID_EMAIL,
    to: escalationTo,
    cc,
    subject: `[ESCALATION] ${subject}`,
    html: wrapHtml(body),
  });
}

function wrapHtml(text) {
  const paragraphs = text
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1714">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Arial,sans-serif;color:#1a1714">${paragraphs}${davidSignatureHtml()}</div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// ─── Lancement d'une séquence pour un consultant ──────────────────────────
/**
 * David décide, pour chaque lead d'un batch, quel agent le prospecte.
 * Si le consultant a choisi "both", on alterne Martin/Mila pour faire de
 * l'A/B test par secteur.
 *
 * @param {Object} brief
 * @param {string} brief.prospecteur — "martin" | "mila" | "both"
 * @param {Object} consultant — { nom, email, offre, ton, tutoiement }
 * @param {Array} leads — [{ prenom, nom, entreprise, email, secteur, ville, contexte }, ...]
 */
async function launchSequenceForConsultant({ consultant, brief, leads }) {
  const assign = (i) => {
    if (brief.prospecteur === 'martin') return 'martin';
    if (brief.prospecteur === 'mila') return 'mila';
    return i % 2 === 0 ? 'martin' : 'mila';
  };

  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const agentKey = assign(i);
    const agent = agentKey === 'martin' ? martin : mila;

    try {
      const org = await ensureOrg(lead);
      const person = await ensurePerson(lead, org.id);
      const deal = await pipedrive.createDeal({
        title: `${consultant.nom} → ${lead.entreprise}`,
        personId: person.id,
        orgId: org.id,
        agent: agentKey,
      });

      const result = await agent.bootstrapSequence({
        consultant,
        lead,
        dealId: deal.id,
        personId: person.id,
        orgId: org.id,
      });
      results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, ...result });
    } catch (err) {
      results.push({ lead: lead.email, agent: agentKey, error: err.message });
    }
  }
  return results;
}

async function ensureOrg(lead) {
  const found = await pipedrive.searchOrganization(lead.entreprise);
  if (found.length) return found[0];
  return pipedrive.createOrganization({
    name: lead.entreprise,
    address: lead.ville,
  });
}

async function ensurePerson(lead, orgId) {
  if (lead.email) {
    const found = await pipedrive.searchPerson(lead.email);
    if (found.length) return found[0];
  }
  return pipedrive.createPerson({
    name: `${lead.prenom} ${lead.nom || ''}`.trim(),
    email: lead.email,
    orgId,
  });
}

module.exports = {
  handleInboxPoll,
  launchSequenceForConsultant,
  routeMessage,
  escalateToDirection,
  stopSequence,
};
