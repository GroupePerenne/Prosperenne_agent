# LEADBASE_LESSONS v1.0 — Capitalisation des trous de raquette

> Document doctrinaire fondateur. Capitalise les enseignements opérationnels de Pereneo (avril-mai 2026) pour que la refonte LeadBase v1 et toute évolution future ne reproduisent pas les mêmes erreurs.
>
> **Rédigé** : 2026-05-07 (Charli, Bloc 0 du chantier refonte LeadBase v1).
> **Mandat** : "On apprend de nos enseignements, on bétonne la structure du process" (Paul, 7 mai 2026).
> **Statut** : v1.0. Source des invariants intégrés à `LEADBASE_SCHEMA_v1.md` §10 et tests E2E §11.

---

## 1. Pourquoi ce document

Pendant les 3 dernières semaines (lancement pilote David, ingestion SIRENE, refonte cascade aval), Pereneo a accumulé **une série de trous de raquette dont le pattern est récurrent** : chaque couche du système (ingestion, enrichissement, scraping, email) tourne en silo, sans contrat E2E avec les autres. Chaque couche écrit ce qu'elle veut, lit ce qu'elle trouve, et l'ensemble se fissure quand une cascade descend.

Ce document fait **trois choses** :
1. **Inventaire** des trous de raquette observés, avec source factuelle (commit, mémoire, observation).
2. **Synthèse** des causes systémiques récurrentes — les patterns sous les symptômes.
3. **Invariants doctrinaires** qui découlent de ces patterns, à appliquer dans la refonte LeadBase v1 et toute évolution future.

Ce document n'est pas un récit chronologique. Il sert de matière pour le code à venir : chaque invariant a un test E2E associé qui doit échouer si l'invariant est violé.

---

## 2. Inventaire des trous de raquette observés

| # | Symptôme | Source factuelle | Date |
|---|---|---|---|
| 1 | `dirigeants=null` sur 85-90% des leads LeadBase legacy | Commit `fa4df3b`, observation 4 mai 13h30 (Boulogne sample 0/30 dirigeants) | 4 mai |
| 2 | Smoke 7 mai matin sur 27 408 SIRENE Paris : 0 candidats trouvés malgré 351 emails et 3 444 sites peuplés au compteur AirWorker | `project_constat_legacy_restructuration_7mai.md` | 7 mai |
| 3 | `resolveDomain` V1 mono-source plante quand IP Paul bannie de `data.gouv.fr` (7/10 leads `domain.api_gouv_error`) | Task #7, commit `62a7cc9` | 6 mai |
| 4 | Ingestion SIRENE Paris validée (27k OK), smoke E2E 0/10 résolus immédiatement après | `project_etat_pereneo_6mai_pm_fin_seance.md` | 6 mai |
| 5 | Smoke lit `prenomDirigeant` SIRENE (peuplé EI uniquement) au lieu du JSON `dirigeants` RNE peuplé pour les sociétés → 100% `dm.no_candidate` sur sociétés | Handover 6 mai cause #3 | 6 mai |
| 6 | Doublons SIREN possibles entre legacy 12,8M Constantin et SIRENE 27k Paul (politique de write AirWorker non gated) | `feedback_mapping_leadbase_legacy_vs_sirene.md` | 7 mai |
| 7 | AirWorker scrape sur leads `trancheEffectif IN [11,12,21]` mais sans contrat NAF → leads structures publiques (NAF 84.x, 85.x) traités comme cibles OSEYS | Smoke 6 mai, cause #1 | 6 mai |
| 8 | Mem0 timeouts récurrents (search + add) — perte mémoire continue sans fallback local immédiat | Handover 7 mai 0h30 + cette séance 7 mai matin | 6-7 mai |
| 9 | `lead-selector` retournait `errorCode=unknown` 2-4ms à cause de `context.log/warn` perdant leur binding privé entre invocations FA Linux Consumption v4 | BL-45, commit `b3e3459` | 4 mai |
| 10 | Filtre `trancheEffectif` côté client après scan complet → 12,8M scannés au lieu de filtrer côté requête | Commit `19e220e` | 4-5 mai |
| 11 | Dropcontact polls 5×30s = 150s × batch 10 séquentiel = timeout 10min FA Consumption | Commit `75efed4` | 5 mai |
| 12 | `lead-exhauster` tournait sans `DropcontactAdapter` wired en prod depuis le 1er mai (Jalon 3 marqué complet à tort) | Commit `85d5843` | 5 mai |
| 13 | Annuaires (mairie.fr, lagazettefrance, etc.) capturés comme sites officiels par site-finder → mauvais email patterns | Commits `d1eeedd`, blacklist multiples | 5-6 mai |
| 14 | `negativeCache` Dropcontact bloquait les retry sur des leads où email serait résolvable depuis | Commit `6e93b03` | 5 mai |
| 15 | Formulaire onboarding `Failed to fetch` côté Morgane/Johnny sans retry ni diagnostic | Commit `8fbb58a` | 4 mai |
| 16 | `onQualification` mettait 4,2s en fire-and-forget (au lieu de < 1s, opérations bloquantes au mauvais endroit) | Commit `4339df1` | 4 mai |

**16 trous en 3 semaines.** Aucun n'est isolé. Tous relèvent de quelques patterns récurrents identifiés en §3.

---

## 3. Synthèse des causes systémiques

Les 16 trous se rassemblent sous **6 causes systémiques** :

### A. Couches non contractualisées entre elles (#1, #2, #5, #6, #7)
Chaque couche (SIRENE, RNE, web, email) écrit dans LeadBase sans contrat avec les autres. Aucune ne valide que les couches dont elle dépend sont peuplées et conformes. Conséquence : on découvre les incohérences en aval, par cascade qui plante.

### B. Mono-source / SPOF interdit non enforced (#3, #8)
`resolveDomain` mono-source data.gouv plante quand l'IP est bannie. Mem0 timeout = perte mémoire continue. Dans les deux cas, aucun fallback systémique. Le SPOF était identifié en doctrine (`docs/INVARIANTS_PERENEO_v1.md` invariant III-2 anti-SPOF) mais pas enforcé en code.

### C. Test E2E par palier absent (#4, #12)
Ingestion SIRENE Paris validée — smoke 0/10. `lead-exhauster` Jalon 3 marqué complet — adapter pas wired. Dans les deux cas, le palier a été déclaré OK sans test E2E démontrant que la chaîne aval marche.

### D. Filtres et discrimination en aval au lieu d'amont (#7, #10)
Filtre `trancheEffectif` client-side scanne 12,8M au lieu de 200k. AirWorker filtre tranche mais pas NAF, structures publiques traitées comme cibles. **Le filtre métier doit être au plus près de la source.**

### E. Time-budgets et cache TTL non calibrés (#11, #14, #16)
Dropcontact polls dépassent la fenêtre FA. negativeCache sans TTL bloque ad vitam. fire-and-forget bloquant. Aucune calibration explicite des budgets temps et durées de vie.

### F. Sémantique de colonne ambiguë (#5)
`prenomDirigeant` peuplé pour les EI par SIRENE, vide pour les sociétés (qui ont leurs dirigeants en JSON dans `dirigeants` via RNE). Un reader naïf qui lit `prenomDirigeant` voit 100% no_candidate sur sociétés. **Une colonne, une sémantique, point.**

---

## 4. Invariants doctrinaires LeadBase v1

Les invariants suivants sont **opposables au code**. Tout writer/reader LeadBase qui les viole doit échouer en CI, et tout audit prod qui détecte une violation doit alerter.

### I-1 — Contrat de couches strict
**Énoncé** : tout writer Couche N≥2 (RNE, siteFinder, Email, LinkedIn) doit vérifier que la Couche 1 (identité SIRENE) de l'entrée cible est peuplée et conforme **avant** d'écrire. Si non conforme : refus + warning + audit, jamais création silencieuse de demi-entrée.

**Test associé** : `tests/integration/leadbase/i1-couche1-prerequisite.test.js` — tente une écriture Couche 2 sur entrée sans Couche 1 → doit échouer + logger le warning attendu.

**Cas d'origine** : trou #1 (dirigeants null partout), #6 (doublons), #7 (AirWorker hors-cible).

---

### I-2 — Discrimination origine obligatoire
**Énoncé** : tout reader LeadBase doit filtrer **explicitement** par `schema_version` et/ou `sireneRunId IS NOT NULL`. Aucun read autorisé sans discriminant. Toute mesure ou rapport doit préciser le périmètre lu (`sireneRunId IS NOT NULL`, `schema_version='1.0'`, `dept='75'`, etc.).

**Test associé** : `tests/integration/leadbase/i2-reader-discriminant.test.js` — vérifie que tous les readers passent un filtre `schema_version` ou `sireneRunId` (lint via grep).

**Cas d'origine** : trou #2 (351 emails sur legacy hors-cible non discriminés), `feedback_mapping_leadbase_legacy_vs_sirene.md`.

---

### I-3 — Filtres serveur-side prioritaires
**Énoncé** : tout filtre métier (NAF, tranche, dept, schema_version) **doit** s'appliquer côté requête Storage Tables (`queryOptions.filter`, `select`) ou côté requête OpenDataSoft (`where`), pas en mémoire après scan. Le filtre client-side est interdit pour les filtres métier connus à l'avance.

**Test associé** : `tests/integration/leadbase/i3-server-side-filter.test.js` — bench scan filtré server-side vs scan complet + filter client-side → server-side doit être > 50× plus rapide.

**Cas d'origine** : trou #10 (12,8M scannés au lieu de 200k filtrés).

---

### I-4 — Multi-source obligatoire pour intégration critique
**Énoncé** : toute intégration externe critique (résolution domaine, ingestion SIRENE, dirigeants RNE, email Dropcontact) doit avoir **au moins 1 fallback** de source différente. Mono-source = SPOF interdit, refusé en CI sur tout PR ajoutant une intégration externe.

**Test associé** : `tests/integration/external/i4-multi-source-fallback.test.js` — pour chaque adapter externe, simule indisponibilité de la source primaire → vérifie que le fallback s'active.

**Cas d'origine** : trou #3 (`resolveDomain` mono-source data.gouv banni), trou #8 (Mem0 sans fallback local immédiat).

---

### I-5 — Fallback local pour mémoire externe
**Énoncé** : toute écriture critique vers une mémoire externe (Mem0, KV, API gouv, Storage Account distant) doit avoir un fallback local **avant l'écriture distante** (fichier JSONL, log structuré, queue locale). Si l'écriture distante échoue, le fallback local devient la source de vérité jusqu'à reprise.

**Test associé** : `tests/integration/external/i5-local-fallback.test.js` — simule timeout Mem0 → vérifie que le fait à enregistrer est dans `~/.charli/fallback/` (ou équivalent).

**Cas d'origine** : trou #8 (Mem0 timeouts récurrents, perte mémoire continue dans cette séance même).

---

### I-6 — Test E2E par palier obligatoire
**Énoncé** : aucun palier (commit feature, deploy, ingestion bulk, wire d'adapter) n'est déclaré "validé" sans **test E2E correspondant** qui démontre que la chaîne aval reste fonctionnelle. "Ça compile", "tests unit verts", "smoke partiel" ne sont pas des critères suffisants pour un palier structurant.

**Test associé** : convention dans `tests/e2e/` — chaque feature touchant LeadBase ou la cascade aval ajoute un test E2E qui couvre l'intégration complète.

**Cas d'origine** : trou #4 (SIRENE OK + smoke 0/10), trou #12 (Jalon 3 incomplet déclaré complet).

---

### I-7 — Time-budget calibré pour toute opération batch / async
**Énoncé** : toute opération en batch ou fire-and-forget doit avoir un **budget temps total documenté** vs SLA window (ex. FA Consumption 10 min). Calcul explicite : `polls × delay × concurrency × batch_size ≤ window`. Documenté dans le code en commentaire à côté de la constante.

**Test associé** : `tests/unit/exhauster/budget-time.test.js` — calcule le budget temps avec les constantes courantes → fail si > window.

**Cas d'origine** : trou #11 (Dropcontact polls 5×30s × batch 10 = timeout), trou #16 (fire-and-forget 4,2s).

---

### I-8 — TTL obligatoire sur tout cache
**Énoncé** : tout cache (positif ou négatif, lookup ou skip-replay) a un TTL explicite **dans la config**, jamais éternel. Le négatif a un TTL plus court que le positif (ex. 7-30j négatif, 90-365j positif). Re-tentatives automatiques après expiration.

**Test associé** : `tests/unit/cache/i8-ttl-required.test.js` — grep tous les caches du codebase → vérifie qu'un TTL est exposé.

**Cas d'origine** : trou #14 (negativeCache Dropcontact bloquait retry).

---

### I-9 — Sémantique unique par colonne
**Énoncé** : aucune colonne LeadBase ne porte deux sémantiques distinctes selon le contexte. Si deux notions différentes : deux colonnes distinctes. Documentation explicite dans `LEADBASE_SCHEMA_v1.md`.

**Test associé** : revue obligatoire du schéma à chaque PR ajoutant une colonne.

**Cas d'origine** : trou #5 (`prenomDirigeant` SIRENE EI uniquement, sociétés via `dirigeants` JSON RNE — confusion permanente).

**Application v1** : `prenomDirigeant` / `nomDirigeant` sont **réservés aux EI** (Couche 1 SIRENE). Les sociétés ont leurs dirigeants dans `dirigeants` (Couche 2 RNE) **uniquement**. Tout reader qui veut "le dirigeant d'une entreprise" doit consulter les deux selon `categorieJuridique`.

---

### I-10 — Audit `*At` sur tout write
**Énoncé** : toute écriture Couche N pose son timestamp d'audit `<couche>SourcedAt` ou `<couche>CheckedAt` ou `<couche>ValidatedAt`. Permet TTL, debug fraîcheur, audit intégrité, alerting sur dérive.

**Test associé** : `tests/integration/leadbase/i10-audit-at-required.test.js` — vérifie que tout write d'une couche pose son timestamp d'audit.

**Cas d'origine** : pattern systémique observé sur l'absence de fraîcheur dans plusieurs couches (RNE, siteFinder partiellement).

---

## 5. Application aux blocs du chantier refonte LeadBase v1

| Bloc | Invariants à enforcer | Tests E2E obligatoires |
|---|---|---|
| **Bloc 1 — Schéma v1 figé** | I-9 (sémantique unique), I-10 (audit *At) | Tests d'intégrité §11 schéma |
| **Bloc 2 — Pipeline ingestion SIRENE pérenne** | I-2 (discriminant `sireneRunId`), I-3 (filtre serveur-side), I-4 (multi-source SIRENE : OpenDataSoft + INSEE direct fallback), I-7 (budget temps run) | Test E2E ingestion → read back → assert schéma + `sireneRunId` propagé |
| **Bloc 3 — Migration legacy + refonte LeadContacts** | I-1 (Couche 1 prerequisite), I-2 (discriminant), I-9 (sémantique) | Test E2E SIRENE → site finder → email → David peut envoyer (la chaîne complète, pas de pièce isolée) |
| **Bloc 4 — Bascule + smoke E2E final** | I-6 (test E2E avant bascule), critère >30% taux résolution mesuré | Smoke 50 leads cibles bout-en-bout, mesure objective |

---

## 6. Tests E2E obligatoires — la grille permanente

Au-delà des tests par bloc, ces tests E2E doivent tourner en CI sur tout PR touchant LeadBase ou la cascade aval. Ils sont la **grille permanente** qui détecte les régressions de cascade :

### 6.1 Test E2E "ingestion → enrichissement → email → David envoie"

**Scénario** : un SIREN cible (sweet spot 6-49, NAF non exclu) traverse toute la cascade.
1. Ingestion SIRENE → entrée v1.0 conforme dans LeadBase.
2. Enrichissement RNE → `dirigeants` peuplé.
3. Site finder → `siteWeb` peuplé avec `siteWebSource`.
4. Lead exhauster → `LeadContacts` entry créée avec email + confidence ≥ 0.8.
5. David `runSequence` → email J0 envoyé (ou simulé en dryRun).

**Critère succès** : succès des 5 étapes en moins de X minutes (à calibrer sur leads réels).

**Critère échec** : si une étape plante, le test reporte précisément à quelle couche (pas un message générique).

### 6.2 Test E2E "discrimination origine"

**Scénario** : LeadBase contient un mix legacy + SIRENE v1. Tous les readers utilisés en prod (lead-selector, AirWorker, smoke, dailyDigest) doivent ne lire QUE les entrées `schema_version='1.0'`.

**Critère succès** : aucun reader ne remonte une entrée legacy non discriminée.

### 6.3 Test E2E "fallback multi-source"

**Scénario** : on simule l'indisponibilité de chaque source externe une à une (data.gouv banni, OpenDataSoft 503, Dropcontact timeout, RNE 500). À chaque fois, vérifie que la cascade continue avec un fallback ou une dégradation gracieuse.

**Critère succès** : aucune source externe seule ne cause un downtime LeadBase.

### 6.4 Test E2E "budget temps"

**Scénario** : run AirWorker complet sur batch 10 leads avec polls Dropcontact max + scraping max + RNE max. Mesure temps total.

**Critère succès** : temps total ≤ 8 min (marge sur 10 min FA window).

---

## 7. Liens avec autres doctrines

- `docs/INVARIANTS_PERENEO_v1.md` (branche `doc/invariants-pereneo-v1`) — invariants généraux Pereneo (souveraineté runtime, anti-SPOF, cap budget, mesure business, capital permanent, multi-agent). Les I-1 à I-10 ci-dessus sont la **déclinaison opérationnelle** de ces invariants à la couche LeadBase.
- `docs/LEADBASE_SCHEMA_v1.md` (à amender) — incorpore les invariants I-1, I-9, I-10 dans la convention de write §10. Les tests d'intégrité §11 incluent désormais I-2, I-3, I-8, I-10 enforcés en CI.
- `docs/SIRENE_INGESTION_v1.md` (branche `feat/sirene-bulk-import`) — doit s'aligner sur I-3, I-4, I-7 dans le pipeline pérenne Bloc 2.
- `docs/BUDGET_CAP_v1.md` (branche `feat/budget-cap-multi-stack`) — application de I-7 (time-budget) aux budgets API Anthropic et Dropcontact.

---

## 8. Évolution de ce document

`LEADBASE_LESSONS_v1.md` est un document **vivant**. Tout nouveau trou de raquette structurant identifié post-7 mai 2026 doit être ajouté à §2, sa cause systémique versée dans §3, et un nouvel invariant en §4 si le pattern n'est pas déjà couvert. Versioning standard : v1.0 → v1.1 (mineur) → v2.0 (majeur, refonte invariants).

**Critère pour ajouter un nouveau trou** : le symptôme a coûté >30 min de diag ou >1 commit fix. En-dessous, c'est de l'ingénierie courante, pas une leçon.

---

*v1.0 — figé 2026-05-07. Charli, Bloc 0 du chantier refonte LeadBase v1. Pour Paul, Constantin, Olivier (COMEX) — référence permanente de la doctrine d'ingénierie LeadBase Pereneo.*
