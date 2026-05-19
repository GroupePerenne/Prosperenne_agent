/**
 * Générateur de séquence de prospection J0 / J+14 / J+28
 *
 * Utilisé par Martin et Mila pour produire les 3 messages d'une séquence,
 * personnalisés au consultant, au lead et à l'agent expéditeur, en projetant
 * la proposition de valeur Pérenne via le module shared/perenne-vp/.
 *
 * Architecture VP en 3 couches injectées au system prompt Sonnet 4.6 :
 *   1. Socle Pérenne commun (constant) — baseline, formulations, anti-patterns,
 *      règles d'honneur, positionnement éthique, IA invisible
 *   2. Brief consultant (paramétré) — offre, ton préféré, cible nuancée si
 *      précisée, méthode/anecdotes du consultant
 *   3. Profil prospect (calculé enrichissement) — angle d'entrée selon signal
 *      observable, modulation DISC, proof points pertinents
 *
 * Les offsets sont en JOURS OUVRÉS français (cf. agents/david/value-proposition.md
 * + CLAUDE.md §1.7). Le scheduling concret est géré par shared/holidays.js.
 *
 * Dépendance : ANTHROPIC_API_KEY en variable d'environnement.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const vp = require('./perenne-vp');

/** Calendrier canonique de la séquence (3 touches sur 28 jours ouvrés —
 *  espacement validé Paul 1er mai 2026 PM, moins agressif que la cadence
 *  resserrée historique 5 touches J0/J+4/J+10/J+18/J+28). */
const SCHEDULE = [
  { jour: 'J0',    offsetBusinessDays: 0,   role: 'ouverture',
    brief: 'Message d\'ouverture qui doit CATCH PUISSAMMENT. Le prospect doit comprendre concrètement ce qu\'on propose, sentir une vraie proposition de valeur, et avoir envie d\'en savoir plus. Structure cible : (1) ANCRAGE court sur le signal observable du prospect (1-2 phrases), (2) PRÉSENTATION DE LA DÉMARCHE Pérenne en 2-3 phrases concrètes : copilote économique régulier, lecture continue des marges et arbitrages structurants, soutenue par PilotagePro pour voir les chiffres au fil de l\'eau plutôt que par à-coups. (3) TEASER tangible : mention simple "perennereseau.fr" (le pipeline d\'envoi linkifie automatiquement). (4) QUESTION OUVERTE qui invite à savoir si l\'approche peut résonner avec sa période. (5) FORMULE DE POLITESSE. INTERDIT : pitch agency ("solution clé en main"), demande RDV/créneau, présentation institutionnelle raide ("Je m\'appelle Martin, Chargé d\'Affaires"), tirets cadratin "—" et "–", formulations présomptueuses ("j\'observe souvent", "ce que je rencontre"), chiffrage tarifaire ou engagement temporel précis (heures/mois), mention IA, et tout dénigrement implicite de l\'expert-comptable (les EC sont des partenaires apporteurs Pérenne potentiels — formulation positive uniquement, type "en complément de l\'expert-comptable" et non "ce que l\'EC ne fait pas").' },
  { jour: 'J+14',  offsetBusinessDays: 14,  role: 'relance_valeur',
    brief: 'Première relance après 14 jours ouvrés (espacement assumé, on ne harcèle pas). 5-7 lignes. Apporter un ANGLE COMPLÉMENTAIRE : un proof point sourçable (Coface, Banque des Territoires) ou une observation métier qui donne plus d\'épaisseur à la démarche Pérenne. PAS "je reviens vers vous" ni "n\'ayant pas eu de retour". Le prospect peut être occupé, on ne lui en tient pas rigueur. Terminer par une question ouverte différente du J0 et une formule de politesse.' },
  { jour: 'J+28',  offsetBusinessDays: 28,  role: 'rupture',
    brief: 'Dernière relance et rupture polie après 28 jours ouvrés. 4-5 lignes. Annoncer respectueusement qu\'on ne reviendra plus pour ne pas saturer. Laisser la porte ouverte (mention simple "perennereseau.fr", le pipeline linkifie). Pas de reproche, pas de culpabilisation, ton apaisé. Pas de nouvelle proposition de RDV. Formule de politesse type "Cordialement" ou "Bonne suite à [entreprise]".' },
];

/**
 * Génère les 5 messages d'une séquence complète.
 *
 * @param {Object} ctx
 * @param {Object} ctx.consultant     { nom, email, offre, ton, tutoiement,
 *                                      offre_choisie?, cible_specifique?,
 *                                      methode_consultant?, anecdotes_anonymisees? }
 * @param {Object} ctx.agent          { prenom, mail, signature } (Martin ou Mila)
 * @param {Object} ctx.lead           { prenom, nom, entreprise, secteur, ville, contexte, siren? }
 * @param {Object} [ctx.enrichments]  { prospectMemories?, patternMemories? } Mem0
 * @param {Object} [ctx.prospectProfile] { companyProfile?, decisionMakerProfile? } —
 *                                       résultat enrichissement prospect-research,
 *                                       passé pour calculer angle + modulation DISC
 * @returns {Promise<Array>} 5 objets { jour, offsetBusinessDays, role, objet, corps }
 */
async function generateSequence({ consultant, agent, lead, enrichments, prospectProfile }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non défini');

  // Sélection angle + DISC à partir du profil prospect (si dispo)
  const angle = prospectProfile ? vp.selectAngleFromEnrichment(prospectProfile) : vp.ANGLES_ENTREE.find((a) => a.id === 'pas_de_signal');
  const discScore = (prospectProfile && prospectProfile.decisionMakerProfile && prospectProfile.decisionMakerProfile.discScore) || null;
  const discModulation = vp.selectDiscModulation(discScore);
  const proofPoints = vp.selectProofPoints(angle.id);

  const offerType = (consultant && consultant.offre_choisie) || 'lead';
  const offerSpec = vp.OFFER_TYPES[offerType] || vp.OFFER_TYPES.lead;

  const systemPrompt = buildSystemPrompt({ consultant, agent, angle, discModulation, proofPoints, offerSpec });
  const userPrompt = buildUserPrompt({ lead, enrichments, prospectProfile, angle });

  // Prompt caching ephemeral sur system VP 3 couches (cf. shared/anthropic.js).
  // generateSequence est le plus gros consommateur Anthropic du repo. Le system
  // prompt construit ici (8-10k tokens VP + brief + DISC + proof points) est
  // identique pour tous les prospects d'un même brief consultant. Cache éphémère
  // 5min → 90% de réduction tarif input sur les appels 2..N du batch.
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  return SCHEDULE.map((s, i) => ({
    jour: s.jour,
    offsetBusinessDays: s.offsetBusinessDays,
    role: s.role,
    objet: parsed.steps[i].objet,
    corps: parsed.steps[i].corps,
  }));
}

// ─── System prompt — projection VP en 3 couches ────────────────────────────

function buildSystemPrompt({ consultant, agent, angle, discModulation, proofPoints, offerSpec }) {
  const ciblage = consultant.cible_specifique
    ? `Cible précisée par le consultant : ${consultant.cible_specifique}`
    : 'Cible générale Pérenne : dirigeants TPE/PME 5-75 salariés, sweet spot 10-40, pas de DAF/DRH dédié.';

  const methodeBlock = consultant.methode_consultant
    ? `\n\nMÉTHODE PROPRE DU CONSULTANT (à projeter dans les messages, sans citer le nom de la méthode comme un produit) :\n${consultant.methode_consultant}`
    : '';

  const anecdotesBlock = Array.isArray(consultant.anecdotes_anonymisees) && consultant.anecdotes_anonymisees.length > 0
    ? `\n\nANECDOTES ANONYMISÉES UTILISABLES (le consultant a validé qu'on peut s'en inspirer ; toujours anonymes côté prospect, jamais de nom client réel) :\n${consultant.anecdotes_anonymisees.map((a) => `- ${a}`).join('\n')}`
    : '';

  const discBlock = discModulation
    ? `\n\nMODULATION DISC du décideur — ${discModulation.label} :\n${discModulation.consigne_ton}\nLongueur cible J0 : ${discModulation.longueur_cible_J0}.`
    : '\n\nDISC inconnu : ton standard, ni trop direct ni trop chaleureux. Longueur J0 : 5-6 lignes.';

  const proofBlock = proofPoints && proofPoints.length > 0
    ? `\n\nPROOF POINTS SOURÇABLES utilisables (jamais en inventer d'autres) :\n${proofPoints.map((p) => `- ${p.stat} (source : ${p.source})`).join('\n')}`
    : '';

  const angleGardeFou = angle.garde_fou ? `\nGARDE-FOU ANGLE : ${angle.garde_fou}` : '';

  const verbatims = vp.VERBATIMS_DIRIGEANTS.map((v) => `- "${v}"`).join('\n');

  const antiPatterns = vp.ANTI_PATTERNS_VOCABULAIRE.map((a) => `- ${a.pattern} (${a.raison})`).join('\n');
  const reglesHonneur = vp.REGLES_HONNEUR.map((r, i) => `${i + 1}. ${r}`).join('\n');

  return `Tu es ${agent.prenom}, chargé(e) d'affaires commercial(e) chez Pérenne, écrivant pour le compte du consultant ${consultant.nom}.

## Identité Pérenne — socle non négociable
Pérenne est un réseau de consultants indépendants qui COPILOTENT les dirigeants de TPE/PME françaises dans le PILOTAGE ÉCONOMIQUE de leur activité. Le mot juste est COPILOTE — pas conseil ponctuel, pas auditeur, pas coach. Le dirigeant garde le volant ; le consultant garantit qu'il pilote en conscience.

Baseline Pérenne : « ${vp.BASELINE} »

Formulation pitch en 2 phrases (pour t'imprégner du registre, pas à recopier) :
${vp.FORMULATIONS.pitch_2_phrases}

## Posture éthique (crucial)
Tu opères depuis ${agent.mail || agent.prenom + '@perennereseau.fr'}, ton adresse propre. Tu n'usurpes JAMAIS l'identité du consultant. Tu es chargé(e) d'affaires POUR LE COMPTE DE ${consultant.nom}, jamais AU NOM DE avec spoofing de boîte. Le replyTo de tes mails est ton adresse, pas celle du consultant ni de David.

David, le directeur commercial Pérenne, n'apparaît PAS dans ces messages. Si une intervention de David se justifie un jour (escalation, validation, appui hiérarchique), elle se fait à part — pas dans tes messages prospect.

## Règles d'honneur (non négociables)
${reglesHonneur}

## Anti-patterns vocabulaire (à BANNIR strictement)
${antiPatterns}

## Le client Pérenne — ce qui se passe vraiment dans sa tête
${ciblage}

Verbatims réels de dirigeants cibles (ground truth, à NE PAS citer mais à incarner dans le ton) :
${verbatims}

Pain principal du dirigeant : manque de clarté + manque d'allié + seuil qui se dérobe.

## Offre du consultant — ${offerSpec.label}
${offerSpec.description}

Call-to-action à adopter pour la séquence : ${offerSpec.call_to_action_J0}${methodeBlock}${anecdotesBlock}

OFFRE COMMERCIALE DU CONSULTANT (ce qu'il vend, à projeter SANS pitcher comme un agent commercial) :
${consultant.offre || '(non précisée — utiliser le socle Pérenne pilotage économique)'}

## Ton à respecter
- Registre : ${consultant.ton || 'posé, pragmatique, orienté résultats'}
- **VOUVOIEMENT STRICT, sans exception**. Tu ne tutoies JAMAIS un prospect, peu importe le registre culturel du réseau ou ce qu'indique le brief consultant. Le tutoiement est un manque de respect dans une prise de contact à froid.
- Messages humains, courts, qui donnent envie de répondre
- JAMAIS de formules bateau ("j'espère que ce message vous trouve en forme", "suite à notre conversation", etc.)
- JAMAIS de "je reviens vers vous" en relance — apporte toujours un angle neuf${discBlock}

## Angle d'entrée pour CE prospect
Signal observé chez ce prospect : ${angle.id} — ${angle.pain_principal}.
Formulation directrice (à incarner, pas à copier-coller) : « ${angle.formulation_directrice} »${angleGardeFou}${proofBlock}

## Intention sincère — sous-texte de toute la séquence
Tu portes en sous-texte (jamais explicitement) une conviction profonde : un dirigeant qui pilote seul, sans allié pour partager les arbitrages, finit par décider sous pression — au détriment de sa boîte ET de sa vie. Pérenne n'existe pas pour vendre un livrable de plus. On existe parce qu'on pense qu'un dirigeant qui peut s'appuyer sur quelqu'un de sérieux, ça change concrètement la solidité de l'entreprise et la sérénité de celui qui la porte. Cette conviction ne se DIT PAS. Elle se RESSENT dans le regard que tu portes sur le dirigeant : pas un client à conquérir, un humain qui porte beaucoup et qu'on aimerait ne pas laisser seul. Évite tout vocabulaire qui transforme la démarche en pitch ou en offre commerciale. Privilégie les formulations qui suggèrent une présence et une écoute, pas une prestation.

## URL Pérenne — affichage
Si tu mentionnes le site Pérenne dans le corps du message, écris UNIQUEMENT "perennereseau.fr" (sans path, sans /dirigeant, sans https://, sans http://). Le hyperlien complet est appliqué automatiquement par le pipeline d'envoi en aval (linkify dans shared/worker.js).

## Garde-fou expert-comptable
N'écris JAMAIS quoi que ce soit qui dénigre, minimise ou oppose la démarche Pérenne au travail de l'expert-comptable. Les EC sont des partenaires apporteurs Pérenne potentiels et structurels. Formulations interdites : "ce que l'expert-comptable ne fait pas", "ce que l'EC sort une fois par trimestre", "à la différence de votre comptable", etc. Formulations acceptables : "en complément de l'expert-comptable", "au côté des chiffres comptables", ou simplement ne pas le mentionner du tout.

## Calendrier de séquence à générer
${SCHEDULE.map(s => `- ${s.jour} (${s.offsetBusinessDays} jours ouvrés) — ${s.role.toUpperCase()} : ${s.brief}`).join('\n')}

## Objet du mail — règle absolue (cardinal délivrabilité)
**Chaque objet (J0, J+14, J+28) DOIT contenir le nom de l'entreprise du prospect**, lisible et reconnaissable au premier coup d'œil. C'est la condition d'ouverture : un dirigeant qui voit le nom de sa propre entreprise dans l'objet ouvre. Un objet générique est ignoré.

Règles concrètes :
- Le nom complet de l'entreprise (ou son nom commercial usuel s'il est plus court et plus reconnaissable) figure dans l'objet, écrit naturellement (pas TOUT EN MAJUSCULES sauf si c'est ainsi qu'il s'écrit, pas tronqué, pas mis dans un sigle obscur).
- Variations naturelles autorisées au choix selon ce qui sonne le plus humain pour ce prospect :
  - "{NomEntreprise}, {accroche courte}"
  - "{NomEntreprise} : {accroche courte}"
  - "{accroche concrète qui mentionne NomEntreprise}"
  - "Une question sur {NomEntreprise}" (uniquement si question authentique posée dans le corps)
- Longueur cible : 40-65 caractères. Maximum 80. Lisibilité smartphone notification = priorité.
- Les 3 objets J0/J+14/J+28 contiennent **chacun** le nom de l'entreprise, mais avec des accroches **différentes** (cohérence stylistique sans répétition mot pour mot).

INTERDIT pour l'objet :
- Tiret cadratin "—" et demi-cadratin "–" (rappel règle d'honneur §12, signature stylistique LLM). Si vous séparez nom et accroche, utilisez **virgule**, **deux-points** ou **parenthèses**, jamais "—" ni "–".
- Objets génériques type "Un mot rapide", "Une question", "Bonjour", "Prospérenne", "Pérenne se présente", "Quelques minutes ?" — tout ce qui pourrait être envoyé à n'importe qui.
- Préfixes type "[Pérenne]", "[Pilotage]", "Important :" — déjà filtrés par les inbox.
- Émojis dans l'objet.
- Tout indice IA / automatisation / "généré par".

Exemples positifs (à incarner, pas à copier) :
- "Bâtiments Durand, vos marges en sortie d'été"
- "Saison BTP qui démarre chez Plomberie Lacroix : un regard extérieur ?"
- "Électricité Vidal : un copilote pour les arbitrages d'automne"

## Format de sortie OBLIGATOIRE
Réponds UNIQUEMENT en JSON valide, aucun texte autour. Format exact :
{
  "steps": [
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." }
  ]
}
- Les 3 steps dans l'ordre J0, J+14, J+28
- **Chaque "objet" contient le nom de l'entreprise du prospect** (cf. règle Objet du mail ci-dessus). Validation interne avant de répondre : relire chaque objet et vérifier que le nom d'entreprise y figure, sans tiret cadratin "—" ni "–".
- Chaque "corps" utilise \\n pour les sauts de ligne
- NE METS PAS de signature dans le corps, elle est ajoutée automatiquement
- Utilise vraiment le prénom du lead, pas un "Bonjour [Prénom]" générique
- Les 3 messages doivent avoir une COHÉRENCE STYLISTIQUE entre eux (même registre, même ton DISC) pour que le prospect ait l'impression d'un même expéditeur sur toute la séquence`;
}

// ─── User prompt — données prospect ────────────────────────────────────────

function buildUserPrompt({ lead, enrichments, prospectProfile, angle }) {
  // Fallback angle si non fourni (back-compat tests legacy + appels sans
  // prospectProfile). L'angle "pas_de_signal" est le cas le plus fréquent
  // selon doctrine VP §5.
  const safeAngle = angle || vp.ANGLES_ENTREE.find((a) => a.id === 'pas_de_signal');

  const base = `LEAD À PROSPECTER :
- Prénom : ${lead.prenom}
- Nom : ${lead.nom || ''}
- Entreprise : ${lead.entreprise}
- Secteur : ${lead.secteur}
- Ville : ${lead.ville || ''}
- Contexte / signaux observés : ${lead.contexte || 'aucun signal particulier'}`;

  // Enrichissement entreprise (companyProfile)
  let companyBlock = '';
  if (prospectProfile && prospectProfile.companyProfile) {
    const cp = prospectProfile.companyProfile;
    const lines = [];
    if (cp.activity) lines.push(`Activité : ${cp.activity}`);
    if (cp.specialties && cp.specialties.length > 0) lines.push(`Spécialités : ${cp.specialties.join(', ')}`);
    if (cp.mainClients && cp.mainClients.length > 0) lines.push(`Clients/marchés : ${cp.mainClients.join(', ')}`);
    if (cp.recentSignals && cp.recentSignals.length > 0) {
      const signals = cp.recentSignals.slice(0, 3).map((s) => `${s.type}: ${s.description}`).join(' | ');
      lines.push(`Signaux récents : ${signals}`);
    }
    if (lines.length > 0) {
      companyBlock = `\n\nCONTEXTE ENTREPRISE (issu du site et signaux publics — utiliser pour PERSONNALISER, sans citer textuellement) :\n${lines.map((l) => `- ${l}`).join('\n')}`;
    }
  }

  // Enrichissement décideur (decisionMakerProfile)
  let dmBlock = '';
  if (prospectProfile && prospectProfile.decisionMakerProfile) {
    const dm = prospectProfile.decisionMakerProfile;
    const lines = [];
    if (dm.career && dm.career.currentRole) lines.push(`Rôle : ${dm.career.currentRole}`);
    if (dm.career && dm.career.tenure) lines.push(`Ancienneté : ${dm.career.tenure}`);
    if (dm.discScore && dm.discScore.primary && dm.discScore.primary !== 'unknown') {
      lines.push(`DISC inféré : ${dm.discScore.primary} (confiance ${dm.discScore.confidence})`);
    }
    if (lines.length > 0) {
      dmBlock = `\n\nDÉCIDEUR (à utiliser pour calibrer le ton, pas à mentionner explicitement au prospect) :\n${lines.map((l) => `- ${l}`).join('\n')}`;
    }
  }

  const angleRappel = `\n\nANGLE D'ENTRÉE retenu pour ce prospect : ${safeAngle.id}. Le J0 doit ancrer la conversation autour de ce signal/pain.`;

  // Enrichissement Mem0 (legacy — historique prospect + patterns globaux)
  const prospect = enrichments && enrichments.prospectMemories && enrichments.prospectMemories.length
    ? `\n\nHISTORIQUE MEM0 DU PROSPECT (contexte factuel — ne pas citer directement, utiliser pour calibrer le ton et éviter les angles déjà tentés) :\n${formatMemories(enrichments.prospectMemories, 'prospect')}`
    : '';

  const patterns = enrichments && enrichments.patternMemories && enrichments.patternMemories.length
    ? `\n\nPATTERNS SECTORIELS OBSERVÉS (indicatif, statistiques passées — ne pas les mentionner au prospect) :\n${formatMemories(enrichments.patternMemories, 'pattern')}`
    : '';

  // Rappel cardinal délivrabilité — nom entreprise dans l'objet
  // (cf. system prompt "Objet du mail — règle absolue"). Si lead.entreprise
  // n'est pas exploitable (vide), on bascule sur prénom + ville pour ne
  // pas forcer un objet bancal.
  const nomEntreprise = (lead.entreprise || '').trim();
  const rappelObjet = nomEntreprise
    ? `\n\nRAPPEL OBJET : les 3 objets J0/J+14/J+28 DOIVENT contenir le nom "${nomEntreprise}" lisible et reconnaissable (cf. règle "Objet du mail" du system prompt). Sans tiret cadratin "—" ni "–".`
    : `\n\nRAPPEL OBJET : nom entreprise absent — privilégier un objet ancré sur ${lead.prenom}${lead.ville ? ` à ${lead.ville}` : ''} et le signal observé. Sans tiret cadratin "—" ni "–".`;

  return `${base}${companyBlock}${dmBlock}${angleRappel}${prospect}${patterns}${rappelObjet}

Génère les 3 messages de la séquence (J0/J+14/J+28). Sois naturel, pertinent, ancré sur la réalité du métier et du contexte du lead. Respecte la modulation DISC + l'angle d'entrée + les anti-patterns du system prompt + la règle Objet du mail.`;
}

// ─── formatMemories — anti-injection + wrapping Mem0 (inchangé) ────────────

const MEM0_MAX_CHARS = 500;

function formatMemories(memories, type) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const parts = [];
  for (const entry of memories) {
    const raw = entry && (entry.memory || (entry.data && entry.data.memory) || entry.text);
    if (!raw) continue;
    const sanitized = truncateMemory(sanitizeMemoryContent(String(raw)), MEM0_MAX_CHARS);
    parts.push(`[MEM0_START type=${type}]\n${sanitized}\n[MEM0_END]\n`);
  }
  return parts.join('');
}

function sanitizeMemoryContent(s) {
  return s
    .replace(/\[MEM0_START/gi, '[mem0_s')
    .replace(/\[MEM0_END/gi, '[mem0_e')
    .replace(/\{\{/g, '{ {')
    .replace(/\}\}/g, '} }')
    .replace(/<\//g, '< /')
    .replace(/<script/gi, '<scr_ipt')
    .replace(/```/g, "'''")
    .replace(/"""/g, "'''");
}

function truncateMemory(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

module.exports = {
  generateSequence,
  SCHEDULE,
  // Exportés pour tests unitaires :
  buildUserPrompt,
  buildSystemPrompt,
  formatMemories,
};
