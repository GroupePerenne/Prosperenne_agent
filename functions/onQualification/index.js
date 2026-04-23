/**
 * POST /api/onQualification
 *
 * Endpoint appelé directement par le formulaire HTML quand le consultant clique
 * "Envoyer à David". On :
 *   1. Notifie David par mail avec un récap structuré
 *   2. Envoie un accusé au consultant
 *   3. Retourne 200 + { ok: true, brief_id } au formulaire
 *
 * Auth anonyme côté Azure (le formulaire est public), mais on pourrait
 * ajouter un hCaptcha ou un throttle IP en V2 si du spam apparaît.
 */

const { app } = require('@azure/functions');
const { sendMail: defaultSendMail } = require('../../shared/graph-mail');
const { getMem0: defaultGetMem0 } = require('../../shared/adapters/memory/mem0');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Construit le schéma de mémoire consultant à partir du brief reçu du
 * formulaire public. Mapping conforme ARCHITECTURE §3.1 type 2.
 *
 * Enrichi (chantier Lead Selector v1.0) avec les champs de ciblage
 * (secteurs_autres, effectif, zone, zone_rayon, adresse, prospecteur, ville,
 * email) pour permettre à selectLeadsForConsultantById de relire le brief
 * depuis Mem0 et déclencher le Lead Selector hors contexte HTTP.
 */
function buildConsultantMemory(brief) {
  return {
    display_name: brief.nom,
    preferred_tone: brief.registre,
    tutoiement: brief.vouvoiement === 'tu',
    favorite_sectors: brief.secteurs
      ? brief.secteurs.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : [],
    commercial_strategy: brief.offre,
    usable_anecdotes: brief.exemple_client ? [brief.exemple_client] : [],
    autonomy_level: brief.niveau_autonomie || 'autonome',
    secteurs_autres: brief.secteurs_autres || '',
    effectif: brief.effectif || '',
    zone: brief.zone || 'default',
    zone_rayon: brief.zone_rayon ? Number(brief.zone_rayon) : null,
    adresse: brief.adresse || '',
    ville: brief.ville || '',
    prospecteur: brief.prospecteur || 'both',
    email: brief.email ? brief.email.toLowerCase() : '',
  };
}

/**
 * Handler extractible pour les tests. Trois dépendances externes
 * (sendMail, getMem0, triggerLeadSelector) sont injectables via `deps` —
 * en prod on utilise les implémentations par défaut.
 */
async function handleQualification(request, context, deps = {}) {
  const sendMail = deps.sendMail || defaultSendMail;
  const getMem0 = deps.getMem0 || defaultGetMem0;
  const triggerLeadSelector = deps.triggerLeadSelector || defaultTriggerLeadSelector;

  if (request.method === 'OPTIONS') {
    return { status: 204, headers: CORS_HEADERS };
  }

  try {
    const brief = await request.json().catch(() => ({}));
    const required = ['nom', 'email', 'offre'];
    const missing = required.filter((f) => !brief[f]);
    if (missing.length) {
      return {
        status: 400,
        headers: CORS_HEADERS,
        jsonBody: { error: `Champs manquants : ${missing.join(', ')}` },
      };
    }

    const briefId = `brief_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // TODO(Tranche 8): remplacer par slug interne stable (ex: oseys-morgane-dupont).
    // Voir ARCHITECTURE §3.1 type 2.
    const consultantId = brief.email.toLowerCase();
    const consultantMemory = buildConsultantMemory(brief);
    const mem0 = getMem0(context);

    // Parallélisation : les 2 mails + le store Mem0 en best effort. Toute
    // erreur Mem0 non déjà dégradée par l'adapter est swallowée ici — pas
    // question qu'un hoquet Mem0 fasse 500 sur le brief consultant.
    const mem0Task = mem0
      ? mem0.storeConsultant(consultantId, consultantMemory).catch((err) => {
          if (context && typeof context.warn === 'function') {
            context.warn(`[mem0] storeConsultant failed: ${err.message}`);
          }
          return null;
        })
      : Promise.resolve(null);

    await Promise.all([
      sendMail({
        from: process.env.DAVID_EMAIL,
        to: process.env.DAVID_EMAIL,
        subject: `[Qualification] ${brief.nom} — ${brief.entreprise || 'cabinet non précisé'}`,
        html: renderBriefEmail(brief, briefId),
      }),
      sendMail({
        from: process.env.DAVID_EMAIL,
        to: brief.email,
        subject: 'Brief bien reçu — je reviens vers toi sous 24h',
        html: `<p>Salut ${brief.nom.split(/\s+/)[0]},</p>
<p>J'ai bien reçu ton brief. Je relis tout ça et je te reviens sous 24h avec un premier retour et un batch de leads à te proposer.</p>
<p>Si tu veux ajuster quelque chose avant, réponds simplement à ce mail.</p>
<p>David</p>`,
      }),
      mem0Task,
    ]);

    // Déclenchement Lead Selector en fire-and-forget. On ne bloque PAS la
    // réponse HTTP au consultant. Toute erreur est swallowée par la fonction
    // (defensive). Voir SPEC §9.2 — le piège fire-and-forget Azure Functions
    // sera traité par bascule queue trigger si on observe des kills.
    try {
      triggerLeadSelector({ brief, briefId, consultantId, context });
    } catch (err) {
      if (context && typeof context.warn === 'function') {
        context.warn(`[leadSelector] trigger sync error: ${err.message}`);
      }
    }

    return {
      status: 200,
      headers: CORS_HEADERS,
      jsonBody: { ok: true, brief_id: briefId },
    };
  } catch (err) {
    if (context && typeof context.error === 'function') {
      context.error('onQualification error:', err);
    }
    return {
      status: 500,
      headers: CORS_HEADERS,
      jsonBody: { error: err.message },
    };
  }
}

app.http('onQualification', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: (request, context) => handleQualification(request, context),
});

module.exports = {
  handleQualification,
  buildConsultantMemory,
  defaultTriggerLeadSelector,
  buildInsufficientBriefMail,
};

// ─── Lead Selector — fire-and-forget après Promise.all ─────────────────────

/**
 * Déclenche le pipeline complet (sélection candidates + enrichment exhauster +
 * lancement séquence) en fire-and-forget après la réponse HTTP au consultant.
 *
 * Mis à jour Jalon 3 : consomme `enrichBatchForConsultant` au lieu de
 * l'ancien `selectLeadsForConsultant`. Le mail "base à affiner" est
 * construit par `buildInsufficientBatchMail` (migré dans enrichBatch
 * conformément au point Paul #1 Jalon 3).
 *
 * Inhibé via env LEAD_SELECTOR_DISABLED=1 (utile pour tests/staging).
 */
function defaultTriggerLeadSelector({ brief, briefId, consultantId, context }) {
  if (process.env.LEAD_SELECTOR_DISABLED === '1') return;

  let enrichBatchForConsultant;
  let buildInsufficientBatchMail;
  let launchSequenceForConsultant;
  let sendMailLazy;
  try {
    ({ enrichBatchForConsultant, buildInsufficientBatchMail } = require('../../shared/lead-exhauster/enrichBatch'));
    ({ launchSequenceForConsultant } = require('../../agents/david/orchestrator'));
    ({ sendMail: sendMailLazy } = require('../../shared/graph-mail'));
  } catch (err) {
    if (context && typeof context.warn === 'function') {
      context.warn(`[leadSelector] trigger require failed: ${err.message}`);
    }
    return;
  }

  // La promise n'est volontairement pas await depuis le handler HTTP.
  const startedAt = Date.now();
  const logInfo = (msg, payload) => {
    if (!context) return;
    if (context.log && typeof context.log.info === 'function') context.log.info(msg, payload);
    else if (typeof context.log === 'function') context.log(msg, payload);
  };
  logInfo('leadSelector.trigger.start', { brief_id: briefId, consultantId });
  (async () => {
    try {
      const beneficiaryId = `oseys-${String(consultantId || '').split('@')[0] || 'unknown'}`;
      const result = await enrichBatchForConsultant({
        brief,
        beneficiaryId,
        briefId,
        consultantId,
        context,
      });

      if (context && typeof context.log === 'function') {
        context.log(
          `[leadSelector] brief_id=${briefId} status=${result.status} returned=${result.meta && result.meta.returned}`,
        );
      }

      if (result.status === 'ok') {
        const consultant = {
          nom: brief.nom,
          email: brief.email,
          offre: brief.offre,
          ton: brief.registre,
          tutoiement: brief.vouvoiement === 'tu',
        };
        const briefForSeq = { prospecteur: brief.prospecteur || 'both' };
        const seqResults = await launchSequenceForConsultant({
          consultant,
          brief: briefForSeq,
          leads: result.leads,
          context,
        });
        if (context && typeof context.log === 'function') {
          const ok = seqResults.filter((r) => !r.error).length;
          context.log(
            `[leadSelector] sequence launched for brief_id=${briefId}, ok=${ok}/${seqResults.length}`,
          );
        }
      } else if (result.status === 'insufficient') {
        // Partielle : on lance tout de même la séquence sur les leads
        // disponibles ET on envoie le mail "base à affiner" en parallèle.
        const consultant = {
          nom: brief.nom,
          email: brief.email,
          offre: brief.offre,
          ton: brief.registre,
          tutoiement: brief.vouvoiement === 'tu',
        };
        const briefForSeq = { prospecteur: brief.prospecteur || 'both' };
        await Promise.all([
          launchSequenceForConsultant({
            consultant, brief: briefForSeq, leads: result.leads, context,
          }),
          sendMailLazy({
            from: process.env.DAVID_EMAIL,
            to: brief.email,
            subject: 'Lead Selector — base à affiner',
            html: buildInsufficientBatchMail(brief, result),
          }),
        ]);
      } else {
        // empty / error → mail d'élargissement seul
        await sendMailLazy({
          from: process.env.DAVID_EMAIL,
          to: brief.email,
          subject: 'Lead Selector — base à affiner',
          html: buildInsufficientBatchMail(brief, result),
        });
      }
      logInfo('leadSelector.trigger.end', {
        brief_id: briefId,
        consultantId,
        status: result.status,
        returned: result.meta && result.meta.returned,
        elapsed_ms: Date.now() - startedAt,
      });
    } catch (err) {
      if (context && typeof context.error === 'function') {
        context.error('[leadSelector] fire-and-forget failed', err);
      }
      logInfo('leadSelector.trigger.end', {
        brief_id: briefId,
        consultantId,
        status: 'exception',
        error: err && err.message,
        elapsed_ms: Date.now() - startedAt,
      });
    }
  })();
}

function buildInsufficientBriefMail(brief, result) {
  const meta = (result && result.meta) || {};
  const prenomConsultant = String(brief.nom || '').split(/\s+/)[0] || 'Consultant';
  const suggestions = buildSuggestions(brief, result);
  const li = (s) => `<li>${escapeHtml(s)}</li>`;
  const checks = [
    `Secteurs NAF ciblés : ${(meta.nafCodesQueried && meta.nafCodesQueried.length) || 0} codes`,
    `Effectif : tranches ${(meta.effectifCodesQueried || []).join(', ') || '—'}`,
    `Candidats dans la base : ${meta.candidatesCount || 0}`,
    `Exclus (règles produit) : ${meta.excludedByRules || 0}`,
    `Sans email exploitable : ${meta.excludedNoEmail || 0}`,
  ];
  return `<div style="font-family:Arial,sans-serif;color:#1a1714">
<p>Salut ${escapeHtml(prenomConsultant)},</p>
<p>J'ai lancé la sélection des leads sur ta base cible et je tombe sur ${meta.returned || 0} prospects sur les ${meta.requested || 10} attendus. C'est pas assez pour démarrer proprement.</p>
<p>Voilà ce que j'ai regardé :</p>
<ul>${checks.map(li).join('')}</ul>
<p>Mes propositions pour élargir :</p>
<ul>${suggestions.map(li).join('')}</ul>
<p>Dis-moi ce qui te va et je relance la sélection.</p>
<p>David</p>
</div>`;
}

function buildSuggestions(brief, result) {
  const out = [];
  const meta = (result && result.meta) || {};
  const rayon = Number(brief.zone_rayon);
  if (rayon && rayon < 50) {
    out.push(`Élargir le rayon de ${rayon} km à 50 km ou 75 km`);
  }
  const zone = String(brief.zone || '').toLowerCase();
  if (zone !== 'france' && zone !== 'region') {
    out.push("Passer à la région entière ou à la France entière");
  }
  if (brief.effectif && !String(brief.effectif).includes('40-75') && !String(brief.effectif).includes('any')) {
    out.push("Étendre l'effectif aux entreprises 40-75 salariés");
  }
  if (meta.excludedNoEmail && meta.returned !== undefined && meta.excludedNoEmail > meta.returned * 2) {
    out.push("Beaucoup de prospects n'ont pas d'email direct en base — on a un chantier de résolution emails à venir, je peux te flagger pour qu'il soit prioritaire");
  }
  if (out.length === 0) {
    out.push("Ajouter un secteur NAF complémentaire via le formulaire (autocomplete 'Autres secteurs ou codes NAF')");
  }
  return out;
}

function renderBriefEmail(brief, briefId) {
  const row = (k, v) => v
    ? `<tr><td style="padding:6px 12px 6px 0;font-size:12px;color:#7a756f;vertical-align:top">${k}</td><td style="padding:6px 0;font-size:13px;color:#1a1714">${escapeHtml(v)}</td></tr>`
    : '';
  return `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:Arial,sans-serif">
<tr><td>
<h2 style="font-size:18px;color:#1a1714;margin:0 0 12px">Nouveau brief consultant</h2>
<p style="color:#7a756f;font-size:12px;margin:0 0 16px">ID : ${briefId} · ${new Date().toISOString()}</p>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #E2DDD8;padding-top:12px">
  ${row('Nom', brief.nom)}
  ${row('Email', brief.email)}
  ${row('Cabinet', brief.entreprise)}
  ${row('Téléphone', brief.telephone)}
  ${row('Ville', brief.ville)}
  ${row('LinkedIn', brief.linkedin)}
  ${row('Prospecteur choisi', brief.prospecteur)}
  ${row('Niveau d\'autonomie', brief.niveau_autonomie)}
  ${row('Offre', brief.offre)}
  ${row('Secteurs cibles', brief.secteurs)}
  ${row('Secteurs libres', brief.secteurs_autres)}
  ${row('Tranche effectif', brief.effectif)}
  ${row('Zone géo', brief.zone)}
  ${row('Registre', brief.registre)}
  ${row('Tu / vous', brief.vouvoiement)}
  ${row('Exemple client', brief.exemple_client)}
</table>
</td></tr>
</table>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
