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
const { makeSafeLogger } = require('../../shared/safe-log');
const {
  recordOnboardingCompleted: defaultRecordOnboardingCompleted,
} = require('../../shared/storage-tables/consultantOnboarding');
const { recordAction: defaultRecordAction } = require('../../shared/storage-tables/davidActions');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Construit le schéma de mémoire consultant à partir du brief reçu du
 * formulaire public. Mapping conforme ARCHITECTURE §3.1 type 2.
 *
 * Enrichi v1 chantier Lead Selector : champs de ciblage (secteurs_autres,
 * effectif, zone, zone_rayon, adresse, prospecteur, ville, email).
 *
 * Enrichi v2 chantier VP socle (1er mai 2026, cf. agents/david/value-proposition.md
 * + shared/oseys-vp/) : 5 nouveaux champs pour permettre à Sonnet 4.6 de
 * projeter la VP OSEYS de manière personnalisée par consultant :
 *   - offre_choisie : 'lead' | 'rdv-cale' (offre commerciale distribuée par David)
 *   - mise_en_copie_consultant : boolean (consultant en CC sur les échanges)
 *   - cible_specifique : nuance optionnelle de cible (secteur précis, taille,
 *     persona) que le consultant souhaite indiquer en plus du socle 5-75 sweet
 *     spot 10-40
 *   - methode_consultant : sa nuance/spécialité propre (à projeter sans pitcher
 *     comme un produit)
 *   - anecdotes_anonymisees : liste d'anecdotes anonymisées qu'il valide pouvoir
 *     utiliser en in-context (jamais de nom client réel)
 *
 * Si non précisés au formulaire, fallback raisonnables (offre lead par défaut,
 * pas en copie, pas de nuance cible, pas de méthode propre, pas d'anecdotes).
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
    // ─── VP socle enrichissement (chantier 1er mai 2026) ──────────────────
    offre_choisie: brief.offre_choisie === 'rdv-cale' ? 'rdv-cale' : 'lead',
    mise_en_copie_consultant: brief.mise_en_copie_consultant === true,
    cible_specifique: brief.cible_specifique || '',
    methode_consultant: brief.methode_consultant || '',
    anecdotes_anonymisees: Array.isArray(brief.anecdotes_anonymisees)
      ? brief.anecdotes_anonymisees.filter((a) => typeof a === 'string' && a.trim())
      : (brief.anecdotes_anonymisees ? [String(brief.anecdotes_anonymisees)] : []),
  };
}

/**
 * Handler extractible pour les tests. Trois dépendances externes
 * (sendMail, getMem0, triggerLeadSelector) sont injectables via `deps` —
 * en prod on utilise les implémentations par défaut.
 */
async function handleQualification(request, context, deps = {}) {
  const log = makeSafeLogger(context);
  const sendMail = deps.sendMail || defaultSendMail;
  const getMem0 = deps.getMem0 || defaultGetMem0;
  const triggerLeadSelector = deps.triggerLeadSelector || defaultTriggerLeadSelector;
  const recordOnboardingCompleted = deps.recordOnboardingCompleted || defaultRecordOnboardingCompleted;
  const recordAction = deps.recordAction || defaultRecordAction;

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
          log.warn(`[mem0] storeConsultant failed: ${err.message}`);
          return null;
        })
      : Promise.resolve(null);

    const completedAt = new Date().toISOString();
    const onboardingTask = recordOnboardingCompleted({
      consultantEmail: brief.email,
      consultantName: brief.nom,
      briefId,
      responses: consultantMemory,
      completedAt,
    }).catch((err) => {
      log.warn(`[storage-tables] recordOnboardingCompleted failed: ${err && err.message}`);
      return null;
    });
    const actionTask = recordAction({
      consultantEmail: brief.email,
      type: 'onboarding_completed',
      summary: `Formulaire onboarding complété par ${brief.nom}`,
      metadata: { briefId, prospecteur: brief.prospecteur || 'both', offre: brief.offre },
      at: completedAt,
    }).catch((err) => {
      log.warn(`[storage-tables] recordAction onboarding_completed failed: ${err && err.message}`);
      return null;
    });

    // Mails + tâches I/O lancés en fire-and-forget pour ne pas bloquer la
    // réponse HTTP au formulaire (sinon 2-4s de latence Promise.all → cause
    // Failed to fetch côté browser sur réseau mobile/lent, observé Morgane/
    // Johnny le 4 mai 2026 12h00).
    //
    // Les 2 sendMail (récap David + accusé consultant) + Mem0 storeConsultant
    // + recordOnboardingCompleted + recordAction tournent en arrière-plan.
    // Toute erreur est swallowée par les .catch() de chaque promise. Le brief
    // est de toute façon tracé dans la Storage Table consultantOnboarding
    // (best-effort) + dans les logs FA.
    const sendMailDavid = sendMail({
      from: process.env.DAVID_EMAIL,
      to: process.env.DAVID_EMAIL,
      subject: `[Qualification] ${brief.nom} — ${brief.entreprise || 'cabinet non précisé'}`,
      html: renderBriefEmail(brief, briefId),
    }).catch((err) => log.warn(`[sendMail] david récap failed: ${err && err.message}`));
    const sendMailConsultant = sendMail({
      from: process.env.DAVID_EMAIL,
      to: brief.email,
      subject: 'Brief bien reçu — je reviens vers toi sous 24h',
      html: `<p>Salut ${brief.nom.split(/\s+/)[0]},</p>
<p>J'ai bien reçu ton brief. Je relis tout ça et je te reviens sous 24h avec un premier retour et un batch de leads à te proposer.</p>
<p>Si tu veux ajuster quelque chose avant, réponds simplement à ce mail.</p>
<p>David</p>`,
    }).catch((err) => log.warn(`[sendMail] consultant accusé failed: ${err && err.message}`));

    // Déclenchement Lead Selector en fire-and-forget (idem comportement
    // historique). Inhibé via env LEAD_SELECTOR_DISABLED=1.
    try {
      triggerLeadSelector({ brief, briefId, consultantId, context });
    } catch (err) {
      log.warn(`[leadSelector] trigger sync error: ${err.message}`);
    }

    // Volontairement : on ne fait PAS await sur les promesses ci-dessus.
    // Sur Linux Consumption v4, l'event loop reste vivant tant que le worker
    // n'est pas recyclé — les promises continuent en arrière-plan. C'est le
    // comportement déjà utilisé par triggerLeadSelector. Pour fiabiliser, on
    // référence les promises pour éviter "unused expression" mais on ne les
    // attend pas.
    void sendMailDavid;
    void sendMailConsultant;
    void mem0Task;
    void onboardingTask;
    void actionTask;

    return {
      status: 200,
      headers: CORS_HEADERS,
      jsonBody: { ok: true, brief_id: briefId },
    };
  } catch (err) {
    log.error('onQualification error:', err);
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

// ─── Lead Selector — post queue async (fix 5 mai 2026) ─────────────────────

/**
 * Poste un job sur la queue `lead-selector-jobs` consommée par le handler
 * `leadSelectorJobQueue` (timeout 10 min, hors fenêtre HTTP). Le pipeline
 * complet (enrichBatch + sequence Martin/Mila + mail "base à affiner") est
 * exécuté côté queue trigger via `rebuildConsultantFromMem0` qui relit le
 * brief depuis Mem0.
 *
 * Avant ce fix, le pipeline tournait en IIFE async directe dans le worker
 * FA — fragile sur Linux Consumption v4, tué par recycle worker post-200,
 * ce qui a bloqué les briefs Morgane et Johnny du 4 mai 2026 PM (aucune
 * séquence générée, aucun mail "base à affiner" envoyé).
 *
 * `visibilityTimeout: 10s` laisse le temps au `storeConsultant` Mem0
 * fire-and-forget de finir avant que le handler queue ne lise.
 *
 * Inhibé via env LEAD_SELECTOR_DISABLED=1.
 */
function defaultTriggerLeadSelector({ brief, briefId, consultantId, context }) {
  if (process.env.LEAD_SELECTOR_DISABLED === '1') return;
  const log = makeSafeLogger(context);

  let QueueClient;
  let randomUUID;
  try {
    ({ QueueClient } = require('@azure/storage-queue'));
    ({ randomUUID } = require('node:crypto'));
  } catch (err) {
    log.warn(`[leadSelector] queue require failed: ${err.message}`);
    return;
  }

  const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const batchSize = Number(process.env.LEAD_SELECTOR_BATCH_SIZE || 10);
  const payload = JSON.stringify({ jobId, consultantId, batchSize, dryRun: false, briefId });

  (async () => {
    try {
      const queueClient = new QueueClient(process.env.AzureWebJobsStorage, 'lead-selector-jobs');
      await queueClient.createIfNotExists();
      await queueClient.sendMessage(Buffer.from(payload).toString('base64'), {
        visibilityTimeout: 10,
      });
      log.info('leadSelector.queued', { brief_id: briefId, consultantId, jobId });
    } catch (err) {
      log.error('[leadSelector] queue post failed', err);
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
