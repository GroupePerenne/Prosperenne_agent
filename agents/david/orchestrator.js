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
 * leur `replyTo` configuré sur david@perennereseau.fr : toute réponse d'un prospect
 * atterrit donc dans la boîte de David, qui décide quoi en faire.
 *
 * Classification fine des réponses prospects (6 classes — cf. CLAUDE.md §1.7
 * et prompt.md) :
 *   positive / question / neutre / negative / out_of_office / bounce
 * Si confidence < 0.7 → escalation à direction@perennereseau.fr (avec consultant en CC).
 */

const fs = require('fs');
const path = require('path');
const { listUnreadMessages, markAsRead, sendMail, forwardMessage, getConversationMessages } = require('../../shared/graph-mail');
const { detectAutoReply } = require('../../shared/autoReplyDetector');
const { decideAgent, extractActiveAgents } = require('../../shared/assignAgent');
const { callClaude, parseJson } = require('../../shared/anthropic');
const { davidSignatureHtml } = require('../../shared/templates');
const { purgeByDealId } = require('../../shared/queue');
const martin = require('../martin/worker');
const mila = require('../mila/worker');
const pipedrive = require('../../shared/pipedrive');
const { getMem0 } = require('../../shared/adapters/memory/mem0');
const { recordAction: recordDavidAction } = require('../../shared/storage-tables/davidActions');
const { tryAcquireLock, releaseLock } = require('../../shared/storage-tables/locks');
const { markProcessed } = require('../../shared/storage-tables/davidProcessedMessages');
const { enqueuePendingReply } = require('../../shared/storage-tables/davidPendingReplies');
const { computeScheduledAt, getJitterWindowForSenderType } = require('../../shared/jitter');

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
//
// Pollage multi-mailbox : depuis le chantier VP socle 1er mai 2026
// (cf. agents/david/value-proposition.md §8), les commerciaux IA Martin et
// Mila opèrent depuis leur propre adresse, replyTo = leur adresse, donc les
// réponses prospects arrivent désormais dans MARTIN_EMAIL et MILA_EMAIL.
// David reste la boîte d'orchestration pour : messages consultants directs,
// escalations, interventions hiérarchiques.
//
// Sans paramètre `mailboxes`, fallback sur DAVID_EMAIL seul (back-compat tests).
// En prod (cf. src/functions/davidInbox.js), les 3 mailboxes sont passées.
//
// Chaque message est routé via routeMessage qui décide (prospect/consultant/
// internal/spam) sans s'appuyer sur la mailbox d'origine — la classification
// se fait sur le sender, le subject et le body. La mailbox sert juste à savoir
// où poller et où marquer-comme-lu.
async function handleInboxPoll({ context, mailboxes } = {}) {
  const list = Array.isArray(mailboxes) && mailboxes.length > 0
    ? mailboxes.filter(Boolean)
    : [process.env.DAVID_EMAIL].filter(Boolean);

  const results = [];
  for (const mailbox of list) {
    let unread;
    try {
      unread = await listUnreadMessages({ mailbox, top: 20 });
    } catch (err) {
      warnLog(context, `[handleInboxPoll] listUnreadMessages failed for ${mailbox}: ${err.message}`);
      continue;
    }

    for (const msg of unread) {
      try {
        msg.mailbox = mailbox;

        // 1) Idempotence dure : un même messageId ne doit JAMAIS être traité
        // deux fois, même si markAsRead foire (cas vécu 11 mai : 12 doublons
        // à Johnny suite à un markAsRead 403 silencieux).
        const idem = await markProcessed({ messageId: msg.id, mailbox });
        if (idem.alreadyProcessed) {
          // Déjà traité — re-tente markAsRead idempotent puis skip.
          await markAsRead({ mailbox, messageId: msg.id }).catch(() => {});
          results.push({ mailbox, id: msg.id, skipped: 'already_processed' });
          continue;
        }

        // 2) Marquer isRead AVANT routage. Si ça foire (perm révoquée, panne
        // Graph), on abort sans envoyer pour ne pas risquer le doublon — la
        // table DavidProcessedMessages garde la trace pour le prochain tick.
        try {
          await markAsRead({ mailbox, messageId: msg.id });
        } catch (markErr) {
          warnLog(context, `[handleInboxPoll] markAsRead failed for ${msg.id}: ${markErr.message} — abort sans envoi`);
          results.push({ mailbox, id: msg.id, error: `markAsRead_failed: ${markErr.message}` });
          continue;
        }

        // 2 bis) Anti-boucle mail (plan v3.1 Pilier 3) : détection auto-reply
        // pré-Claude via headers SMTP standards (Auto-Submitted, X-Auto-Response-
        // Suppress, Precedence) + fallback subject patterns. Si auto-reply →
        // skip classification + enqueue. Le mail est marqué isRead, processé,
        // tracé, mais AUCUNE réponse n'est générée — coupe la boucle infinie
        // OOO/vacation responder à la source. Économie tokens Claude + protection
        // réputation Pereneo (pas de cascade mails côté prospect).
        const autoReply = detectAutoReply(msg);
        if (autoReply.isAutoReply) {
          warnLog(context, `[handleInboxPoll] auto-reply detected (${autoReply.reason}) for ${msg.id} from ${msg.from?.emailAddress?.address || '?'} subject="${msg.subject}" — skip without reply`);
          results.push({
            mailbox,
            id: msg.id,
            subject: msg.subject,
            classe: 'auto_reply_skipped',
            reason: autoReply.reason,
          });
          continue;
        }

        // 3) Route + enqueue de la réponse différée (jitter humain).
        const decision = await routeMessage(msg, { context });
        results.push({ mailbox, id: msg.id, subject: msg.subject, ...decision });
      } catch (err) {
        results.push({ mailbox, id: msg.id, error: err.message });
      }
    }
  }
  return results;
}

// ─── Compactage fil conversationnel (plan v3.1 P2 Sujet 5) ────────────────
//
// Récupère la conversation Graph via conversationId puis compacte les
// N-1 messages antérieurs (= autres que celui à classifier maintenant) en
// mini-bloc texte. Format compact : "[YYYY-MM-DD HH:MM] DE : sender →
// resume_bodyPreview". On exclut le message courant pour éviter la
// redondance (le prompt inclut déjà son CORPS complet juste après).
//
// Limites :
//   - max 5 messages antérieurs (les plus récents avant le courant)
//   - bodyPreview tronqué à 200 caractères chacun
//   - si conversationId absent ou 1 seul message → retourne '' (rien à
//     injecter, classifier sans contexte comme avant)
//
// Best effort sur l'appel Graph : tout échec est swallow et retourne ''
// pour ne JAMAIS bloquer la classification.
async function buildThreadContext(msg) {
  const conversationId = msg && msg.conversationId;
  const mailbox = msg && msg.mailbox;
  const currentMessageId = msg && msg.id;
  if (!conversationId || !mailbox) return '';

  let thread;
  try {
    thread = await getConversationMessages({ mailbox, conversationId, top: 20 });
  } catch {
    return '';
  }
  if (!Array.isArray(thread) || thread.length <= 1) return '';

  // Exclure le message courant + garder seulement les 5 plus récents avant lui
  const others = thread.filter((m) => m.id !== currentMessageId);
  const last5 = others.slice(-5);
  if (last5.length === 0) return '';

  return last5
    .map((m) => {
      const date = (m.sentDateTime || m.receivedDateTime || '').slice(0, 16).replace('T', ' ');
      const sender = m.from?.emailAddress?.address || 'inconnu';
      const preview = (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `[${date}] ${sender} → ${preview}`;
    })
    .join('\n');
}

// ─── Routage d'un message ──────────────────────────────────────────────────
async function routeMessage(msg, { context } = {}) {
  // 1. Détection bounce (pré-Claude, patterns fiables)
  if (isBounce(msg)) {
    return handleBounceMessage(msg);
  }

  // 2. Classification via Claude
  const fromAddress = msg.from?.emailAddress?.address || 'inconnu';
  const bodyText = (msg.body?.content || msg.bodyPreview || '').replace(/<[^>]+>/g, '').slice(0, 3000);

  // Plan v3.1 Pilier 2 — Sujet 5 (David lit le fil compacté avant de
  // générer). On récupère la conversation Graph via conversationId pour
  // donner du contexte à Claude. Best effort : si Graph fail ou pas de
  // conversationId, on continue sans contexte (classification dégradée
  // mais pas bloquée). Compactage : on garde les N-1 messages précédents
  // sous forme {date, sender, bodyPreview} pour économiser les tokens
  // (un fil long ne doit pas exploser le contexte Claude).
  const threadCompacted = await buildThreadContext(msg).catch(() => '');

  const prompt = `Message reçu dans la boîte david@perennereseau.fr :

DE : ${fromAddress}
OBJET : ${msg.subject}${threadCompacted ? `

CONTEXTE DU FIL (échanges antérieurs, du plus ancien au plus récent) :
${threadCompacted}` : ''}

CORPS DU MESSAGE COURANT :
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
    return handleProspectReply(msg, decision, { context });
  }

  // Consultant / internal : enqueue la réponse avec jitter humain (15-45 min
  // en heures ouvrées). Pas d'envoi instantané — voir shared/jitter.js doctrine.
  //
  // IDENTITÉ EXPÉDITEUR (fix 12 mai 2026 PM, recadrage Paul) : pour les classes
  // consultant et internal, le `from` doit TOUJOURS être David, JAMAIS la
  // boîte d'où vient le message d'origine. Incident vécu : un mail Pipedrive
  // arrivé dans mila@perennereseau.fr (boîte multi-pollée par davidInbox), classifié
  // internal, a généré un reply rédigé "Bonjour Paul, je viens de voir... David"
  // mais envoyé DEPUIS mila@perennereseau.fr → schizophrénie d'identité.
  //
  // Cette règle ne s'applique PAS aux replies prospect (handleProspectReply
  // ci-dessous) — celles-là doivent partir DEPUIS la boîte du commercial
  // (Martin ou Mila) pour conserver la cohérence du thread mail prospect.
  if (decision.reply_draft && decision.reply_to && decision.reply_subject) {
    await enqueueReplyWithJitter({
      mailbox: process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject,
      html: wrapHtml(decision.reply_draft),
      senderType: decision.sender_type,
      msg,
    });
  }
  return { classe: decision.sender_type, ...decision };
}

/**
 * Helper : enqueue une réponse différée selon la doctrine jitter humain
 * (12 mai 2026, recadrage Paul). Calcule scheduledAt via shared/jitter et
 * persiste dans la table DavidPendingReplies. Le cron davidReplyFlusher
 * (toutes les 15 min) envoie ensuite via Graph.
 *
 * @param {object} args
 * @param {string} args.mailbox          - boîte d'envoi (david@, martin@, mila@)
 * @param {string} args.to
 * @param {string} args.subject
 * @param {string} args.html
 * @param {string} args.senderType       - prospect|consultant|internal
 * @param {string} [args.prospectClass]  - positive|question|neutre|negative
 * @param {string[]} [args.cc]
 * @param {object} args.msg              - message d'origine (pour traçabilité)
 * @param {string|number} [args.dealId]
 * @param {string} [args.consultantEmail]
 */
async function enqueueReplyWithJitter({ mailbox, to, subject, html, senderType, prospectClass, cc, msg, dealId, consultantEmail }) {
  const window = getJitterWindowForSenderType(senderType);
  const scheduledAt = computeScheduledAt(new Date(), { minMs: window.minMs, maxMs: window.maxMs });
  return enqueuePendingReply({
    mailbox,
    to,
    subject,
    html,
    cc,
    scheduledAt,
    senderType,
    prospectClass,
    jitterKind: window.kind,
    originalMessageId: msg && msg.id,
    originalConversationId: msg && msg.conversationId,
    originalSubject: msg && msg.subject,
    originalSender: msg && msg.from && msg.from.emailAddress && msg.from.emailAddress.address,
    dealId,
    consultantEmail,
  });
}

// ─── Réponses prospects — 6 classes + escalation ───────────────────────────
async function handleProspectReply(msg, decision, { context } = {}) {
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

  // Persistance Mem0 (best effort, n'interrompt jamais le routage).
  // SIREN remonté via Pipedrive uniquement si Mem0 actif et classe exploitable.
  const mem0 = getMem0(context);
  if (mem0 && prospect_class !== 'bounce') {
    const siren = await resolveSirenForOrg(ctx.orgId, { context });
    await persistInboundProspect({
      mem0, siren, prospectClass: prospect_class, fromAddress, confidence, decision, context,
    });
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
  if (decision.reply_draft && decision.reply_to) {
    await enqueueReplyWithJitter({
      mailbox: msg.mailbox || process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
      senderType: 'prospect',
      prospectClass: 'positive',
      msg,
      dealId: ctx.dealId,
      consultantEmail: ctx.consultantEmail,
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'positive', { context: ctx.context });
  // Fire-and-forget feedback exhauster (Jalon 3 Bouclea de feedback qualité)
  reportLeadExhausterFeedback({ ctx, status: 'replied' }).catch(() => {});
  return { classe: 'positive', confidence: decision.confidence, action: 'stopped+qualified', dealId: ctx.dealId };
}

async function handleQuestion(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_REPLIED));
  }
  if (decision.reply_draft && decision.reply_to) {
    await enqueueReplyWithJitter({
      mailbox: msg.mailbox || process.env.DAVID_EMAIL,
      to: decision.reply_to,
      cc: ctx.consultantEmail ? [ctx.consultantEmail] : [],
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
      senderType: 'prospect',
      prospectClass: 'question',
      msg,
      dealId: ctx.dealId,
      consultantEmail: ctx.consultantEmail,
    });
  }
  reportLeadExhausterFeedback({ ctx, status: 'replied' }).catch(() => {});
  return { classe: 'question', confidence: decision.confidence, action: 'stopped+replied_cc_consultant', dealId: ctx.dealId };
}

async function handleNeutre(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.updateDealStage(ctx.dealId, Number(process.env.PIPEDRIVE_STAGE_REPLIED));
  }
  if (decision.reply_draft && decision.reply_to) {
    await enqueueReplyWithJitter({
      mailbox: msg.mailbox || process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
      senderType: 'prospect',
      prospectClass: 'neutre',
      msg,
      dealId: ctx.dealId,
      consultantEmail: ctx.consultantEmail,
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'neutre', { context: ctx.context });
  reportLeadExhausterFeedback({ ctx, status: 'replied' }).catch(() => {});
  return { classe: 'neutre', confidence: decision.confidence, action: 'stopped+ack', dealId: ctx.dealId };
}

async function handleNegative(msg, decision, ctx) {
  if (ctx.dealId) {
    await stopSequence(ctx.dealId);
    await pipedrive.markLeadPermanentOptOut(ctx.dealId);
  }
  if (decision.reply_draft && decision.reply_to) {
    await enqueueReplyWithJitter({
      mailbox: msg.mailbox || process.env.DAVID_EMAIL,
      to: decision.reply_to,
      subject: decision.reply_subject || `Re: ${msg.subject}`,
      html: wrapHtml(decision.reply_draft),
      senderType: 'prospect',
      prospectClass: 'negative',
      msg,
      dealId: ctx.dealId,
      consultantEmail: ctx.consultantEmail,
    });
  }
  await alertConsultant(ctx.consultantEmail, msg, decision, 'negative', { context: ctx.context });
  reportLeadExhausterFeedback({ ctx, status: 'replied' }).catch(() => {});
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
  // BL-52 (11 mai 2026) — Posture "service Prospérenne" : on n'inquiète pas
  // le consultant avec un bounce (coquille interne, à corriger côté pipeline).
  // L'alerte va uniquement à ADMIN_EMAIL (équipe Prospérenne — Paul / Constantin)
  // pour qu'on suive la qualité base mail en interne. Le consultant lira
  // l'info agrégée dans son digest quotidien si besoin (via davidActions).
  const admin = process.env.ADMIN_EMAIL;
  if (admin) {
    await sendMail({
      from: process.env.DAVID_EMAIL,
      to: admin,
      subject: `[Interne Prospérenne] Bounce détecté — ${targetAddress}`,
      html: wrapHtml(
        `L'adresse ${targetAddress} a généré un bounce (NDR). Séquence arrêtée, deal fermé. ` +
        `email_bounced_at posé sur le contact Pipedrive : aucune future campagne ne ciblera cette adresse. ` +
        `\n\nConsultant concerné : ${ctx.consultantEmail || 'non identifié'} (pas notifié — coquille interne).`
      ),
    });
  }

  // Trace davidActions pour le digest quotidien du consultant si on a son email.
  if (ctx.consultantEmail) {
    await recordDavidAction({
      consultantEmail: ctx.consultantEmail,
      type: 'bounce_received',
      summary: `Bounce sur ${targetAddress} — adresse retirée du pipeline`,
      metadata: { targetAddress, dealId: ctx.dealId, personId: ctx.personId },
      at: new Date().toISOString(),
    }).catch(() => null);
  }

  // Fire-and-forget : alimente LeadContacts.feedbackStatus='bounced' pour
  // que patterns-learner dégrade le pattern responsable au prochain batch.
  reportLeadExhausterFeedback({ ctx, status: 'bounced' }).catch(() => {});
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
  const ctx = {
    personId: null, dealId: null, orgId: null, consultantEmail: null,
    personFirstName: '', personLastName: '',
  };
  if (!prospectEmail) return ctx;
  try {
    const persons = await pipedrive.searchPerson(prospectEmail);
    const person = persons[0];
    if (!person) return ctx;
    ctx.personId = person.id;
    // Parse person.name ("Jean Dupont") en firstName + lastName pour
    // permettre le lookup LeadContacts par (siren, firstName, lastName).
    const parsed = splitPersonName(person.name);
    ctx.personFirstName = parsed.firstName;
    ctx.personLastName = parsed.lastName;
    const deals = await pipedrive.findOpenDealsForPersonInOurPipe(person.id);
    if (deals.length > 0) {
      const deal = deals[0];
      ctx.dealId = deal.id;
      ctx.orgId = deal.org_id?.value || null;
      if (deal.user_id?.id) {
        ctx.consultantEmail = await pipedrive.getUserEmail(deal.user_id.id);
      }
    }
  } catch {
    // Best effort : on ne bloque pas la classification sur un échec Pipedrive
  }
  return ctx;
}

function splitPersonName(name) {
  if (!name || typeof name !== 'string') return { firstName: '', lastName: '' };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Signale au module lead-exhauster le feedback d'un mail envoyé ou reçu.
 * Fire-and-forget : aucune exception n'est propagée, aucun await bloquant
 * côté caller. Alimente la boucle d'apprentissage `patterns-learner`
 * (Jalon 4) via `LeadContacts.feedbackStatus`.
 *
 * Hook ajouté au Jalon 3 (SPEC §7 "Boucle de feedback qualité"). Appelé
 * depuis les handlers de routage prospect (bounce, positive, negative,
 * question, neutre) et depuis `shared/worker.js` au moment des sendMail
 * (delivered).
 *
 * @param {Object} params
 * @param {Object} params.ctx        Context enrichi par findDealContext
 * @param {string} params.status     'delivered'|'bounced'|'replied'|'spam_flagged'
 * @param {Object} [params.context]  Azure Functions context pour logs
 */
async function reportLeadExhausterFeedback({ ctx, status, context }) {
  if (!ctx || !status) return;
  try {
    const { leadExhauster } = require('../../shared/lead-exhauster');
    const siren = await resolveSirenForOrg(ctx.orgId, { context });
    if (!siren) return;
    await leadExhauster.reportFeedback({
      siren,
      firstName: ctx.personFirstName || '',
      lastName: ctx.personLastName || '',
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    warnLog(context, `[exhauster] reportFeedback failed: ${err && err.message}`);
  }
}

/**
 * Trace une réponse prospect classifiée pour le digest quotidien du consultant.
 *
 * BL-52 (11 mai 2026) — Posture "service Prospérenne" (recadrage Paul) :
 *   Les consultants Pérenne (Morgane, Johnny, futurs autres) sont des CLIENTS
 *   du service David/Martin/Mila, pas des opérateurs techniques. On ne les
 *   inquiète pas avec chaque coquille ou classification du pipeline.
 *
 *   Incident matin 11 mai : 3 jours de davidInbox accumulé flush à la
 *   réactivation → spam classifications (1 mail par réponse). Au-delà du
 *   bug threading, la racine est la *posture* : on traitait les consultants
 *   comme des admins du pipeline alors qu'ils paient pour ne PAS avoir à
 *   se soucier des coquilles.
 *
 *   Nouveau comportement : trace TOUJOURS en davidActions Storage Table
 *   pour le digest quotidien (dailyReport 8h L-V). N'envoie JAMAIS de mail
 *   instantané — peu importe la classe (positive, negative, neutre, OOO,
 *   bounce). Le consultant reçoit 1 mail/jour, propre, agrégé.
 *
 *   Les leads chauds (positives) restent visibles via :
 *     - le digest quotidien (résumé + lien deal Pipedrive)
 *     - le stage Pipedrive "Qualifié" mis à jour par handlePositive
 *     - le smart BCC qui copie le consultant sur les échanges du commercial
 *
 *   Cas exceptionnel (lead extraordinaire, urgence métier) → Paul/COMEX
 *   tranchent une intervention manuelle, pas le pipeline en auto.
 *
 *   La signature conserve (consultantEmail, msg, decision, classe, opts) pour
 *   compat call sites existants. `opts` est ignoré (plus de logique fallback).
 */
async function alertConsultant(consultantEmail, msg, decision, classe, _opts = {}) {
  if (!consultantEmail) return;
  const fromAddress = msg.from?.emailAddress?.address || '';

  // Trace pour digest quotidien (dailyReport L-V 8h). Pas de mail instantané.
  await recordDavidAction({
    consultantEmail,
    type: classe === 'bounce' ? 'bounce_received' : 'reply_classified',
    summary: `Réponse "${classe}" de ${fromAddress}${msg.subject ? ` — ${msg.subject}` : ''}`,
    metadata: {
      classe,
      from: fromAddress,
      subject: msg.subject || '',
      confidence: decision.confidence,
      resume: decision.resume_humain || '',
    },
    at: new Date().toISOString(),
  }).catch(() => null);
}

async function escalateToDirection({ subject, contexte, extraitMessage, propositions, recommendation, consultantEmail }) {
  const escalationTo = process.env.ESCALATION_EMAIL || 'direction@perennereseau.fr';
  // BL-52 (11 mai 2026) — Posture "service Prospérenne" : on n'inquiète pas
  // le consultant avec une escalation interne (cas confidence <0.7 nécessitant
  // avis humain). L'escalation part uniquement à direction@perennereseau.fr (Paul/
  // Constantin) qui décident s'il faut prévenir le consultant manuellement.
  // L'info reste tracée en davidActions pour le digest quotidien si pertinent.
  const body =
    `Contexte : ${contexte}\n\n` +
    (extraitMessage ? `Extrait du message :\n"""\n${extraitMessage}\n"""\n\n` : '') +
    `Propositions d'action :\n` +
    propositions.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    `\n\nRecommandation David : ${recommendation}\n\n` +
    `Consultant concerné : ${consultantEmail || 'non identifié'} (pas notifié — escalation interne).\n` +
    `Attente : validation humaine avant toute action.`;
  await sendMail({
    from: process.env.DAVID_EMAIL,
    to: escalationTo,
    subject: `[ESCALATION] ${subject}`,
    html: wrapHtml(body),
  });

  // Best-effort tracking PWA-M Cycle 1 — couvre BL-41 (escalations jamais
  // trackées en table dédiée jusqu'au 4 mai 2026).
  if (consultantEmail) {
    await recordDavidAction({
      consultantEmail,
      type: 'escalation_sent',
      summary: `Escalation à direction@ — ${subject}`,
      metadata: {
        subject,
        contexte,
        propositions,
        recommendation,
      },
      at: new Date().toISOString(),
    }).catch(() => null);
  }
}

function wrapHtml(text) {
  const paragraphs = text
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1714;font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:12pt">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:12pt;color:#1a1714">${paragraphs}${davidSignatureHtml()}</div>`;
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
async function launchSequenceForConsultant({ consultant, brief, leads, context }) {
  // Candidate initial selon brief consultant (martin/mila/both alternance).
  // La décision finale passe ensuite par decideAgent (doctrine cross-sell).
  const pickCandidate = (i) => {
    if (brief.prospecteur === 'martin') return 'martin';
    if (brief.prospecteur === 'mila') return 'mila';
    return i % 2 === 0 ? 'martin' : 'mila';
  };

  const results = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const candidateAgent = pickCandidate(i);

    try {
      const org = await ensureOrg(lead);
      const person = await ensurePerson(lead, org.id);

      // Item 3 — Cooldown / opt-out : lecture des deals fermés pour vérifier
      // si ce prospect est sous opt-out permanent ou en cooldown 180j.
      const cooldown = await checkLeadCooldown(person.id, { context });
      if (cooldown.skip) {
        results.push({
          lead: lead.email,
          agent: candidateAgent,
          skipped: true,
          reason: cooldown.reason,
          until: cooldown.until,
        });
        continue;
      }

      // Plan v3.1 Pilier 6 — doctrine cross-sell prospecteur unique :
      //   - Martin actif (Pérenne legacy ou Prospérenne) → on assigne Mila
      //   - Mila actif → on assigne Martin
      //   - Les 2 actifs → SKIP (prospect saturé)
      //   - Aucun actif → candidateAgent
      // Lecture cross-pipes pour voir TOUS les deals ouverts du prospect
      // (legacy Pérenne inclus), pas que Prospérenne.
      const openDealsAllPipes = await pipedrive.findExistingDealsAcrossAllPipes({ personId: person.id, orgId: org.id }).catch(() => []);
      const activeAgents = extractActiveAgents(openDealsAllPipes);
      const decision = decideAgent({ candidateAgent, activeAgents });
      if (decision.skip) {
        results.push({
          lead: lead.email,
          agent: candidateAgent,
          skipped: true,
          reason: decision.reason,
          activeAgents,
        });
        continue;
      }
      const agentKey = decision.agent;
      const agent = agentKey === 'martin' ? martin : mila;

      // Item 1 — Dédup intra-pipe : si un deal ouvert existe déjà pour cette
      // personne dans le pipeline Prospérenne, on le réutilise plutôt que
      // d'en créer un second. On ne relance PAS bootstrapSequence (qui
      // générerait une nouvelle séquence = doublon d'envoi).
      const { deal, reused } = await resolveOrCreateDeal({
        consultant, lead, agentKey, person, org, context,
      });
      if (reused) {
        results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, reused: true, crossSellDecision: decision.reason });
        continue;
      }

      const result = await agent.bootstrapSequence({
        consultant,
        lead,
        dealId: deal.id,
        personId: person.id,
        orgId: org.id,
        context,
      });
      results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, ...result, crossSellDecision: decision.reason });
    } catch (err) {
      results.push({ lead: lead.email, agent: candidateAgent, error: err.message });
    }
  }
  return results;
}

function pickMostRecent(deals) {
  return deals.slice().sort((a, b) => {
    const ta = a.update_time || a.add_time || '';
    const tb = b.update_time || b.add_time || '';
    return tb.localeCompare(ta);
  })[0];
}

/**
 * Item 1 — Dédup intra-pipe : réutilise un deal ouvert existant pour ce
 * prospect dans le pipe Prospérenne, sinon en crée un nouveau. pipedriveMod
 * injectable pour tests.
 *
 * BL-52 (11 mai 2026) — Hardening anti-race TOCTOU :
 *   Le check findOpenDealsForPersonInOurPipe + createDeal n'est pas atomique
 *   côté Pipedrive (latence indexation 200-500ms). Sans protection, deux
 *   handlers concurrents voient "0 deals" et créent chacun un deal pour la
 *   même personne. Incident 11 mai : 20 deals créés pour 7 prospects uniques.
 *
 * Fix : on enveloppe la séquence read-then-write dans un mutex distribué
 * Storage Table sur personId. Le détenteur du lock re-checke findOpenDeals
 * (le concurrent qui a peut-être déjà créé le deal apparaît maintenant),
 * puis crée si vraiment absent. Lock release garantie via try/finally.
 *
 * En mode dégradé (storage indisponible), le lock n'est pas acquis mais on
 * continue avec l'ancien comportement vulnérable — préférable à un blocage
 * du pipeline. Un warn log signale la dégradation.
 */
async function resolveOrCreateDeal({ consultant, lead, agentKey, person, org, context, pipedriveMod = pipedrive }) {
  const holder = `runSequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const lock = await tryAcquireLock({
    namespace: 'person',
    key: String(person.id),
    holder,
    waitMs: 800, // 1 retry après 800ms si concurrent détient
  });

  if (!lock.acquired) {
    // Un concurrent traite déjà cette personne. On ne crée PAS un nouveau deal.
    // À la place, on attend brièvement que l'autre handler ait fini puis on
    // récupère son résultat via findOpenDeals (le deal créé par le concurrent
    // sera maintenant visible côté Pipedrive).
    warnLog(context, `[dedup] lock held by ${lock.heldBy || 'unknown'} for person ${person.id} (${lock.reason}) — waiting for concurrent handler`);
    await new Promise((r) => setTimeout(r, 2000));
    const existing = await pipedriveMod.findOpenDealsForPersonInOurPipe(person.id);
    if (existing && existing.length > 0) {
      const reused = pickMostRecent(existing);
      infoLog(context, `[dedup] concurrent handler created deal ${reused.id} for person ${person.id} — reusing`);
      return { deal: reused, reused: true };
    }
    // Cas dégradé : concurrent tenait le lock mais n'a pas fini de créer.
    // On accepte de créer le deal nous-mêmes (audit trace dans logs).
    warnLog(context, `[dedup] lock waited but no deal visible for person ${person.id} — creating defensively`);
  }

  try {
    // Re-check sous lock (atomique avec createDeal qui suit)
    const existing = await pipedriveMod.findOpenDealsForPersonInOurPipe(person.id);
    if (existing && existing.length > 0) {
      if (existing.length > 1) {
        warnLog(context, `[dedup] ${existing.length} open deals for person ${person.id} — taking most recent`);
      }
      const reused = pickMostRecent(existing);
      infoLog(context, `[dedup] skipping createDeal: existing open deal ${reused.id} for person ${person.id}`);
      return { deal: reused, reused: true };
    }
    const deal = await pipedriveMod.createDeal({
      title: `${consultant.nom} → ${lead.entreprise}`,
      personId: person.id,
      orgId: org.id,
      agent: agentKey,
    });
    return { deal, reused: false };
  } finally {
    if (lock.acquired && lock.lockKey) {
      await releaseLock(lock.lockKey);
    }
  }
}

async function ensureOrg(lead, { pipedriveMod = pipedrive } = {}) {
  // Search par SIREN d'abord (immuable, fiable). Évite faux matches noms
  // approchants côté Pipedrive et garantit que le custom field SIREN sera
  // posé à la création si nécessaire (cf. dedup amont LeadSelector).
  const sirenKey = pipedriveMod.ORG_SIREN_FIELD_KEY;
  if (lead.siren) {
    const foundBySiren = await pipedriveMod.searchOrganization({ siren: lead.siren });
    if (foundBySiren.length) {
      const org = foundBySiren[0];
      if (org && org.id && sirenKey && !org[sirenKey]) {
        try { await pipedriveMod.updateOrganizationSiren(org.id, lead.siren); } catch (_) {}
      }
      return org;
    }
  }
  const found = await pipedriveMod.searchOrganization(lead.entreprise);
  if (found.length) {
    const org = found[0];
    // Backfill SIREN sur match nom si dispo côté lead et absent côté org.
    if (lead.siren && org && org.id && sirenKey && !org[sirenKey]) {
      try { await pipedriveMod.updateOrganizationSiren(org.id, lead.siren); } catch (_) {}
    }
    return org;
  }
  return pipedriveMod.createOrganization({
    name: lead.entreprise,
    address: lead.ville,
    siren: lead.siren,
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

// ─── Mem0 — persistance signaux entrants prospects ──────────────────────────

/**
 * Écrit dans Mem0 la trace d'une réponse prospect classifiée. Best effort :
 * toute erreur est swallowée (l'adapter dégrade déjà en null sur 429/timeout/5xx).
 *
 * Skip explicite :
 *  - prospectClass === 'bounce' : rebond technique, adresse typiquement
 *    invalide → SIREN associé potentiellement faux, pas de signal exploitable.
 *  - siren absent : cohérent avec D2 (pas d'email-as-fallback). Warn log émis.
 */
async function persistInboundProspect({
  mem0, siren, prospectClass, fromAddress, confidence, decision, context,
}) {
  if (!mem0) return { stored: false, reason: 'mem0_off' };
  if (prospectClass === 'bounce') return { stored: false, reason: 'bounce_skipped' };
  if (!siren) {
    warnLog(context, `[mem0] prospect store skipped: no SIREN for inbound ${fromAddress || '(no from)'}`);
    return { stored: false, reason: 'no_siren' };
  }

  const summary = (decision && (decision.resume_humain || decision.summary)) || '';
  const memory = {
    company_name: null,
    interaction_history: [{
      date: new Date().toISOString().slice(0, 10),
      type: 'email_received',
      class: prospectClass,
      confidence,
      summary,
    }],
  };

  const res = await mem0.storeProspect(siren, memory);
  return { stored: res !== null, siren };
}

/**
 * Remonte un SIREN depuis une org Pipedrive via le custom field configuré
 * (env PIPEDRIVE_ORG_FIELD_SIREN). Retourne null si :
 *   - orgId absent
 *   - env var non configurée
 *   - le field est vide sur l'org
 *   - Pipedrive échoue (log warn, best effort)
 *
 * pipedriveMod est exposé pour injection en tests.
 */
async function resolveSirenForOrg(orgId, { context, pipedriveMod = pipedrive } = {}) {
  if (!orgId) return null;
  const fieldKey = process.env.PIPEDRIVE_ORG_FIELD_SIREN;
  if (!fieldKey) return null;
  try {
    const org = await pipedriveMod.getOrganization(orgId);
    const val = org && org[fieldKey];
    return val ? String(val) : null;
  } catch (err) {
    warnLog(context, `[mem0] siren lookup failed for org ${orgId}: ${err.message}`);
    return null;
  }
}

function warnLog(context, message) {
  if (!context) return;
  if (typeof context.warn === 'function') context.warn(message);
  else if (typeof context.log === 'function') context.log(message);
}

function infoLog(context, message) {
  if (!context) return;
  if (typeof context.info === 'function') context.info(message);
  else if (typeof context.log === 'function') context.log(message);
}

// ─── Item 3 — Cooldown / opt-out ────────────────────────────────────────────
/**
 * Lit les deals (ouverts ET fermés) du prospect dans le pipe Prospérenne
 * pour vérifier s'il est sous opt-out permanent ou en cooldown 180j.
 *
 * Règles :
 *   - opt_out_until > today sur N'IMPORTE QUEL deal → skip permanent
 *     (prioritaire sur cooldown, d'où le scan de tous les deals).
 *   - retry_available_after > today sur le deal le plus récent → cooldown.
 *   - Env vars PIPEDRIVE_FIELD_OPT_OUT_UNTIL / PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER
 *     non configurées → pas de skip (feature off).
 *
 * Retourne { skip: false } ou { skip: true, reason, until, lastAgent? }.
 */
async function checkLeadCooldown(personId, { context, pipedriveMod = pipedrive } = {}) {
  if (!personId) return { skip: false };
  const optOutKey = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  const retryKey = process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  const lastAgentKey = process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED;
  if (!optOutKey && !retryKey) return { skip: false };

  let deals;
  try {
    deals = await pipedriveMod.findOpenDealsForPersonInOurPipe(personId, { includeClosed: true });
  } catch (err) {
    warnLog(context, `[dedup] cooldown check failed for person ${personId}: ${err.message}`);
    return { skip: false };
  }
  if (!deals || deals.length === 0) return { skip: false };

  const todayISO = new Date().toISOString().slice(0, 10);

  // 1. Opt-out permanent : scan de tous les deals — l'opt-out est "sticky"
  //    même s'il n'est porté que par un ancien deal.
  if (optOutKey) {
    for (const deal of deals) {
      const v = deal[optOutKey];
      if (!v) continue;
      const optOutUntil = String(v).slice(0, 10);
      if (optOutUntil > todayISO) {
        infoLog(context, `[dedup] skipping permanent opt-out: person ${personId} until ${optOutUntil}`);
        return { skip: true, reason: 'opt_out', until: optOutUntil };
      }
    }
  }

  // 2. Cooldown : lecture sur le deal le plus récent uniquement.
  const mostRecent = pickMostRecent(deals);
  if (retryKey && mostRecent && mostRecent[retryKey]) {
    const retryUntil = String(mostRecent[retryKey]).slice(0, 10);
    if (retryUntil > todayISO) {
      const lastAgent = (lastAgentKey && mostRecent[lastAgentKey]) || 'unknown';
      infoLog(context, `[dedup] skipping cooldown: person ${personId} until ${retryUntil}, last_agent=${lastAgent}`);
      return { skip: true, reason: 'cooldown', until: retryUntil, lastAgent };
    }
  }

  return { skip: false };
}

module.exports = {
  handleInboxPoll,
  launchSequenceForConsultant,
  routeMessage,
  handleProspectReply,
  escalateToDirection,
  stopSequence,
  // Exportés pour tests unitaires :
  persistInboundProspect,
  resolveSirenForOrg,
  findDealContext,
  checkLeadCooldown,
  pickMostRecent,
  resolveOrCreateDeal,
  reportLeadExhausterFeedback,
  splitPersonName,
  ensureOrg,
};
