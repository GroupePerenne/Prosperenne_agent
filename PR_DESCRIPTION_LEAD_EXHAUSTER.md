# Lead Exhauster v1.0 — résolution email autonome depuis SIREN

> Chantier 2 Péreneo. Branche `feat/lead-exhauster` basée sur `feat/lead-selector`.
> Spec : `SPEC_LEAD_EXHAUSTER_v1_0.md` + `SPEC_AB_TESTING_v1_0.md` + `ARCHITECTURE_v5_1.md` §7.13.

## Résumé

Module autonome `shared/lead-exhauster/` qui résout l'email professionnel du décideur commercial d'une entreprise cible à partir d'un SIREN, sans inventer, avec seuil de confidence ≥ 0.80. Intégré end-to-end dans le pipeline David/Martin/Mila : brief consultant → `selectCandidatesForConsultant` → boucle `leadExhauster` → `launchSequenceForConsultant`.

Inclut le composant transverse `shared/experiments/` pour le tagging A/B (consommé par ce chantier, extensible pour `prospect-profiler`).

## Jalons livrés

| Jalon | Scope | Commits |
|---|---|---|
| Jalon 1 | Fondations schemas + patterns + adapter interface + Dropcontact squelette + resolveDomain + trace LeadContacts | c4ccbac b160534 00be9cc b15c3a3 |
| Jalon 2 | scraping + linkedin signal + resolveDecisionMaker + resolveEmail + orchestrateur câblé + 5 scénarios intégration | b4a4b34 0064dc6 fcac9de f261e09 |
| Jalon 3 | Experiments module + Dropcontact HTTP/budget/circuit breaker + path additif leadSelector (siren DTO + selectCandidates) + enrichBatch orchestrateur + hook reportFeedback + smoke script | a8473a7 00f2e63 dac221c 26943d0 da0d167 |
| Jalon 4 | Extension LeadContacts naf/tranche + patterns-learner Timer hebdo + tests | 0cb4553 130c0cf |

## Architecture

### Pipeline lead-exhauster (SPEC §3.3)

```
leadExhauster({ siren, beneficiaryId, firstName?, lastName?, companyName?, ... })
  ↓
[étape 0] lookup cache LeadContacts (TTL 90 jours)
  ↓ miss
[étape 1] resolveDomain (API gouv recherche-entreprises, fallback input)
  ↓
[étape 2] scrape domaine une seule fois (réutilisé par DM + Email)
  ↓
[étape 2b] resolveDecisionMaker (rescore INSEE vs scrapé pour PME ≥ 20)
  ↓
[étape 3] resolveEmail (patterns + scraping + LinkedIn signal)
  ↓ unresolvable
[étape 4] cascade Dropcontact (pay-on-success, budget mensuel, circuit breaker)
  ↓
[étape 5] trace LeadContacts + return
```

### Intégration pipeline existant

`functions/runLeadSelectorForConsultant/` et `functions/onQualification/` passent maintenant par `enrichBatchForConsultant` qui enchaîne :

```
selectCandidatesForConsultant (batchSize × 3 pool)
  → pour chaque candidat : leadExhauster + experimentsContext
  → enriched = 1 Lead par exhauster.status='ok'
  → unresolvable → table EmailUnresolvable
  → stop dès batchSize enriched atteint
```

Path additif validé par Paul comme extension du scope §5 : `shared/leadSelector.js` gagne `selectCandidatesForConsultant` + `extractCandidateFromEntity` + champ `siren` dans le DTO. `selectLeadsForConsultant` reste intacte et testée en non-régression.

### Hook de feedback qualité

Chaque envoi ou réception de mail appelle `leadExhauster.reportFeedback` en fire-and-forget :

- `shared/worker.js` → `delivered` après chaque `sendMail` réussi (J0, J+4/J+10/J+18/J+28)
- `agents/david/orchestrator.js` → `replied` sur positive/question/neutre/negative, `bounced` sur handleBounceAction

Les feedbacks alimentent `LeadContacts.feedbackStatus` puis `patterns-learner` hebdo (dimanche 3h UTC).

### A/B testing transverse

`shared/experiments/` expose :
- `assignVariant(expId, entityId, variants)` — hash SHA-256 déterministe stateless
- `getActiveExperiments(context)` — lecture Azure Table `Experiments` avec cache 5 min
- `buildExperimentsContext({ siren, beneficiaryId, naf, tranche })` → `ExperimentsContext`

Câblé dans `enrichBatch` et propagé dans `LeadContacts.experimentsApplied`. Aucune expérience n'est activée dans ce chantier — `Experiments.status='draft'` par défaut, activation en flip de config par Charli/Paul post-merge.

## Critères Done (SPEC §13)

- [x] Tous les modules `shared/lead-exhauster/*` créés conformes §3.1
- [x] Tables `LeadContacts`, `EmailPatterns`, `EmailUnresolvable`, `Budgets`, `Experiments` schémas documentés (création à la volée par les writers)
- [x] `leadExhauster(input)` retourne l'output §3.2 conforme sur 7 scénarios intégration (5 SPEC + 2 bonus cache/simulated)
- [x] Adapter Dropcontact fonctionnel avec budget cap + circuit breaker
- [x] Intégration dans `runLeadSelectorForConsultant` + `onQualification` via `enrichBatchForConsultant`
- [x] A/B testing tagging câblé (non activé)
- [x] Zéro secret commité (`grep` clean)
- [x] `npm test` vert sur toute la suite (existante + nouveaux tests) — **394/394**
- [x] `scripts/exhauster-smoke.js --dry-run` exit 0
- [ ] `scripts/exhauster-smoke.js --real` exit 0 sur 3-5 SIRENs validés par Paul (à exécuter en binôme avec Paul post-merge en staging)
- [x] `patterns-learner` Timer Function déployable (CRON dimanche 3h UTC)
- [x] ReportFeedback hook opérationnel (delivered/bounced/replied)
- [x] Documentation inline (JSDoc) sur toutes les fonctions publiques + typedefs (LeadExhausterInput/Output, EmailPatternRow, LeadContactRow, EnrichBatchResult, BudgetRow, EmailUnresolvableRow)
- [x] Diff main limité au scope + `runLeadSelectorForConsultant/index.js` + `onQualification/index.js` + path additif `leadSelector.js` + hook orchestrator/worker

## Fichiers

### Nouveaux (29)

```
shared/lead-exhauster/
  index.js                    orchestrateur public
  schemas.js                  typedefs + constantes
  patterns.js                 8 bootstrap + normalisation
  resolveDomain.js            API gouv + scraping
  resolveDecisionMaker.js     rescore INSEE vs scrapé
  resolveEmail.js             patterns + scraping + LinkedIn
  scraping.js                 fetch + extraction emails/profils
  linkedin.js                 signal public conservateur V1
  trace.js                    LeadContacts writer/reader
  unresolvableTrace.js        EmailUnresolvable writer
  budget.js                   Budgets check/update atomic
  enrichBatch.js              orchestrateur high-level + mail insuffisance
  patternsLearner.js          core learner pur testable
  adapters/interface.js       contrat EmailExternalAdapter
  adapters/dropcontact.js     HTTP batch + polling + budget + breaker

shared/experiments/
  index.js                    API publique
  assign.js                   hash SHA-256 déterministe
  registry.js                 lecture Azure Table + cache 5 min
  tag.js                      buildExperimentsContext + wrapContext

functions/
  patternsLearner/index.js    Timer dimanche 3h UTC

scripts/
  exhauster-smoke.js          --dry-run + --real --yes

tests/unit/lead-exhauster/
  patterns.test.js            30
  resolveDomain.test.js       17
  dropcontact.test.js         20
  scraping.test.js            36
  linkedin.test.js            10
  resolveDecisionMaker.test.js 21
  resolveEmail.test.js        11
  orchestrator.test.js        16
  patternsLearner.test.js     23

tests/unit/experiments/
  assign.test.js              11
  registry.test.js            11
  tag.test.js                 7

tests/unit/leadSelector/
  select-candidates.test.js   14

tests/integration/
  lead-exhauster/full-pipeline.test.js  7 scénarios
  experiments/end-to-end.test.js        5 scénarios
```

### Modifiés (8)

```
shared/leadSelector.js                          Path additif b (siren DTO + selectCandidates)
functions/runLeadSelectorForConsultant/index.js Bascule sur enrichBatchForConsultant
functions/onQualification/index.js              defaultTriggerLeadSelector nouveau flow
agents/david/orchestrator.js                    Hook reportFeedback dans 5 handlers + splitPersonName
shared/worker.js                                reportExhausterDelivered après sendMail
tests/unit/leadSelector/sector-mapping.test.js  1 assertion étendue (siren dans DTO)
tests/functions/onQualification.test.js         neutralise fire-and-forget (hotfix)
.env.example                                    variables exhauster + Dropcontact + tables
```

## Tests

**394/394 verts** (159 existants + 235 nouveaux). Sortie brute `npm test` :

```
1..394
# tests 394
# suites 0
# pass 394
# fail 0
```

Zéro appel réseau réel dans les tests automatiques. Dropcontact strictement désactivé (`DROPCONTACT_ENABLED=false`). Seul `scripts/exhauster-smoke.js --real --yes` appelle vraiment Dropcontact — lancement manuel uniquement.

## Variables d'environnement ajoutées

Voir `.env.example`. Principales :

```
LEAD_EXHAUSTER_CONFIDENCE_THRESHOLD=0.80
LEADCONTACTS_TABLE=LeadContacts
EMAIL_PATTERNS_TABLE=EmailPatterns
EMAIL_UNRESOLVABLE_TABLE=EmailUnresolvable
BUDGETS_TABLE=Budgets
EXPERIMENTS_TABLE=Experiments
RECHERCHE_ENTREPRISES_API_URL=https://recherche-entreprises.api.gouv.fr
DROPCONTACT_API_KEY=<Key Vault>
DROPCONTACT_ENABLED=false
DROPCONTACT_MONTHLY_BUDGET_CENTS=2400
DROPCONTACT_COST_PER_LOOKUP_CENTS=3
LEAD_SELECTOR_CANDIDATE_MULTIPLIER=3
```

## Points de surveillance post-merge

1. **candidateMultiplier=3** — si le taux d'enrichissement observé pendant le pilote Morgane/Johnny est < 30 %, remonter à 5. Env var `LEAD_SELECTOR_CANDIDATE_MULTIPLIER`.
2. **DROPCONTACT_COST_PER_LOOKUP_CENTS=3** — valeur basée sur plan Starter 1000/24€. À re-documenter dans `MEMO §9` si changement de plan commercial Dropcontact.

## Décisions Paul actées

- Cascade externe = Dropcontact (pas Hunter) — match rate, bounce rate, souveraineté FR
- Seuil confidence 0.80 par défaut
- V1 France uniquement
- API gouv `recherche-entreprises.api.gouv.fr` exclusive (pas Pappers)
- Pay-on-success Dropcontact (cost_cents=0 si email non trouvé)
- Budget mensuel V1 = 24€ (Starter 1000 crédits)
- Pas d'invention d'email sous aucun prétexte
- Path additif b' validé comme extension de scope SPEC §5 (pas une modification)

## Règles R-J respectées

- R-J0 Finalité : chaque commit sert la résolution email depuis SIREN
- R-J00 Discernement : docs lues avant code
- R-J1 Chemins absolus : vérifié dans tous les bash
- R-J7 Environnement : CLAUDE_CODE_SETUP + ARCHITECTURE + MEMO + STRATEGY lus avant docs métier
- R-J8 Voie normale : zéro bidouille, zéro contournement (fix pré-existant test onQualification hotfix propre sur feat/lead-selector)
- R-J9 (nouvelle) : sortie brute `npm test` à chaque rapport de jalon

## Non-régression

`selectLeadsForConsultant` legacy reste intacte. Test dédié `select-candidates.test.js:non-régression` vérifie explicitement que sa meta shape contient `excludedNoEmail` et pas `excludedNoDirigeant` ni `source`.

Fix pré-existant (commit `d9e4c45` sur `feat/lead-selector`) : `onQualification.test.js` — hotfix 13 lignes qui neutralise le fire-and-forget Lead Selector par défaut dans les tests. Root cause identifiée : le commit `86c3a2b` a introduit le fire-and-forget sans mettre à jour le test `Mem0 storeConsultant throw`.

## Hors scope V1 (à différer)

- Signatures mining reçues (ARCHITECTURE §7.13 étape 1)
- ML profond des patterns (§7.13.3 avancé)
- Enrichissement au-delà de l'email (phone, mobile, adresse perso)
- Multi-pays
- Migration vers Postgres (cache reste Azure Table V1, migration prévue semaine 18 avec Mem0 self-hosted)
- UI admin Cockpit pour consulter `LeadContacts`

## Smoke réel à exécuter avec Paul

Le script accepte soit les SIRENs hardcodés par défaut (OSEYS + 2 cas de test), soit un fichier JSON via `--sirens <path>`. Un échantillon de 5 SIRENs LeadBase curés est livré dans `scripts/smoke-sirens-sample.json`.

Format du fichier JSON :
```json
[
  {
    "siren": "384989208",
    "denom": "COMPAGNIE PHOCEENNE D EQUIPEMENTS MULTISITES",
    "naf": "62.02A",
    "trancheEffectif": "03",
    "ville": "MARSEILLE",
    "siteWeb": null,
    "dirigeant": { "prenom": "Jean Francois", "nom": "PAPAZIAN", "fonction": "73" }
  }
]
```

Commandes :

```
# Dry-run avec le sample (validation structure, pas d appel réseau)
node scripts/exhauster-smoke.js --dry-run --sirens scripts/smoke-sirens-sample.json

# Smoke réel avec le sample (vraie cascade Dropcontact)
DROPCONTACT_ENABLED=true \
  DROPCONTACT_API_KEY=<clé> \
  AzureWebJobsStorage='<conn string staging>' \
  node scripts/exhauster-smoke.js --real --yes --sirens scripts/smoke-sirens-sample.json
```

### Dettes post-merge identifiées lors de l extraction SIRENs

1. **API gouv `recherche-entreprises` ne remonte pas `site_web`** dans la réponse standard (0/35 SIRENs testés lors de l extraction sample). `resolveDomain` retourne systématiquement `null` quand `companyDomain` n est pas fourni en input. Conséquence : la cascade maison (scraping ciblé site entreprise) ne peut pas démarrer sans domain source alternatif. À corriger post-merge : soit autre endpoint API gouv, soit fallback Google site-restricted, soit enrichissement LeadBase côté Constantin. Flaggé MEMO §14.

2. **`fonction` dirigeant en code INSEE numérique brut** (73=dirigeant, 65=DG, 30=gérant, 53=président) et non libellé texte dans LeadBase. `resolveDecisionMaker.inseeRole` consomme la string brute. Non-bloquant pour Dropcontact (firstName+lastName+siren suffisent), mais rescore PME ≥ 20 sera approximatif. À corriger post-merge via table de correspondance code INSEE → libellé. Flaggé MEMO §14.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
