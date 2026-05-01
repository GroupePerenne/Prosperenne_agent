/**
 * Générateur de séquence de prospection J0 / J+4 / J+10 / J+18 / J+28
 *
 * Utilisé par Martin et Mila pour produire les 5 messages d'une séquence,
 * personnalisés au consultant, au lead et à l'agent expéditeur, en projetant
 * la proposition de valeur OSEYS via le module shared/oseys-vp/.
 *
 * Architecture VP en 3 couches injectées au system prompt Sonnet 4.6 :
 *   1. Socle OSEYS commun (constant) — baseline, formulations, anti-patterns,
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

const vp = require('./oseys-vp');

/** Calendrier canonique de la séquence (5 touches sur 28 jours ouvrés) */
const SCHEDULE = [
  { jour: 'J0',   offsetBusinessDays: 0,  role: 'ouverture',
    brief: 'Message d\'ouverture. Court (4-6 lignes selon DISC). Une accroche naturelle ancrée sur le SIGNAL OBSERVABLE du prospect, une question simple qui invite à répondre. PAS de pitch commercial, PAS de présentation de l\'offre, PAS de chiffrage.' },
  { jour: 'J+4',  offsetBusinessDays: 4,  role: 'relance_angle',
    brief: 'Relance avec ANGLE NOUVEAU. 3-5 lignes. Apporter un constat, une observation sectorielle ou une question différente du J0. JAMAIS "je reviens vers vous" ou équivalent.' },
  { jour: 'J+10', offsetBusinessDays: 10, role: 'valeur',
    brief: 'Message de valeur. 5-8 lignes. Partager un insight concret, une observation métier utile, sans demander quoi que ce soit. Terminer par une question ouverte. Aucune invention de chiffres, ni de cas clients non sourçables.' },
  { jour: 'J+18', offsetBusinessDays: 18, role: 'derniere_touche',
    brief: 'Dernière touche douce. 3-4 lignes. Ton léger, sans pression. Rappel court du sujet, invitation à réagir si le moment est opportun. Laisser le prospect maître de la suite.' },
  { jour: 'J+28', offsetBusinessDays: 28, role: 'rupture',
    brief: 'Rupture polie. 3-4 lignes. Annoncer qu\'on arrête de solliciter pour ne pas saturer, laisser la porte explicitement ouverte à un retour du prospect plus tard. Pas de reproche, pas de culpabilisation.' },
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
      system: systemPrompt,
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
    : 'Cible générale OSEYS : dirigeants TPE/PME 5-75 salariés, sweet spot 10-40, pas de DAF/DRH dédié.';

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

  return `Tu es ${agent.prenom}, chargé(e) d'affaires commercial(e) chez OSEYS, écrivant pour le compte du consultant ${consultant.nom}.

## Identité OSEYS — socle non négociable
OSEYS est un réseau de consultants indépendants qui COPILOTENT les dirigeants de TPE/PME françaises dans le PILOTAGE ÉCONOMIQUE de leur activité. Le mot juste est COPILOTE — pas conseil ponctuel, pas auditeur, pas coach. Le dirigeant garde le volant ; le consultant garantit qu'il pilote en conscience.

Baseline OSEYS : « ${vp.BASELINE} »

Formulation pitch en 2 phrases (pour t'imprégner du registre, pas à recopier) :
${vp.FORMULATIONS.pitch_2_phrases}

## Posture éthique (crucial)
Tu opères depuis ${agent.mail || agent.prenom + '@oseys.fr'}, ton adresse propre. Tu n'usurpes JAMAIS l'identité du consultant. Tu es chargé(e) d'affaires POUR LE COMPTE DE ${consultant.nom}, jamais AU NOM DE avec spoofing de boîte. Le replyTo de tes mails est ton adresse, pas celle du consultant ni de David.

David, le directeur commercial OSEYS, n'apparaît PAS dans ces messages. Si une intervention de David se justifie un jour (escalation, validation, appui hiérarchique), elle se fait à part — pas dans tes messages prospect.

## Règles d'honneur (non négociables)
${reglesHonneur}

## Anti-patterns vocabulaire (à BANNIR strictement)
${antiPatterns}

## Le client OSEYS — ce qui se passe vraiment dans sa tête
${ciblage}

Verbatims réels de dirigeants cibles (ground truth, à NE PAS citer mais à incarner dans le ton) :
${verbatims}

Pain principal du dirigeant : manque de clarté + manque d'allié + seuil qui se dérobe.

## Offre du consultant — ${offerSpec.label}
${offerSpec.description}

Call-to-action à adopter pour la séquence : ${offerSpec.call_to_action_J0}${methodeBlock}${anecdotesBlock}

OFFRE COMMERCIALE DU CONSULTANT (ce qu'il vend, à projeter SANS pitcher comme un agent commercial) :
${consultant.offre || '(non précisée — utiliser le socle OSEYS pilotage économique)'}

## Ton à respecter
- Registre : ${consultant.ton || 'posé, pragmatique, orienté résultats'}
- ${consultant.tutoiement ? 'Tutoiement assumé' : 'Vouvoiement'} (selon brief consultant)
- Messages humains, courts, qui donnent envie de répondre
- JAMAIS de formules bateau ("j'espère que ce message vous trouve en forme", "suite à notre conversation", etc.)
- JAMAIS de "je reviens vers vous" en relance — apporte toujours un angle neuf${discBlock}

## Angle d'entrée pour CE prospect
Signal observé chez ce prospect : ${angle.id} — ${angle.pain_principal}.
Formulation directrice (à incarner, pas à copier-coller) : « ${angle.formulation_directrice} »${angleGardeFou}${proofBlock}

## Calendrier de séquence à générer
${SCHEDULE.map(s => `- ${s.jour} (${s.offsetBusinessDays} jours ouvrés) — ${s.role.toUpperCase()} : ${s.brief}`).join('\n')}

## Format de sortie OBLIGATOIRE
Réponds UNIQUEMENT en JSON valide, aucun texte autour. Format exact :
{
  "steps": [
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." },
    { "objet": "...", "corps": "..." }
  ]
}
- Les 5 steps dans l'ordre J0, J+4, J+10, J+18, J+28
- Chaque "corps" utilise \\n pour les sauts de ligne
- NE METS PAS de signature dans le corps — elle est ajoutée automatiquement
- Utilise vraiment le prénom du lead, pas un "Bonjour [Prénom]" générique
- Les 5 messages doivent avoir une COHÉRENCE STYLISTIQUE entre eux (même registre, même ton DISC) pour que le prospect ait l'impression d'un même expéditeur sur toute la séquence`;
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

  return `${base}${companyBlock}${dmBlock}${angleRappel}${prospect}${patterns}

Génère les 5 messages de la séquence (J0/J+4/J+10/J+18/J+28). Sois naturel, pertinent, ancré sur la réalité du métier et du contexte du lead. Respecte la modulation DISC + l'angle d'entrée + les anti-patterns du system prompt.`;
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
