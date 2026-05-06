# Vision plateforme observability Pereneo + Prospérenne — décision PWA à 100%

**Date** : 2026-05-06 (matin)
**Cadre** : Séance phase-1-observability avec Paul
**Statut** : Décision actée Paul, doctrine engagée

---

## Contexte / déclencheur

Nuit du 5→6 mai 2026 : burn anormal Anthropic + crédits Brave épuisés. Diag a posteriori : conjonction de 6 commits du 5 mai + déclenchement du timer `nightlyMonteCarloSmoke` à 4h Paris sur 5 briefs (dont un France entière) avec auto-corrections en cascade. **L'incident a été détecté par Paul, pas par un système de monitoring** — angle mort observability complet sur les fournisseurs payants.

Ce déclencheur a fait remonter une question stratégique plus large : **comment Pereneo construit sa capacité de gouvernance technique au moment où on prépare la commercialisation Prospérenne ?**

---

## Vision — ce qu'on cherche à construire

Une plateforme observability qui transforme Pereneo de "startup qui bricole sa stack agents IA" en **produit avec gouvernance**, et qui devient **feature commerciale différenciante de Prospérenne**.

Pas un outil de monitoring. **L'infrastructure qui rend chaque décision Pereneo et Prospérenne mesurable.**

### Les 6 capacités concrètes activées

#### 1. Réponse en temps réel à toutes les questions DG
Aujourd'hui : 20 minutes pour répondre "combien de leads contactables Morgane". Demain : 2 secondes, dashboard ouvert. Idem pour "qu'est-ce qu'on a consommé cette nuit", "quel consultant est le plus profitable", "quel pattern email a le meilleur taux de bounce", "combien coûte un lead Mila vs un lead Martin".

#### 2. Détection de drift en 5 min, pas 24h
Cette nuit : 5h de burn anonyme. Avec hardstop + alerting : à 5€ cumulés une alerte, à 10€ le robinet se coupe. **Différence entre "on a perdu une nuit de prospection" et "Pereneo perd $500-1000 sans le savoir".**

#### 3. Roadmap technique data-driven, pas intuitive
Aujourd'hui on priorise SMTP probe parce que "ça semble logique". Demain : on saura si le bottleneck est domain_unresolved (60%) ou pattern_uncertain (30%), on calculera le coût marginal d'un lead validé Sonnet vs Haiku, on comparera taux de réponse par angle d'entrée VP. **Sprints engagés par ROI mesuré, pas par hypothèse.**

#### 4. Calibration prompts + seuils en continu
Le seuil confidence 0.80, le polling Dropcontact 90s, le concurrency 3, la cascade `apiGouv → DDG → heuristic → Brave → Dropcontact` — toutes ces décisions sont des magic numbers posées il y a 2 mois. Avec data : chaque magic number devient une variable observable. On voit que 0.80 exclut 70% des candidates, on baisse à 0.65 + SMTP probe, on mesure le bounce réel. **De "code statique calibré une fois" à "système qui apprend".**

#### 5. Différenciation commerciale Prospérenne
Le marché des agents commerciaux IA est saturé : Lemlist, Apollo, Octopus, Lavender, La Growth Machine. Tous vendent **du volume aveugle** : "on vous envoie 1000 mails/mois". Différenciation Prospérenne : **transparence radicale**. Le client a son propre dashboard, voit chaque lead enrichi, chaque appel LLM, chaque coût marginal. Il sait où va son argent. C'est une feature commerciale unique, pas un nice-to-have ops.

Argument de vente : "Vous allez voir ce que votre agent fait, pas seulement ses résultats. Vous savez pourquoi il choisit ce prospect, pourquoi il écrit ce message, combien il vous coûte par lead converti." Aucun concurrent ne le fait — aucun ne le peut.

#### 6. Facturation honnête + scale Prospérenne sans rework
Modèle Prospérenne aujourd'hui : forfait à la louche basé sur intuition. Avec data : facturation **usage-based** = coût technique réel/client/mois + marge transparente = prix juste, défendable, scalable. Permet d'ouvrir à 10 / 50 / 200 clients sans changer la stack.

---

## Décision — PWA Pereneo à 100% (Paul, 6 mai 2026 matin)

Pas Langfuse. Pas Helicone. Pas d'OSS observability tiers. **Construction PWA Pereneo dès que David peut commencer à prospecter** (chantier prioritaire post-déblocage pilote).

### Justification de la décision

| Critère | PWA Pereneo (build) | Langfuse self-hosted (buy OSS) | Décision |
|---|---|---|---|
| Maîtrise stack | 100% | OSS MIT mais soft tiers | ✅ PWA |
| Branding unifié Pereneo / Prospérenne | Total | CSS custom partiel | ✅ PWA |
| Dépendance OSS tierce | Aucune | Risque pivot Langfuse | ✅ PWA |
| Capitalisation compétences front internes | Oui | Limité | ✅ PWA |
| Effort initial | 26-37 j-h sur 3 mois | 2-3 j-h | Langfuse plus rapide |
| Coût licence | 0€ | 0€ | équivalent |
| Coût infra | Marginal (PWA Pereneo de toute façon) | 30-45 €/mois | ✅ PWA (déjà payé) |
| Multi-tenant Prospérenne | À coder (auth + scoping) | Natif (1 projet par client) | Langfuse plus rapide |

**Décision Paul** : maîtrise + branding + zéro lock-in pèse plus que les semaines de dev gagnées. La PWA Pereneo était au backlog stratégique depuis longtemps — autant en faire le vaisseau-amiral observability.

### Que reste-t-il pour Phase 1 (livrée 6 mai)

Pas de PWA dans Phase 1. On a livré la **base de données et l'infrastructure d'ingestion** que la PWA consommera plus tard :

- Storage Tables `Budgets` (PartitionKey provider + RowKey YYYYMMDD daily) — alimentée à chaque appel
- Application Insights traces structurées `anthropic.call <json>` — KQL-parsable
- Workbooks AI (queries prêtes dans `infra/observability/anthropic-burn-queries.md`)
- Azure Monitor scheduled-query-alert pour le hardstop budget
- Hook Charli `~/.charli/actions/YYYY-MM-DD.jsonl` — log unifié de mes actions

**La PWA Phase 2 sera essentiellement un frontend React/Next/Vue qui requête ces sources de données.** Pas de backend à reconstruire, pas de migration de données. L'investissement Phase 1 est intact.

---

## Compétences à acquérir / structurer

### En interne (Paul + Constantin + moi)

- **Observability / SRE mindset** : raisonner SLI ("99% des leads enrichis en < 5 min"), SLO, alerting, runbooks. Compétence rare en France, vaut cher T2 2026 et au-delà. Aujourd'hui on bricole ; demain on doit raisonner SLO comme on raisonne marges en compta.
- **LLM Ops** : prompt versioning, A/B testing systematic, cost/quality tradeoff. Compétence émergente, peu de seniors français, on se met en avance avec cette plateforme.
- **Product analytics** : taux de conversion par étape du funnel agent. Différent du tech analytics. Implique de poser les questions business avant les questions techniques.

### À recruter ou externaliser à terme (T3-T4 2026)

- **1 profil SRE/DevOps temps partagé** : maintenance plateforme + dashboards + alertes. Aujourd'hui Charli + Paul portent ça en mode bricolage. À 10+ clients Prospérenne ce n'est plus tenable.
- **1 profil Data Scientist / LLM Engineer** : optimisation cost/quality, A/B tests, analyse data. Pas urgent, à anticiper.

### Compétences COMEX que ça structure

- **Reporting mensuel COMEX automatique** : Olivier et Constantin reçoivent un rapport "voici le mois Pereneo : N leads contactés, X € dépensés, Y € facturés (futur), top 3 alertes, top 3 wins". Tu passes de "Paul me dit qu'il y a un souci" à "j'ai lu le rapport, je sais où agir". Plus de COMEX rétroactif.
- **Roadmap COMEX data-backed** : "on doit prioriser X parce que c'est 60% du burn" devient une phrase qu'on prononce en COMEX, pas une intuition.

---

## Risques / contraintes

### Phase 1 (livrée)
- **Mem0 timeouts récurrents** ce matin (4 incidents en 12h). À investiguer côté Container App `mem0-mcp-charli`. La doctrine "fichiers de transmission" du system prompt Charli s'est avérée utile.
- **Maintenance Workbooks** : le portail Azure n'est pas versionné — les Workbooks doivent être recréés à la main. Dans la PWA on aura cette infra-as-code.

### Phase 2 PWA (à venir)
- **RGPD** : la PWA stockera des données prospects (SIRENs + dirigeants + emails). Hébergement France obligatoire (déjà OK avec Azure France Central).
- **Sécurité multi-tenant Prospérenne** : auth scoping client par client à coder soigneusement. C'est exactement le risque que Langfuse aurait évité (multi-tenant natif). On l'accepte volontairement pour maîtrise.
- **Maintenance ongoing** : ~1j/mois bug fixes + features une fois en prod. À budgéter sur le temps Constantin / dev futur.
- **Compétences front à mobiliser** : on a la stack tech, pas forcément l'expérience produit-frontend industrielle. Apprentissage en marchant ou recrutement ponctuel.

---

## Ce qu'on perdrait si on ne faisait pas

- **Pereneo opérationnel** : continuer à brûler 500-2000€/mois en burns anonymes. Sur 12 mois : 6-24 k€ perdus, plus que le coût d'infra Langfuse pour 5 ans.
- **Prospérenne commercial** : lancer le produit avec un pricing devinette + dashboard maison à construire (3 mois) + pas de différenciation tracée. Concrètement : on retarde la commercialisation Prospérenne de 6 mois, OU on ouvre avec une promesse non tenable (= churn), OU on facture à perte.
- **COMEX gouvernance** : continuer à décider à l'intuition. Sur 6 décisions stratégiques par trimestre, statistiquement on en rate 1-2 par défaut d'information. Coût opportuniste : énorme et invisible.

---

## Roadmap

### Phase 1 — livrée 6 mai 2026 matin (cette session)
- Cap budget Pereneo GLOBAL 10€/jour multi-providers
- Tracking Anthropic (assertDailyBudget + trackSpend + log structuré)
- Workbooks AI KQL + Azure Monitor alerte 80%
- Hook Charli PostToolUse → JSONL local
- 938 tests verts, déployé FA `pereneo-mail-sender`

### Phase 1.5 — à compléter (à reprendre)
- Étendre `assertBudget` au call site Dropcontact (aujourd'hui Dropcontact est sur monthly seul, pas dans le pereneo-total daily)
- Étendre au call site SMTP probe quand intégré (Sprint 2)
- Workbook portail créé manuellement à partir des KQL prêtes

### Phase 2 — PWA Pereneo (chantier prioritaire post-déblocage David)
- **Déclencheur** : David capable de prospecter (Sprint 2 SMTP probe + Sprint 3 resolveDomain durci livrés)
- **Stack à arbitrer** : Next.js / Nuxt / SvelteKit / autre — pas tranché
- **Phase 2.1** (1ère version) : dashboard cost + tokens basique pour Pereneo interne
- **Phase 2.2** : traces sessions (1 brief consultant = 1 trace timeline avec spans agents + LLM + Mem0)
- **Phase 2.3** : multi-tenant Prospérenne (1 client = 1 projet isolé, auth scoping)
- **Effort estimé total** : 26-37 j-h sur 3 mois

### Phase 3 — exploitation Prospérenne (post-pilote validé)
- Pricing usage-based avec marge transparente
- Dashboard exposable au client final
- Reporting mensuel COMEX automatique
- A/B tests systematic prompts + seuils

---

## Décisions doctrinales actées dans cette session

| Décision | Validité | Source |
|---|---|---|
| Orthographe officielle : **Prospérenne** (1 'r', 2 'n') | Permanent | Paul 6 mai matin |
| Pricing Prospérenne **inchangé** jusqu'à GO COMEX explicite | Jusqu'à révision | Paul 6 mai matin |
| **Budget Pereneo 10€/jour GLOBAL** multi-providers (pas par provider) | Permanent jusqu'à révision | Paul 6 mai matin |
| **Doctrine build vs buy** : challenger systématiquement les buys quand l'écart d'effort raisonnable et multi-tenant pas immédiat | Permanent | Paul 6 mai matin |
| **PWA Pereneo à 100%** pour observability (pas Langfuse / Helicone / OSS tiers) | Permanent jusqu'à révision | Paul 6 mai matin |
| **Brave retiré** définitivement du défaut cascade webSearch | Jusqu'à crédit Brave revenu (improbable) | Paul 6 mai matin |
| **Cap quotidien plutôt que mensuel** pour les fournisseurs LLM/data | Permanent | Paul 6 mai matin |

---

## Posture DG validée

Paul a explicitement validé la posture (6 mai matin, "c'est bien Charli") sur le format **vision → 6 capacités concrètes → compétences → risques → décision attendue** pour les questions stratégiques DG larges. À reproduire pour les futures questions stratégiques (vs format tactique court pour exécution pure).

---

## Premier réflexe en session de reprise

Lire dans cet ordre :
1. `docs/handovers/2026-05-06-cloture-session-phase-1.md` — état technique précis
2. `docs/strategy/2026-05-06-pwa-observability-vision.md` — ce document, vision et décisions
3. `docs/handovers/2026-05-06-smtp-probe-sprint-2.md` — Sprint 2 SMTP probe à attaquer

Puis confirmer Mem0 healthy avant tout :
```bash
charli  # ouvre une session, Mem0 testé à l'init
```
