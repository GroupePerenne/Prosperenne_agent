/**
 * Tests intégration — shared/prospect-research (pipeline complet).
 *
 * Couvre les 4 scénarios SPEC §10.2 :
 *   1. Entreprise digitalisée + décideur LinkedIn actif → profil complet
 *   2. TPE peu visible en ligne → profil partiel, DISC unknown
 *   3. Site down → couche A null, couche B ok → status partial
 *   4. Timeout LLM → dégradation gracieuse
 *
 * Aucun appel Anthropic réseau : tous les LLM sont injectés via opts.
 * Azure Storage n'est pas configuré (AzureWebJobsStorage absent) → le cache
 * dégrade silencieusement, ce qui est exactement le comportement attendu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { profileProspect } = require('../../../shared/prospect-research');

// ─── Scénario 1 : profil complet ─────────────────────────────────────────

test('pipeline — entreprise digitalisée + décideur LinkedIn actif → ok + accroche', async () => {
  const apiGouvImpl = async () => ({
    siren: '552032534',
    nomEntreprise: 'ACME SAS',
    activiteDeclaree: 'Agence digitale',
    codeNaf: '62.01Z',
    commune: 'Paris',
    estActive: true,
    trancheEffectif: '12',
  });
  const scraperImpl = async () => ({
    domain: 'acme.fr',
    texts: [
      {
        url: 'https://acme.fr/',
        text:
          'ACME agence B2B à Paris, 18 personnes, experts Node.js et Azure. ' +
          'Nous accompagnons des PME ambitieuses comme La Poste et Decathlon sur ' +
          'leur roadmap tech. Levée récente de 3M€ pour financer notre croissance.',
      },
    ],
    visitedPages: [{ url: 'https://acme.fr/', status: 200, charCount: 250 }],
    elapsedMs: 8,
  });
  const searchImpl = async () => ({
    query: '"ACME"',
    provider: 'stub',
    results: [],
    elapsedMs: 1,
  });
  const linkedinProfileImpl = async () => ({
    provider: 'proxycurl',
    status: 'ok',
    profile: {
      fullName: 'Paul Rudler',
      headline: 'CEO @ ACME — croissance B2B',
      currentRole: 'CEO',
      currentCompany: 'ACME',
      tenure: '4 ans',
      experiences: [{ role: 'COO', company: 'BetaCorp', start: '2019', end: '2022' }],
      recentPosts: [{ text: 'Retour sur notre levée, merci à toute l\'équipe.' }],
    },
    elapsedMs: 4,
  });

  const companyLlmImpl = async () => ({
    text: JSON.stringify({
      activity: 'Agence digitale B2B Node.js/Azure',
      specialties: ['Node.js', 'Azure'],
      mainClients: ['La Poste', 'Decathlon'],
      recentSignals: [
        {
          type: 'fundraising',
          description: 'Levée 3M€ récente',
          sourceUrl: null,
          date: null,
        },
      ],
    }),
  });
  const discImpl = async () => ({
    primary: 'D',
    secondary: 'I',
    confidence: 0.82,
    tone: 'startup',
    signals: ['Rôle CEO', 'Publication orientée résultats'],
    inferredPainPoints: ['scalabilité équipe', 'pricing'],
    costCents: 2,
  });
  const pitchLlmImpl = async (req) => {
    assert.ok(req.system.includes('consultant commercial'));
    return {
      text: JSON.stringify({
        hook:
          'Votre levée récente change la donne sur la structuration commerciale. ' +
          'À 18 personnes avec La Poste et Decathlon au portefeuille, la question du ' +
          'pipeline n\'est plus de "signer plus" mais de "signer mieux".',
        angle: 'La croissance post-levée force à industrialiser ce qui passait avant par votre réseau.',
        discAdaptation: 'Ton direct, orienté résultat, phrases courtes (profil D confidence 0.82).',
      }),
    };
  };

  const res = await profileProspect(
    {
      siren: '552032534',
      firstName: 'Paul',
      lastName: 'Rudler',
      role: 'CEO',
      email: 'paul@acme.fr',
      companyName: 'ACME SAS',
      companyDomain: 'acme.fr',
      decisionMakerLinkedInUrl: 'https://linkedin.com/in/paul-rudler',
    },
    {
      apiGouvImpl,
      scraperImpl,
      searchImpl,
      linkedinProfileImpl,
      discImpl,
      companyLlmImpl,
      pitchLlmImpl,
      skipCache: true,
    },
  );

  assert.equal(res.status, 'ok');
  assert.equal(res.siren, '552032534');
  assert.ok(res.companyProfile);
  assert.equal(res.companyProfile.nomEntreprise, 'ACME SAS');
  assert.ok(res.decisionMakerProfile);
  assert.equal(res.decisionMakerProfile.discScore.primary, 'D');
  assert.equal(res.decisionMakerProfile.discScore.confidence, 0.82);
  assert.ok(res.accroche);
  assert.ok(res.accroche.hook.length > 40);
  assert.ok(res.accroche.angle.length > 20);
  assert.equal(res.accroche.discApplied, true);
  assert.ok(res.cost_cents >= 0);
});

// ─── Scénario 2 : TPE peu visible → partial + DISC unknown ───────────────

test('pipeline — TPE peu visible → ok mais DISC unknown, accroche ton neutre', async () => {
  const apiGouvImpl = async () => ({
    siren: '123456789',
    nomEntreprise: 'TPE Locale',
    activiteDeclaree: 'Artisanat',
    codeNaf: '43.32A',
    commune: 'Saint-Etienne',
    estActive: true,
  });
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ results: [], elapsedMs: 0, provider: 'stub', query: '' });
  // Pas de LinkedIn profil → discImpl retourne unknown (ou est skippé par signals.js)
  const discImpl = async () => ({
    primary: 'unknown',
    secondary: null,
    confidence: 0,
    tone: 'unknown',
    signals: [],
    inferredPainPoints: [],
    costCents: 0,
  });
  const pitchLlmImpl = async (req) => {
    // Doit demander un ton neutre (DISC inactif)
    assert.ok(req.messages[0].content.includes('ADAPTATION DISC INACTIVE'));
    return {
      text: JSON.stringify({
        hook: 'Votre activité artisanale à Saint-Etienne présente des enjeux typiques de structuration.',
        angle: 'Les entreprises de votre taille gagnent à formaliser leur prospection sans lourdeur commerciale.',
        discAdaptation: 'Ton neutre équilibré (DISC non fiable, confidence 0).',
      }),
    };
  };

  const res = await profileProspect(
    {
      siren: '123456789',
      firstName: 'Jean',
      lastName: 'Martin',
      role: 'Gérant',
      email: 'j.martin@tpe-locale.fr',
      companyName: 'TPE Locale',
      companyDomain: 'tpe-locale.fr',
    },
    {
      apiGouvImpl,
      scraperImpl,
      searchImpl,
      discImpl,
      pitchLlmImpl,
      skipCache: true,
    },
  );

  assert.equal(res.status, 'ok'); // A ok (apiGouv), B ok mais light
  assert.equal(res.decisionMakerProfile.discScore.primary, 'unknown');
  assert.equal(res.decisionMakerProfile.discScore.confidence, 0);
  assert.ok(res.accroche);
  assert.equal(res.accroche.discApplied, false);
});

// ─── Scénario 3 : Site down → couche A null, couche B ok → partial ───────

test('pipeline — site down + apiGouv down → A null, B ok → partial', async () => {
  const apiGouvImpl = async () => null;
  const scraperImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const searchImpl = async () => ({ results: [], elapsedMs: 0 });
  const discImpl = async () => ({
    primary: 'I',
    confidence: 0.6,
    tone: 'commercial',
    signals: ['Ton posts commerciaux'],
    inferredPainPoints: ['visibilité offres'],
    costCents: 1,
  });
  const linkedinProfileImpl = async () => ({
    provider: 'proxycurl',
    status: 'ok',
    profile: {
      fullName: 'Marie Dupont',
      headline: 'Directrice Commerciale — création de lien client',
      currentRole: 'Directrice Commerciale',
      recentPosts: [{ text: 'Récit client qui a transformé son business model.' }],
    },
  });
  const pitchLlmImpl = async () => ({
    text: JSON.stringify({
      hook: 'Votre approche storytelling client trahit une vraie appétence pour l\'humain.',
      angle: 'L\'accompagnement B2B personnalisé prend tout son sens dans un marché saturé de prospection générique.',
      discAdaptation: 'Ton chaleureux avec storytelling (profil I confidence 0.6).',
    }),
  });

  const res = await profileProspect(
    {
      siren: '999999999',
      firstName: 'Marie',
      lastName: 'Dupont',
      role: 'Directrice Commerciale',
      email: 'marie@x.com',
      companyName: 'X',
      companyDomain: 'x.com',
      decisionMakerLinkedInUrl: 'https://linkedin.com/in/marie-dupont',
    },
    {
      apiGouvImpl,
      scraperImpl,
      searchImpl,
      linkedinProfileImpl,
      discImpl,
      pitchLlmImpl,
      skipCache: true,
    },
  );

  assert.equal(res.status, 'partial');
  assert.equal(res.companyProfile, null);
  assert.ok(res.decisionMakerProfile);
  assert.ok(res.accroche);
  assert.equal(res.accroche.discApplied, true);
});

// ─── Scénario 4 : timeout LLM pitch → accroche null, reste du profil intact

test('pipeline — pitch LLM throw → profil conservé, accroche null', async () => {
  const apiGouvImpl = async () => ({
    siren: '111111111',
    nomEntreprise: 'X',
    activiteDeclaree: 'Conseil',
  });
  const scraperImpl = async () => ({ texts: [], visitedPages: [], elapsedMs: 0 });
  const searchImpl = async () => ({ results: [], elapsedMs: 0 });
  const discImpl = async () => ({
    primary: 'unknown',
    confidence: 0,
    tone: 'unknown',
    signals: [],
    inferredPainPoints: [],
    costCents: 0,
  });
  const pitchLlmImpl = async () => {
    throw new Error('sonnet timeout');
  };

  const res = await profileProspect(
    {
      siren: '111111111',
      firstName: 'John',
      lastName: 'Doe',
      role: 'CEO',
      companyName: 'X',
      companyDomain: 'x.com',
    },
    {
      apiGouvImpl,
      scraperImpl,
      searchImpl,
      discImpl,
      pitchLlmImpl,
      skipCache: true,
    },
  );

  assert.equal(res.status, 'ok'); // A et B ok, seul pitch échoue
  assert.ok(res.companyProfile);
  assert.ok(res.decisionMakerProfile);
  assert.equal(res.accroche, null); // pitch échoué → accroche null, mail dégrade en template neutre
});
