/**
 * Worker partagé entre Martin et Mila.
 *
 * Rôle : envoyer un step d'une séquence (J0, J+14, J+28) pour un lead donné,
 * au nom d'un consultant, depuis la boîte de l'agent (martin@ ou mila@).
 *
 * Le worker n'est jamais appelé directement par un humain — il est déclenché :
 *   - par la function `runSequence` pour le J0 (bootstrap)
 *   - par la function `scheduler` pour les J+14/J+28 (consommation de queue)
 */

const path = require('path');
const fs = require('fs');
const { sendMail } = require('./graph-mail');
const { generateSequence, SCHEDULE } = require('./sequence');
const { scheduleRelance } = require('./queue');
const { nextBusinessDayAt, addBusinessDays } = require('./holidays');
const pipedrive = require('./pipedrive');
const { getMem0 } = require('./adapters/memory/mem0');
const { isLeadStillSendable } = require('./optOutGuard');
const { isPipelineKilled } = require('./pipelineControl');

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

// ─── Rendu du corps HTML avec signature + pixel + footer RGPD ─────────────
function renderEmailHtml({ identity, consultant, corps, dealId, personId, day }) {
  const avatarBase = process.env.FUNCTION_APP_URL || 'http://localhost:7071';
  const signatureHtml = identity.signature_html
    .replace(/\{\{avatar_url\}\}/g, `${avatarBase}/api/avatarProxy?user=${identity.avatar_user}`)
    .replace(/\{\{consultant_nom\}\}/g, consultant.nom);

  const bodyHtml = corps
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;color:#1a1714;font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:12pt">${linkify(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`)
    .join('');

  const pixel = buildTrackingPixel({ identity, dealId, personId, day });
  const footer = renderLegalFooter({ identity });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:12pt;color:#1a1714">
${bodyHtml}
${signatureHtml}
${footer}
${pixel}
</body></html>`;
}

// ─── Footer RGPD : mentions légales + lien désinscription ─────────────────
// Plan v3.1 Pilier 5 — conformité B2B prospection :
//   - Article 13 RGPD : identité responsable traitement + finalité + contact
//   - List-Unsubscribe (header SMTP) + lien visible dans le corps
//   - Désinscription via mailto vers l'expéditeur (martin@/mila@) avec
//     subject "Désinscription" : davidInbox classifie comme négatif et
//     pose opt_out_until=9999-12-31 (architecture existante).
//
// Cohérent doctrine "consultants OSEYS = clients" (positionnement service
// Prospérenne) : on ne complique pas avec endpoint web dédié pour H1.
function renderLegalFooter({ identity }) {
  const unsubscribeSubject = 'Désinscription';
  const mailto = `mailto:${identity.email}?subject=${encodeURIComponent(unsubscribeSubject)}`;
  return `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e6e1da;font-family:Aptos,'Aptos Display',Calibri,Arial,sans-serif;font-size:10pt;color:#7a7066;line-height:1.5">
<p style="margin:0 0 6px">Vous recevez ce message car votre profil de dirigeant correspond au périmètre d'accompagnement d'OSEYS (réseau de consultants indépendants en pilotage économique TPE/PME). Responsable de traitement : OSEYS / Groupe Pérenne — paul.rudler@oseys.fr.</p>
<p style="margin:0">Pour ne plus recevoir de messages : <a href="${mailto}" style="color:#7a7066;text-decoration:underline">cliquez ici pour vous désinscrire</a>. Désinscription effective sous 72h.</p>
</div>`;
}

// ─── Headers SMTP List-Unsubscribe (RFC 2369) ─────────────────────────────
// Génère les 2 headers conformes :
//   - List-Unsubscribe : <mailto:agent@oseys.fr?subject=Désinscription>
//     Format RFC 2369 — pris en compte par tous les clients mail majeurs
//     (Gmail "Unsubscribe" automatique, Outlook bouton désabonner).
//
// One-Click RFC 8058 NON ajouté en H1 — nécessite endpoint web qui ack le
// désabonnement par POST sans interaction. À livrer H2 avec endpoint dédié.
function buildUnsubscribeHeaders(identity) {
  const mailto = `mailto:${identity.email}?subject=${encodeURIComponent('Désinscription')}`;
  return [
    { name: 'List-Unsubscribe', value: `<${mailto}>` },
  ];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Auto-linkify pour rendre les URLs cliquables dans le corps des messages
// LLM. Cible prioritaire : oseys.fr et ses sous-pages — URL conservée
// dans le href, mais texte affiché toujours "oseys.fr" court (cohérent
// avec la signature, cf. décision Paul 1er mai 2026 PM).
function linkify(s) {
  return String(s || '')
    // oseys.fr/dirigeant ou autre sous-page → texte court "oseys.fr", URL complète dans href
    .replace(/\b(oseys\.fr(?:\/[\w\-/]+)?)\b/g, '<a href="https://$1" style="color:#F39561;text-decoration:underline;font-weight:500">oseys.fr</a>')
    // autres URLs https:// (fallback générique)
    .replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#F39561;text-decoration:underline">$1</a>');
}

// ─── Mem0 enrichments (pur, testable en isolation) ─────────────────────────
//
// Diagnostic 12 mai 2026 PM (Paul) — fuite quota Mem0 cloud SaaS :
//   6999/5000 SEARCH events consommés sur le mois (quota dépassé HTTP 429).
//   Cause principale : `resolveMem0Enrichments` est appelée par `bootstrapSequence`
//   à CHAQUE envoi de séquence prospect (J0 + relances J+14 + J+28). Pour
//   chaque appel, on lance retrieveProspect(siren) ET retrievePatterns(sector)
//   en parallèle = 2 search Mem0 par lead envoyé.
//
//   Pic observé : 11 mai matin, 237 exécutions Lead Selector → estim 300-400
//   search Mem0 sur la matinée. Cumul mensuel : >6000 search.
//
//   Aggravant : en début de pilote, ces 2 calls retournent quasi-toujours
//   vide (0% des prospects ont des mémoires antérieures, peu de patterns
//   appris en 11 jours). On paie pour récupérer ~0 information utile.
//
// Fix triple :
//   1. Kill-switch global via env `WORKER_MEM0_ENRICHMENTS_ENABLED` (défaut "0",
//      désactivé). À activer ("1") seulement quand le pilote a accumulé une
//      base de mémoires exploitable (signal d'inflexion ~3 mois).
//   2. Skip retrieveProspect si pas de SIREN sur le lead (déjà en place).
//   3. Cache session-level pour retrievePatterns(sector) : 1 seul call par
//      sector par run, pas N appels × N leads d'un même secteur. Cache
//      in-process, partage entre tous les workers du même process Node.
// Lecture dynamique du flag (pas figée au require) pour faciliter le tuning
// runtime via App Settings sans redéployer le code et pour permettre aux tests
// de set/reset le flag entre cas.
function isEnrichmentsEnabled() {
  return process.env.WORKER_MEM0_ENRICHMENTS_ENABLED === '1';
}

// Cache patterns par sector — TTL 10 min (suffit pour 1 run Lead Selector + relances)
const PATTERNS_CACHE_TTL_MS = Number(process.env.PATTERNS_CACHE_TTL_MS || 10 * 60 * 1000);
const patternsCache = new Map(); // key = sector lowercase, value = { fetchedAt, memories }

function _getCachedPatterns(sector) {
  const key = String(sector || '').toLowerCase().trim();
  const entry = patternsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > PATTERNS_CACHE_TTL_MS) {
    patternsCache.delete(key);
    return null;
  }
  return entry.memories;
}

function _setCachedPatterns(sector, memories) {
  const key = String(sector || '').toLowerCase().trim();
  patternsCache.set(key, { fetchedAt: Date.now(), memories });
}

async function resolveMem0Enrichments({ mem0, lead, context }) {
  if (!mem0) return { prospectMemories: [], patternMemories: [] };

  // Kill-switch global : retourne vide sans appeler Mem0. Empêche la fuite
  // quota tant que le pilote n'a pas accumulé une base exploitable.
  if (!isEnrichmentsEnabled()) {
    return { prospectMemories: [], patternMemories: [] };
  }

  const tasks = [];

  // 1. retrieveProspect : skip si pas de SIREN (cas 99% en début de pilote)
  if (lead && lead.siren) {
    tasks.push(mem0.retrieveProspect(lead.siren));
  } else {
    warnLog(context, `[mem0] prospect retrieve skipped: no SIREN for lead ${(lead && lead.email) || '(no email)'}`);
    tasks.push(Promise.resolve([]));
  }

  // 2. retrievePatterns : cache session par sector (TTL 10 min)
  const sector = lead && lead.secteur;
  const cached = _getCachedPatterns(sector);
  if (cached) {
    tasks.push(Promise.resolve(cached));
  } else {
    tasks.push(
      mem0.retrievePatterns({ sector }).then((memories) => {
        _setCachedPatterns(sector, memories);
        return memories;
      })
    );
  }

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
//
// `prospectProfile` (optionnel) — résultat enrichissement prospect-research
// (companyProfile + decisionMakerProfile) qui permet à generateSequence de
// calculer l'angle d'entrée et la modulation DISC. Si absent, fallback
// 'pas_de_signal' + ton standard (cohérent VP OSEYS socle, cas le plus fréquent).
async function bootstrapSequence({ agent, consultant, lead, dealId, personId, orgId, context, mem0: mem0Override, prospectProfile }) {
  const identity = loadIdentity(agent);

  // Kill-switch FA rapide (plan v3.1 Pilier 1+3) : pause runtime <5s sans deploy.
  // Lue depuis table Storage `PipelineControl` PK=control RK=kill-pipeline,
  // cache TTL 5s. Si actif → skip immédiat AVANT toute génération séquence.
  if (await isPipelineKilled()) {
    return { skipped: true, reason: 'pipeline_killed' };
  }

  // 0. Filtrage leads existants — INTRA-PIPE 28 SEULEMENT (correction 12 mai PM).
  // Doctrine précédente "cross-pipes" : skip si la person a un deal ouvert dans
  // n'importe quel pipeline OSEYS. Bloquant en pratique : pollution historique
  // searchPerson fuzzy a agrégé des deals legacy sur des persons mal-matchées
  // (ex: person 53801 = 134 deals dont 120 dans pipes 10/12/22/24 qui n'ont
  // rien à voir). Le step 0 cross-pipes faux-positivait à grande échelle et
  // bloquait l'envoi de TOUS les J0. Intra-pipe 28 : check uniquement notre
  // pipeline Prospérenne — empêche les vrais doublons sans payer la dette
  // legacy. La pollution Pipedrive ancienne doit être traitée séparément.
  if (personId) {
    try {
      const existing = await pipedrive.findOpenDealsForPersonInOurPipe(personId);
      // Exclure le deal courant (créé juste avant par resolveOrCreateDeal).
      const others = existing.filter((d) => Number(d.id) !== Number(dealId));
      if (others.length > 0) {
        const reused = others[0];
        return { skipped: true, reason: 'existing_deal_in_our_pipe', matchDealId: reused.id };
      }
    } catch (err) {
      console.warn(`bootstrapSequence: findOpenDealsForPersonInOurPipe failed (${err.message}), continuing`);
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
    prospectProfile,
  });

  // 2. Détermine le slot J0 (maintenant si on est dans le créneau ouvré
  // 9h-18h Paris, sinon prochain créneau ouvré à 9h Paris)
  const now = new Date();
  const j0Slot = nextBusinessDayAt(now);
  const j0IsImmediate = j0Slot.getTime() - now.getTime() < 60_000; // < 1 min = on considère immédiat

  const results = { scheduled: [], sent: [] };

  // 3. J0 : envoi direct si dans le créneau, sinon push en queue
  const j0 = steps[0];
  const consultantBCC = getConsultantBCC(adjustedConsultant.email);
  if (j0IsImmediate) {
    // BL-52 (11 mai 2026) — Re-check opt-out serré juste avant J0 immédiat
    // (le check initial dans launchSequenceForConsultant peut être périmé
    // de quelques secondes si un opt-out a été posé entretemps par un autre
    // canal — escalation, davidInbox, etc.).
    if (personId) {
      try {
        const guard = await isLeadStillSendable({ personId });
        if (!guard.sendable) {
          return { sent: [], scheduled: [], skipped: true, reason: guard.reason };
        }
      } catch {
        // Best effort : si check fail, on tente l'envoi
      }
    }
    const html = renderEmailHtml({
      identity, consultant: adjustedConsultant, corps: j0.corps, dealId, personId, day: 'J0',
    });
    const sendResult = await sendMail({
      from: identity.email,
      to: lead.email,
      bcc: consultantBCC ? [consultantBCC] : [],
      subject: j0.objet,
      html,
      headers: buildUnsubscribeHeaders(identity),
      // Pas de replyTo explicite : les réponses prospects arrivent
      // nativement dans la boîte de l'expéditeur (martin@oseys.fr ou
      // mila@oseys.fr).
    });
    if (dealId || personId) {
      await pipedrive.logEmailSent({
        dealId, personId, sender: identity.prenom, day: 'J0',
        subject: j0.objet, bodyPreview: j0.corps.slice(0, 200),
        internetMessageId: sendResult.internetMessageId,
        conversationId: sendResult.conversationId,
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

  // 4. J+14, J+28 (séquencement validé Paul 1er mai 2026 PM, espacement
  //    plus respectueux que la cadence resserrée historique 5 touches).
  //    Tous poussés dans la queue, dates relatives à j0Slot.
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

  // Kill-switch FA rapide (plan v3.1 Pilier 1+3) : check AVANT garde-fou
  // opt-out + AVANT sendMail. Pause runtime <5s sans deploy.
  if (await isPipelineKilled()) {
    return { sent: null, skipped: true, reason: 'pipeline_killed', day: jour };
  }

  // BL-52 (11 mai 2026) — Garde-fou opt-out re-checké AVANT chaque sendMail
  // différé (J+14, J+28). Sans ce check, un prospect ayant répondu négatif
  // après le J0 (et marqué opt_out_until=9999-12-31 par davidInbox) recevrait
  // quand même les relances déjà queued. Violation règle d'honneur §4.
  if (personId) {
    try {
      const guard = await isLeadStillSendable({ personId });
      if (!guard.sendable) {
        // Skip silencieux : on ne renvoie pas le mail, on marque le step comme
        // skippé. Le scheduler delete le message queue (return success).
        return { sent: null, skipped: true, reason: guard.reason, until: guard.until, day: jour };
      }
    } catch {
      // Best effort : si check fail, on tente l'envoi (ancien comportement)
    }
  }

  const html = renderEmailHtml({
    identity, consultant, corps, dealId, personId, day: jour,
  });

  const consultantBCC = getConsultantBCC(consultant?.email);
  const sendResult = await sendMail({
    from: identity.email,
    to: lead.email,
    bcc: consultantBCC ? [consultantBCC] : [],
    subject: objet,
    html,
    headers: buildUnsubscribeHeaders(identity),
    // Pas de replyTo : cf. bootstrapSequence (positionnement éthique).
  });

  if (dealId || personId) {
    await pipedrive.logEmailSent({
      dealId, personId,
      sender: identity.prenom,
      day: jour,
      subject: objet,
      bodyPreview: corps.slice(0, 200),
      internetMessageId: sendResult.internetMessageId,
      conversationId: sendResult.conversationId,
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
  // Exposés pour tests (reset cache patterns + observation flag)
  _resetPatternsCache() { patternsCache.clear(); },
  _isEnrichmentsEnabled: isEnrichmentsEnabled,
};
