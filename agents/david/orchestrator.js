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
const { getMem0 } = require('../../shared/adapters/memory/mem0');

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
async function handleInboxPoll({ context } = {}) {
  const mailbox = process.env.DAVID_EMAIL;
  const unread = await listUnreadMessages({ mailbox, top: 20 });

  const results = [];
  for (const msg of unread) {
    try {
      const decision = await routeMessage(msg, { context });
      results.push({ id: msg.id, subject: msg.subject, ...decision });
      await markAsRead({ mailbox, messageId: msg.id });
    } catch (err) {
      results.push({ id: msg.id, error: err.message });
    }
  }
  return results;
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
    return handleProspectReply(msg, decision, { context });
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
  const ctx = { personId: null, dealId: null, orgId: null, consultantEmail: null };
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
async function launchSequenceForConsultant({ consultant, brief, leads, context }) {
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

      // Item 3 — Cooldown / opt-out : lecture des deals fermés pour vérifier
      // si ce prospect est sous opt-out permanent ou en cooldown 180j.
      const cooldown = await checkLeadCooldown(person.id, { context });
      if (cooldown.skip) {
        results.push({
          lead: lead.email,
          agent: agentKey,
          skipped: true,
          reason: cooldown.reason,
          until: cooldown.until,
        });
        continue;
      }

      // Item 1 — Dédup intra-pipe : si un deal ouvert existe déjà pour cette
      // personne dans le pipeline Prospérenne, on le réutilise plutôt que
      // d'en créer un second. On ne relance PAS bootstrapSequence (qui
      // générerait une nouvelle séquence = doublon d'envoi).
      const { deal, reused } = await resolveOrCreateDeal({
        consultant, lead, agentKey, person, org, context,
      });
      if (reused) {
        results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, reused: true });
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
      results.push({ lead: lead.email, agent: agentKey, dealId: deal.id, ...result });
    } catch (err) {
      results.push({ lead: lead.email, agent: agentKey, error: err.message });
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
 */
async function resolveOrCreateDeal({ consultant, lead, agentKey, person, org, context, pipedriveMod = pipedrive }) {
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
};
