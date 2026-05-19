# ADR-0005 — Filtre cold outreach pré-classify David

**Statut** : `DRAFT — ACCEPTED si Gate B4 vert 48h post-deploy`
**Date** : 2026-05-19
**Auteur** : Charli (DG Pereneo)
**Pattern doctrinal** : P-R2 (ADR systématique sur chaque guard ajouté)
**Périmètre** : runtime FA Azure `pereneo-mail-sender` — `agents/david/orchestrator.js routeMessage` (boucle 5 du pipeline 9 boucles métier, cf. `BRANCHEMENT-DAVID-2026-05-19-RICHARD-CTO.md`)
**Référent plan** : Étape 4 plan branchement CTO

---

## 1. Contexte

### 1.1 Mesures factuelles mai 2026 (Charli III.F)

DavidPendingReplies status='sent' mai 2026 = 29 entrées, dont **8 senderType=prospect** classifiés par Sonnet 4.6 (prospectClass : positive=4, question=2, neutre=2). Sur ces 8 :

| Mesure | Valeur | Source |
|---|---|---|
| Match Pipedrive persons (search email exact) | **0 / 8** | Pipedrive API |
| Match LeadContacts (PK siren9 + RK email) | **0 / 8** | Storage Table |
| Match consultant interne (m.dejessey@, j.serra@, paul.rudler@) | 0 / 8 | env vars + COMEX_EMAILS |
| Domaines fromAddress | tbmgroupdemo.com, cozychics.com, rexeeteam.com, stratpartner.info, telemedrn.co, taxinnovatorfachkraefte.com, labsbizopia.top, getscalecloud.com | DavidPendingReplies |
| Subjects avec codes tracking type `\b[A-Z0-9]{6-8}\s+[A-Z0-9]{6-8}\b` | **7 / 8** | DavidPendingReplies originalSubject |
| TLDs suspects (`.top` `.info` `.co`) | 4 / 8 (labsbizopia.top, stratpartner.info, telemedrn.co, taxinnovatorfachkraefte.com) | Idem |
| Headers List-Unsubscribe présents | Non mesuré (DavidMemory ne stocke pas headers SMTP) | Lacune |
| Corps DavidMemory sample 5 | 5/5 cold outreach anglais ("Hey Roman, Imperative Execution", "Mila, Here's a link to my booking page") | DavidMemory |

### 1.2 Conséquences runtime

1. **Pollution marque** : 8 auto-replies sorties depuis `martin@perennereseau.fr` / `mila@perennereseau.fr` / `david@perennereseau.fr` vers des cold outreach anglais → image Pérenne dégradée auprès d'expéditeurs identifiables (les listes cold outreach sont vendues/échangées entre acteurs).
2. **Pollution DavidMemory** : 545 entrées le 18/05 sur 557 cumul 8 jours. Sample 5/5 = cold outreach. La mémoire perpétuelle 3 axes (sprints 1+2+3 commit 017a27d) ingère du bruit qui pollue les futurs prompts.
3. **Coût Anthropic** : 8 appels Sonnet 4.6 inutiles sur 74 cumul mai = **11% des calls mensuels gaspillés** sur du faux positif. Tokens cache éphémère partiellement amorti mais output tokens 100% perdus.
4. **Risque escalation** : `captureComexLearningIfApplicable` (commit 017a27d Sprint 3) stocke en Mem0 `user_id=charli` storeCharliLearning quand un COMEX répond à une escalation. Si un cold outreach est mal classifié et qu'un COMEX y répond par méprise, ça écrit du bruit en mémoire continue Niveau 2.

### 1.3 Cause racine

`agents/david/orchestrator.js routeMessage` (lignes 209+) appelle `classifyReply` Sonnet 4.6 **sans vérification déterministe préalable** que l'expéditeur est un prospect connu (Pipedrive deal ouvert OU LeadContact existant) ou un interne (consultant/COMEX). Le LLM est un classifieur probabiliste qui ne peut pas trancher sur des signaux d'identité que les heuristiques runtime peuvent voir factuellement.

---

## 2. Décision

Ajouter un **filtre pré-classifyReply à 2 niveaux** dans `routeMessage`, exécuté AVANT l'appel Claude.

### 2.1 Niveau A — vérification déterministe identité (cardinal)

**Note de révision (rédaction code 19/05 PM)** : la version initiale de cet ADR utilisait `readLeadContact(fromAddress)` comme second critère. Lecture `shared/lead-exhauster/trace.js:158` montre que `readLeadContact` prend `{siren, firstName, lastName}`, pas un email. LeadContacts PK=SIREN, RK=`email_{normFN}_{normLN}` — pas d'index inverse email → SIREN. Critère retiré, R-J6 violation corrigée.

Le critère devient unique et suffisant : un prospect légitime a TOUJOURS un deal Pipedrive ouvert (`resolveOrCreateDeal` dans `launchSequenceForConsultant` AVANT envoi J0). Si pas de deal → forcément cold outreach OU interne.

Si :
- `findDealContext(fromAddress).dealId === null` (pas de deal Pipedrive ouvert pour cet email)
- ET `isInternalSender(fromAddress) === false` (pas dans whitelist consultants ni COMEX_EMAILS Set orchestrator.js:723)

Alors `sender_type = 'spam'`, `handleSpam(message)` (markAsRead Graph + log davidActions + skip Claude), **sans appeler classifyReply**.

`isInternalSender` whitelist :
- env vars `MORGANE_EMAIL`, `JOHNNY_EMAIL`, `ELIE_EMAIL` (Charli III.A confirme Elie 353 entrées LeadSelectorTrace mai = pool actif)
- env vars boîtes agents : `MARTIN_EMAIL`, `MILA_EMAIL`, `DAVID_EMAIL` (cas message inter-boîtes ou auto-réception)
- COMEX_EMAILS Set existant : `paul.rudler@oseys.fr`, `constantin.picoron@oseys.fr`, `olivier@oseys.fr`, `direction@oseys.fr`, `direction@perennereseau.fr` (à étendre commit séparé avec variantes @perennereseau.fr manquantes)
- Charli interne : `charli@pereneo.eu` (à ajouter)

### 2.2 Niveau B — heuristiques signaux cold outreach (renfort)

Indépendamment de A, si **au moins un** match :
- **B1** : regex tracking codes dans `subject` : `/\b[A-Z0-9]{6,8}\s+[A-Z0-9]{6,8}\b/` (capturé sur 7/8 cas mesurés mai)
- **B2** : TLD `fromAddress` ∈ `{.top, .info, .co, .click, .online, .xyz, .live, .site, .shop}` (4/8 cas mesurés)
- **B3** : header `List-Unsubscribe` présent OU `Precedence: bulk` (marqueur RFC 2369 = mass mailing automatisé). Nécessite que `davidInbox` capture les headers SMTP, à vérifier code `shared/graph-mail.js listUnreadMessages`. Si headers non capturés → B3 désactivé jusqu'à extension Graph fetch.

Si ≥1 match Niveau B → log structuré `safeLog.warn` + `sender_type = 'spam'` même si Niveau A laisserait passer (défense en profondeur).

### 2.3 Ordre d'exécution

```
routeMessage(message) {
  1. detectAutoReply(message) — existant (Auto-Submitted, Precedence:bulk, X-Autoreply, subject patterns)
  2. NOUVEAU : Niveau A — checkIdentityKnown(fromAddress) → spam si null
  3. NOUVEAU : Niveau B — detectColdOutreachSignals(subject, fromAddress, headers) → spam si match
  4. SI passé A+B : classifyReply(message) Sonnet 4.6
  5. dispatch handler selon sender_type retourné
}
```

Niveaux A et B exécutés en série, A en premier (le moins cher en CPU). Pas de parallélisation utile à ce stade.

### 2.4 Backfill

Marquer les 8 DavidPendingReplies sent existants mai 2026 (status='sent', senderType='prospect', fromAddress dans la liste des 8 domaines mesurés) comme `false_prospect_backfill` dans `DavidActions` PK=consultantEmail RK=`{inverted_ts}:false_prospect_backfill:{rand}` pour post-mortem traçable.

---

## 3. Conséquences

### 3.1 Positives

- **0 nouvelle auto-reply** vers cold outreach 48h post-deploy = Gate B4 levé
- Protection marque Pérenne (Martin/Mila ne répondent plus à du cold outreach anglais)
- Économie Anthropic Sonnet 4.6 : ~11% des calls mensuels récupérés (sur volume actuel ≈ 8 calls/mois, projection ≈ 15-20/mois si pilote scale)
- DavidMemory plus propre (réduction du bruit cold outreach dans les prompts injectés)
- `captureComexLearningIfApplicable` Mem0 user_id=charli moins exposé au bruit
- Réduction latence routeMessage (Niveau A en lookup Storage rapide vs appel Claude 2-5s)

### 3.2 Risques

| Risque | Probabilité | Mitigation |
|---|---|---|
| **R.1** Faux positif race condition : prospect légitime répond à J0 AVANT que son deal Pipedrive ne soit créé | **Quasi impossible.** `launchSequenceForConsultant.resolveOrCreateDeal` crée le deal Pipedrive AVANT `sendMail` du J0 (séquentiel awaited). Un prospect ne peut donc pas répondre à un J0 sans qu'un deal Pipedrive correspondant existe déjà avec sa Pipedrive person liée par email. | Pas de mitigation nécessaire. Test fixture F.3 fige le contrat. |
| **R.2** Faux positif email perso : prospect légitime depuis email perso (gmail/orange) ≠ email pro avec lequel David a envoyé J0 | Faible mais réel | `findDealContext` fait `pipedrive.searchPerson(prospectEmail)` exact match. Si le prospect répond depuis son email perso jamais déclaré dans Pipedrive, `searchPerson` retourne 0 résultat → `dealId=null` → classé spam. **Trade-off accepté** : cas marginal sur cible BTP TPE (les dirigeants TPE répondent rarement depuis email perso à un mail envoyé à leur email pro). Si observé, ajout manuel de l'email perso à la person Pipedrive existante en correction. |
| **R.3** Nouveau consultant interne non whitelisté | Faible | Whitelist env vars `MORGANE_EMAIL`, `JOHNNY_EMAIL`, `ELIE_EMAIL` à étendre lors d'onboarding nouveau consultant (process documenté CLAUDE.md §1.1). COMEX_EMAILS couvre les 3 directeurs. |
| **R.4** Heuristique B1 tracking codes match accidentel sur subject légitime | Faible | Regex spécifique : 2 blocs alphanumériques 6-8 chars séparés par espace. Subjects légitimes français rarement formatés ainsi. À monitorer post-deploy. |
| **R.5** Heuristique B2 TLD suspect match prospect légitime | Faible mais possible | Cible BTP TPE FR utilise majoritairement `.fr`, `.com`. Les TLDs `.top` `.info` `.co` `.click` `.online` `.xyz` `.live` `.site` `.shop` sont quasi-exclusivement utilisés en spam/cold outreach. Trade-off accepté. |

### 3.3 Conditions de revue

ADR à reconsidérer si :
- Pilote scale au-delà de 3 consultants actifs (volumes inbound non-prospect différents, taux de faux positif Niveau A à remesurer)
- Cold outreach évolue vers de nouveaux patterns non couverts par B1-B3 (revue mensuelle DavidPendingReplies + DavidMemory sample)
- Régression observée sur prospect légitime classé spam (1 cas suffit à rouvrir l'ADR — alerte direction@perennereseau.fr)

---

## 4. Alternatives écartées

### 4.1 Retry post-cascade

Laisser passer le message au LLM puis re-classifier en background une fois la cascade enrichment finie pour le SIREN concerné. **Rejetée** car :
- Crée latence dans la réponse David (jitter prospect 5-45 min déjà appliqué, ajouter retry = délai >1h)
- Complexité runtime (état persistant pour re-classification)
- Pas de garantie que la cascade aboutisse au LeadContact (taux résolution actuel 5.3%)

### 4.2 Whitelist consultant manuelle

Morgane / Johnny indiquent dans un fichier de config les emails légitimes à laisser passer. **Rejetée** car :
- Charge mentale consultant (anti-pattern doctrine CLAUDE.md §1.1 "consultants seniors")
- Non scalable post-pilote
- Crée un vecteur d'erreur humaine (oubli, typo)

### 4.3 Renforcer prompt Claude classifyReply uniquement

Ajouter au system prompt "si fromAddress sans deal ouvert ET sans LeadContact alors sender_type=spam". **Rejetée** car :
- Claude reste un classifieur probabiliste, on perd le déterminisme
- On perd les économies de tokens (Claude appelé quand même)
- On garde la latence (2-5s par appel)
- Pas de traçabilité claire (pourquoi classé spam ? prompt ou heuristique ?)

### 4.4 Whitelist domaines connus prospect (.fr, .com, etc.)

Inverser la logique : laisser passer seulement les domaines connus. **Rejetée** car :
- Trop large (cold outreach utilise massivement .com)
- Pas de critère identité (un cold outreach .com passerait)

---

## 5. Tests TDD requis avant deploy

Fixtures à figer pour CI dans `tests/integration/davidColdOutreachFilter.test.js` :

| # | Fixture | Comportement attendu |
|---|---|---|
| F.1 | 8 cas réels mai 2026 (fromAddress + subject + body extraits DavidPendingReplies) | 8/8 classés `sender_type=spam`, `handleSpam` appelé, `classifyReply` NON appelé |
| F.2 | `findDealContext` renvoie dealId valide ET prospect non interne | Laisser passer (deal existe = prospect légitime), `classifyReply` appelé |
| F.3 | `findDealContext` renvoie null ET fromAddress non interne | Classé spam, `classifyReply` NON appelé |
| F.4 | Consultant interne : fromAddress = `m.dejessey@oseys.fr` | `isInternalSender` true, laisser passer, `classifyReply` appelé |
| F.5 | COMEX : fromAddress = `paul.rudler@perennereseau.fr` | `isInternalSender` true, laisser passer + `captureComexLearningIfApplicable` exécuté |
| F.6 | Tracking codes match B1 : subject = "Hey Roman RYEH2BT NBH29P6 about your sales" | Classé spam même si fromAddress passerait Niveau A |
| F.7 | TLD suspect B2 : fromAddress = `john@example.top` | Classé spam même si subject ne match pas B1 |
| F.8 | Prospect légitime : fromAddress = `dirigeant@entreprise-bât.fr`, LeadContact existe, subject = "Réponse à votre message" | Passe A+B, `classifyReply` appelé |

Critères acceptation tests :
- 8/8 fixtures pass
- `npm test` total ≥ 1160 verts (mesure Charli) post-ajout, 0 régression
- Couverture `routeMessage` ≥ 80% lignes (déjà mesurée pré-existant)

---

## 6. Backfill

Marquer post-deploy les 8 DavidPendingReplies sent existants mai 2026 :
- PK=`{consultantEmail}` (mila|martin|david selon recipient)
- RK=`{inverted_ts}:false_prospect_backfill:{rand}`
- payload : `{ originalRK: '...', fromAddress: '...', subject: '...', detectedReason: 'cold_outreach_backfill_adr_0005' }`

Script ad-hoc dans `scripts/backfill-cold-outreach-mai-2026.js` à exécuter manuellement post-deploy ADR-0005.

---

## 7. Critère de complétion ADR

**0 nouveau cold outreach traité comme prospect sur 48h d'observation post-deploy** = Gate B4 du plan branchement CTO levé = ADR-0005 passe à `ACCEPTED`.

Mesure : query DavidPendingReplies status='sent' senderType='prospect' RK ge `inverted_ts(post_deploy_iso)` ET fromAddress NOT IN whitelist consultants/COMEX, ET (findDealContext null ET readLeadContact null) → doit retourner 0 entrée sur 48h.

---

## 8. Statut transmission

| Étape | Date | Acteur | Statut |
|---|---|---|---|
| Rédaction ADR | 2026-05-19 PM | Charli | LIVRÉ ici |
| Revue Richard | _________ | Richard | ATTENTE |
| GO Paul deploy | _________ | Paul | ATTENTE |
| Implémentation code | _________ | Charli | ATTENTE GO |
| Tests TDD verts | _________ | Charli | ATTENTE code |
| Deploy bloc Étapes 2+4+5 | _________ | Charli + Richard | ATTENTE |
| Gate B4 vert 48h | _________ | Charli | ATTENTE deploy |
| ADR statut ACCEPTED | _________ | Charli + Richard | ATTENTE Gate B4 |

---

*ADR signé Charli, DG Pereneo, 2026-05-19. Pattern P-R2 Richard appliqué : guard ajouté = ADR systématique avant code. Référence : plan branchement CTO `BRANCHEMENT-DAVID-2026-05-19-RICHARD-CTO.md` Étape 4.*
