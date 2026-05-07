# LEADBASE_SCHEMA v1.1

> Schéma de référence figé de la table `LeadBase` Pereneo, de la table liée `LeadContacts` (Couche 4 Email refondue v1) et du cluster d'audit.
> Source de vérité unique pour tout writer/reader de la base. Toute modification suit la procédure de versioning §11.
>
> **Rédigé** : 2026-05-07 (Charli, refonte LeadBase v1, branche `feat/leadbase-v2-refonte`).
> **Révision v1.1** : 2026-05-07 PM — intégration des invariants doctrinaires I-1 à I-10 de `LEADBASE_LESSONS_v1.md`, refonte LeadContacts intégrée dans le scope (mandat Paul anti-silos), tests d'intégration et E2E permanents en CI.
> **Statut** : v1.1 — figé. Première implémentation conforme livrée par Blocs 2-3 du chantier refonte.
> **Cohérence** : `ARCHITECTURE_v6.0` §invariants + `LEADBASE_LESSONS_v1.md` §4 invariants I-1 à I-10 + `INVARIANTS_PERENEO_v1.md`.

---

## 1. Objectif et cadrage

`LeadBase` est la base commune Pereneo des entreprises françaises ciblables, alimentée par ingestion SIRENE INSEE et enrichie en couches successives par les workers Pereneo. Cette doctrine fixe :

- Le schéma figé de `LeadBase` : colonnes, types, NULLability, owner writer.
- Le schéma figé de `LeadContacts` (Couche 4 Email) : table liée, refonte intégrée v1, **pas un silo séparé**.
- Les tables d'audit du cluster : `SireneIngestionRuns`, `LeadBaseMigrationRuns`, `EmailPatterns`, etc.
- La convention de write : 1 writer par couche, jamais d'override silencieux entre couches.
- La politique de migration future via `schema_version`.
- Le rattachement aux **invariants doctrinaires I-1 à I-10** (cf. `LEADBASE_LESSONS_v1.md`) qui régissent la cohérence E2E du système.

**Décision de scope (révisée 7 mai 2026 PM, mandat Paul "arrêter les silos")** : LeadContacts (Couche 4 Email) est **dans le scope v1**, pas en backlog différé. Refondre LeadBase propre sans toucher à LeadContacts reproduirait précisément le silo qu'on cherche à éliminer.

---

## 2. Vue d'ensemble du cluster

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ LEADBASE (table principale)                                                  │
│ PartitionKey = département (75, 13, 2A, 974, ...)                            │
│ RowKey       = siren (9 chiffres)                                            │
│                                                                              │
│ ┌─ Couche 1 — Identité SIRENE ────────────────── writer: sireneIngestion ─┐  │
│ │  siren, nom, sigle, codeNaf, categorieJuridique, trancheEffectif*,      │  │
│ │  adresse, codePostal, ville, dateCreation, prenomDirigeant*,            │  │
│ │  nomDirigeant*, sireneSourcedAt, sireneSnapshotVersion, sireneRunId     │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Couche 2 — RNE Dirigeants ─────────────── writer: enrich-leadbase-rne ─┐  │
│ │  dirigeants (JSON), rneCheckedAt                                        │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Couche 3 — Web siteFinder ──────────────── writer: enrich-sites-cont. ─┐  │
│ │  siteWeb, siteWebConfidence, siteWebSource, siteWebProofType,           │  │
│ │  siteWebVersion, siteWebValidatedAt, siteWebLastCheckedAt,              │  │
│ │  siteFinderResult, siteFinderAttempts, siteFinderCacheHits,             │  │
│ │  siteFinderCostCents, siteFinderMeta, siteFinderOk, siteFinderSkipped   │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Couche 5 — LinkedIn (FUTUR, placeholder) ────────── writer: TBD ──────┐  │
│ │  companyLinkedInUrl, linkedInResolvedAt                                  │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
│ ┌─ Système ────────────────────────────────────── writer: tous (read-only)┐  │
│ │  partitionKey, rowKey, schema_version, etag (Azure intrinsèque)         │  │
│ └─────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘

         ▲ jointure SIREN (PK LeadContacts = RK LeadBase)
         │
┌────────┴─────────────────────────────────────────────────────────────────────┐
│ LEADCONTACTS (table liée, Couche 4 Email — REFONDUE EN v1, cf. §8)           │
│ PartitionKey = siren                                                         │
│ RowKey       = email_{firstName}_{lastName} normalisé                        │
│ Colonnes : email, confidence, source, signals, cost_cents, firstName,        │
│            lastName, role, roleSource, roleConfidence, domain, domainSource, │
│            naf, tranche, resolvedAt, lastVerifiedAt, feedbackStatus,         │
│            feedbackAt, experimentsApplied, beneficiaryId                     │
└──────────────────────────────────────────────────────────────────────────────┘

Tables d'audit et de cache (cluster, hors LeadBase elle-même) :
  • SireneIngestionRuns  (audit run ingestion, owner Couche 1)
  • LeadBaseMigrationRuns (audit migration legacy → v1, one-shot Bloc 3)
  • EmailPatterns + EmailBlacklistedPatterns + EmailUnresolvable + Budgets
    + Experiments + LeadSelectorTrace (cluster lead-exhauster, schémas préservés)
```

---

## 3. Identifiants

### 3.1 PartitionKey

`partitionKey` = code département de l'établissement siège.

Format (regex stricte cohérente avec départements français valides) :
- Métropole : `01`-`19`, `21`-`95` (le `20` est remplacé par `2A`/`2B` Corse).
- DOM : `971`-`976`.
- Regex : `/^(0[1-9]|1[0-9]|2[1-9]|[3-8][0-9]|9[0-5]|2A|2B|97[1-6])$/` (cf. `shared/leadbase/schema-v1.js`).

Calcul : `extractDepartement(codePostal)` (cf. `shared/sirene/mapper.js`).

**Justification** : la distribution de partitions par département reste équilibrée (Paris 75 ≈ 200k entrées sweet spot, autres départements de 2k à 80k) et permet un scan parallèle naturel pour les workers.

### 3.2 RowKey

`rowKey` = `siren` (9 chiffres). Garantit l'unicité par entreprise et l'idempotence sur ré-ingestion.

### 3.3 Conséquence

Une entreprise = une entrée unique dans `LeadBase`, identifiable par `{partitionKey, rowKey}`. Les workers qui lisent par SIREN seul doivent connaître le département (cf. enrichissement RNE qui maintient un index ou scan global).

---

## 4. schema_version

Chaque entrée porte une colonne `schema_version` (string, ex. `"1.0"`) renseignée par le writer ayant créé l'entrée.

**Politique** :
- v1.0 : version livrée par ce document.
- v1.x (mineure) : ajout de colonnes optionnelles (NULL toléré pour les entrées antérieures).
- v2.0 (majeure) : changement structurant, requiert une procédure de migration documentée dans `LEADBASE_SCHEMA_v2.md`.

Le schema_version permet aux readers de gérer la rétrocompatibilité par branchement explicite, plutôt que par tests de présence ad-hoc sur chaque colonne.

---

## 5. Couche 1 — Identité SIRENE

**Writer** : `sireneIngestion` (Function App timer mensuel + ingestion bulk one-shot via `scripts/sirene-bulk-import.js`).
**Source** : OpenDataSoft `economicref-france-sirene-v3` (miroir public INSEE dump SIRENE).
**Politique de write** : Merge sur les colonnes owned uniquement. Préserve les colonnes des autres couches.

| Colonne | Type | NULL | Description |
|---|---|---|---|
| `siren` | string(9) | non | SIREN 9 chiffres. Identifiant unique de l'unité légale. |
| `nom` | string | non | Dénomination INSEE. Prio : `denominationunitelegale` > `denominationusuelle1` > prénom+nom (EI) > sigle > enseigne. |
| `sigle` | string | oui | Sigle officiel INSEE. |
| `codeNaf` | string(5\|6) | non | Code NAF/APE de l'établissement (ex. `70.22Z`). Source SIRENE `activiteprincipaleetablissement`. |
| `categorieJuridique` | string(4) | oui | Code catégorie juridique INSEE (ex. `5710` = SAS). |
| `trancheEffectif` | string(2) | non | Code INSEE TEFEN tranche d'effectif salarié (ex. `12` = 20-49). |
| `trancheEffectifLabel` | string | oui | Label texte brut OpenDataSoft (audit anti-drift). |
| `adresse` | string | oui | Adresse postale composée (numéro + voie). |
| `codePostal` | string(5) | non | Code postal de l'établissement. |
| `ville` | string | oui | Libellé commune. |
| `dateCreation` | string(YYYY-MM-DD) | oui | Date de création de l'unité légale. |
| `prenomDirigeant` | string | oui | Prénom du dirigeant (renseigné UNIQUEMENT pour les entreprises individuelles — sociétés via Couche 2 RNE). |
| `nomDirigeant` | string | oui | Nom du dirigeant EI. |
| `sireneSourcedAt` | string(ISO 8601) | non | Timestamp de l'ingestion. |
| `sireneSnapshotVersion` | string(YYYY-MM) | non | Mois du dump INSEE source (ex. `2026-05`). |
| `sireneRunId` | string | non | UUID/ID du run d'ingestion. Trace dans `SireneIngestionRuns`. |
| `schema_version` | string | non | Version du schéma au moment de l'écriture (ex. `1.0`). |

**Filtres d'ingestion** : appliqués en amont de l'ingestion (config externalisée, multi-tenant ready), pas dans le mapper.
- Sweet spot tranche par défaut : `['03', '11', '12']` (6-49 salariés OSEYS) — overridable via `SIRENE_TRANCHES_INCLUDE`.
- Exclusions NAF : `shared/mappings/naf-exclusions.json` (structures publiques, etc.).
- Filtre `etablissement actif siège` : oui par défaut.

---

## 6. Couche 2 — RNE Dirigeants

**Writer** : `enrich-leadbase-continuous.js` (worker continu, Mac Air dédié à terme déplaçable Container App).
**Source** : `https://recherche-entreprises.api.gouv.fr` (API gouv.fr, free, no auth).
**Politique de write** : Merge `dirigeants` + `rneCheckedAt` uniquement. Ne touche jamais aux colonnes Couche 1.

| Colonne | Type | NULL | Description |
|---|---|---|---|
| `dirigeants` | string (JSON array) | oui | Liste sérialisée des dirigeants RNE : `[{nom, prenom, role, dateNaissance?, ...}]`. `[]` si aucun match RNE. `null` si jamais checké. |
| `rneCheckedAt` | string(ISO 8601) | oui | Timestamp du dernier appel API. Utilisé pour TTL skip 30j (`RNE_CHECK_TTL_DAYS`). |

**Note** : la colonne actuelle dans le code est `rne_checked_at` (snake_case). v1.0 normalise vers `rneCheckedAt` (camelCase) pour cohérence avec le reste du schéma. **Migration prévue** dans Bloc 3 du chantier refonte.

---

## 7. Couche 3 — Web siteFinder

**Writer** : `enrich-sites-continuous.js` / cluster site-finder (`shared/site-finder/`).
**Source** : multi-source (DDG search heuristique + scraping + validation siren-on-page) — voir `docs/SITE_FINDER_v1.md` (à rédiger en cohérence).
**Politique de write** : Merge sur colonnes Couche 3 uniquement. Ne touche jamais Couches 1, 2, 5.

### 7.1 Données métier (publiables)

| Colonne | Type | NULL | Description |
|---|---|---|---|
| `siteWeb` | string | oui | URL canonique du site officiel (ex. `https://oseys.fr`). |
| `siteWebConfidence` | number(0-1) | oui | Score de confiance de la résolution. |
| `siteWebSource` | string | oui | Source de résolution : `ddg_search`, `linkedin_signal`, `scraping`, `manual`. |
| `siteWebProofType` | string | oui | Preuve trouvée : `siren_on_page`, `naf_match`, `denomination_match`, `redirect_official`. |
| `siteWebVersion` | string | oui | Version interne de l'algo site-finder (ex. `2.1`). |
| `siteWebValidatedAt` | string(ISO 8601) | oui | Timestamp de la dernière validation positive. |
| `siteWebLastCheckedAt` | string(ISO 8601) | oui | Timestamp de la dernière tentative (positive ou négative). |

### 7.2 Audit interne worker (non-publiable)

| Colonne | Type | NULL | Description |
|---|---|---|---|
| `siteFinderResult` | string | oui | Code résultat : `found`, `no_result`, `skipped_aggregator`, `error`. |
| `siteFinderAttempts` | number | oui | Compteur tentatives cumulé. |
| `siteFinderCacheHits` | number | oui | Compteur cache hits. |
| `siteFinderCostCents` | number | oui | Coût cumulé en centimes (ex. requêtes payantes futures). |
| `siteFinderMeta` | string (JSON) | oui | Métadonnées libres pour debug. |
| `siteFinderOk` | boolean | oui | Dernière résolution réussie (booléen). |
| `siteFinderSkipped` | boolean | oui | Skip volontaire (ex. blacklist). |

---

## 8. Couche 4 — Email (table liée LeadContacts) — **REFONDUE EN v1**

**Décision v1 (révision 7 mai PM, mandat Paul anti-silos)** : LeadContacts est **dans le scope v1**, refondue avec cohérence stricte LeadBase v1 (camelCase, `schema_version`, audit `*At`, contrat de couches I-1).

**Writer** : `lead-exhauster` (`shared/lead-exhauster/`). Adapter à amender Bloc 3 pour conformité v1.

**Politique** : un SIREN dans LeadBase peut avoir 0, 1 ou N entrées dans LeadContacts. **LeadContacts ne crée jamais une entrée pour un SIREN absent de LeadBase v1** (enforcement I-1 contrat de couches strict).

### 8.1 Identifiants

```
PartitionKey = siren (9 chiffres)
RowKey       = email_{normFirstName}_{normLastName}
              (normalisation : lowercase, sans accents, non-alpha → "_")
              (catch-all : email__)
```

### 8.2 Colonnes v1 (camelCase strict, schema_version, audit *At)

| Colonne | Type | NULL | Description | Évolution depuis legacy |
|---|---|---|---|---|
| `siren` | string(9) | non | SIREN, redondant avec PK pour requête. | inchangé |
| `email` | string | non | Adresse email résolue. | inchangé |
| `confidence` | number(0-1) | non | Score de confiance. | inchangé |
| `source` | enum | non | `internal_patterns` / `internal_scraping` / `google_site` / `linkedin_signal` / `dropcontact` / `cache`. | inchangé |
| `signals` | string (JSON array) | oui | Traçabilité (signaux émis pendant la résolution). | inchangé |
| `costCents` | number | non | Coût en centimes (0 si internal). | **renommé** `cost_cents` → `costCents` |
| `firstName` | string | oui | Prénom décideur. | inchangé |
| `lastName` | string | oui | Nom décideur. | inchangé |
| `role` | string | oui | Rôle (gérant, président, DG...). | inchangé |
| `roleSource` | enum | oui | `insee` / `website` / `linkedin_entreprise` / `google`. | inchangé |
| `roleConfidence` | number(0-1) | oui | Confiance sur le rôle. | inchangé |
| `domain` | string | oui | Domaine résolu. | inchangé |
| `domainSource` | enum | oui | `leadbase` / `api_gouv` / `google` / `scraping` / `input`. | inchangé |
| `naf` | string | oui | Code NAF (snapshot lu de LeadBase Couche 1). | inchangé |
| `tranche` | string | oui | Code tranche INSEE (snapshot lu de LeadBase Couche 1). | inchangé |
| `resolvedAt` | string(ISO 8601) | non | Timestamp première résolution. **Audit obligatoire (I-10).** | inchangé |
| `lastVerifiedAt` | string(ISO 8601) | oui | Timestamp dernière vérification. | inchangé |
| `feedbackStatus` | enum | oui | `null` / `delivered` / `bounced` / `replied` / `spam_flagged`. | inchangé |
| `feedbackAt` | string(ISO 8601) | oui | Timestamp dernier feedback reçu. | inchangé |
| `experimentsApplied` | string (JSON) | oui | Tags A/B testing. | inchangé |
| `beneficiaryId` | string | non | Scoping cache/billing/audit (tenant Pereneo cible). | inchangé |
| `schema_version` | string | non | Version schéma de cette entrée (ex. `1.0`). | **NOUVEAU v1.0** |
| `leadBaseSchemaVersion` | string | non | Version LeadBase de l'entrée SIREN parente au moment du write. Permet de détecter les LeadContacts orphelines après évolution LeadBase. | **NOUVEAU v1.0** |

### 8.3 Migration legacy LeadContacts → v1 (Bloc 3)

1. Renommage colonne `cost_cents` → `costCents` sur tout nouveau write. Lecture rétrocompat tolérée 30j (lecteur essaie `costCents` puis `cost_cents`).
2. Ajout `schema_version='1.0'` sur tout write nouveau.
3. Ajout `leadBaseSchemaVersion` snapshoté au moment du write.
4. Test E2E (I-1) : un write LeadContacts doit échouer + warning si le SIREN n'existe pas dans LeadBase v1.
5. Audit migration dans `LeadBaseMigrationRuns`.

### 8.4 Tables liées du cluster lead-exhauster (préservées v1.0)

`EmailPatterns`, `EmailBlacklistedPatterns`, `EmailUnresolvable`, `Budgets`, `Experiments`, `LeadSelectorTrace` : schémas existants préservés. Tables **internes au cluster lead-exhauster**, non exposées aux autres workers. Refonte éventuelle relève d'un palier ultérieur (`LEADCONTACTS_SCHEMA_v2.md`).

---

## 9. Couche 5 — LinkedIn (futur)

**Statut v1.0** : placeholder réservé. Aucun writer en production aujourd'hui.

**Colonnes prévues** (à confirmer lors de l'implémentation) :

| Colonne | Type | NULL | Description |
|---|---|---|---|
| `companyLinkedInUrl` | string | oui | URL canonique LinkedIn entreprise. |
| `companyLinkedInResolvedAt` | string(ISO 8601) | oui | Timestamp dernière résolution. |
| `companyLinkedInSource` | string | oui | Provider : `proxycurl`, `phantombuster`, `apify`, `scraping_direct`. |

Décision provider en attente arbitrage Paul (cf. backlog "R&D Maillon 6 enrichissement décideur" CLAUDE.md §10).

---

## 10. Convention de write

> Cette section opère les invariants doctrinaires I-1, I-2, I-3, I-9, I-10 définis dans `LEADBASE_LESSONS_v1.md`. Toute violation est testée en CI (cf. §11) ou auditée en prod (`scripts/audit-leadbase-integrity.js`).

### 10.1 Un writer par couche (I-9)

Chaque colonne est owned par exactement un writer. Aucun autre code ne doit écrire dans les colonnes d'une couche dont il n'est pas owner. Liste des writers et de leurs colonnes owned : §5 à §9.

**Conséquence** : toute écriture LeadBase doit utiliser un Merge sur sous-ensemble de colonnes (`updateEntity` mode `Merge`), jamais Replace.

### 10.2 Pas d'override silencieux

Un writer qui détecte qu'une colonne owned est déjà peuplée par un run précédent peut :
- L'**ignorer** (idempotent) si la valeur fraîche est identique.
- La **mettre à jour** si plus récente (audit `*At` à actualiser).
- **Jamais** écraser silencieusement avec une valeur dégradée (ex. ne jamais écraser `siteWeb` peuplé par un `null` car la résolution a échoué cette fois — au lieu de ça, n'écrire que `siteWebLastCheckedAt`).

### 10.3 Contrat de couches strict (I-1)

Le writer Couche 1 (SIRENE) est seul autorisé à **créer** une entrée. Les writers Couches 2-5 ne créent jamais d'entrée — ils ne font que `Merge`.

**Précondition obligatoire** : avant tout write Couche N≥2, le writer doit vérifier que la Couche 1 de l'entrée cible est peuplée et conforme (siren valide, schema_version présent, trancheEffectif et codeNaf renseignés). Si non conforme :
- Refus de write.
- Warning structuré logué (`safeLog` obligatoire).
- Audit posé dans `LeadBaseIntegrityViolations` (table d'audit dédiée à créer Bloc 1 suite).

**Pas de demi-entrée jamais.** Cette discipline est testée en CI (cf. §11.1 `i1-couche1-prerequisite.test.js`).

### 10.4 Audit `*At` obligatoire (I-10)

Toute écriture d'une couche doit poser le timestamp d'audit correspondant (`sireneSourcedAt`, `rneCheckedAt`, `siteWebLastCheckedAt`, `resolvedAt`). Permet diagnostic de fraîcheur, calcul de TTL pour skip-replay, audit intégrité, alerting sur dérive.

Tests CI (§11.1) vérifient que tout write Couche N pose son `*At`.

### 10.5 Discrimination origine obligatoire côté lecture (I-2)

**Tout reader LeadBase** (lead-selector, AirWorker, smoke, dailyDigest, audit) **doit filtrer explicitement** par :
- `schema_version='1.0'` (au minimum, pour exclure le legacy non-conforme).
- Plus discriminant si applicable : `sireneRunId IS NOT NULL`, `dept`, `trancheEffectif`, etc.

**Aucun read autorisé sans discriminant.** Toute mesure ou rapport doit préciser le périmètre lu (`schema_version='1.0' AND dept='75'` etc.).

Test CI (§11.1) `i2-reader-discriminant.test.js` détecte les readers qui scannent sans `schema_version` ou `sireneRunId` (lint via grep AST sur les `listEntities` calls).

### 10.6 Filtres serveur-side prioritaires (I-3)

Tout filtre métier (NAF, tranche, dept, schema_version, sireneRunId) **doit** s'appliquer côté requête :
- Storage Tables : `queryOptions.filter` OData.
- OpenDataSoft : paramètre `where`.

Le filtre client-side après scan complet est interdit pour les filtres métier connus à l'avance. Exception tolérée : filtre dérivé d'une jointure ou calcul complexe non exprimable en OData.

Test CI (§11.1) `i3-server-side-filter.test.js` bench scan filtré server-side vs scan complet → server-side doit être > 50× plus rapide.

### 10.7 Sémantique unique par colonne (I-9)

**Aucune colonne LeadBase ne porte deux sémantiques distinctes selon le contexte.** Si deux notions différentes : deux colonnes distinctes.

**Application v1 stricte** : `prenomDirigeant` / `nomDirigeant` (Couche 1 SIRENE) sont **réservés aux entreprises individuelles uniquement**. Les sociétés ont leurs dirigeants dans `dirigeants` (Couche 2 RNE) **uniquement**. Tout reader voulant "le dirigeant" doit consulter les deux selon `categorieJuridique`.

Toute PR ajoutant une colonne LeadBase doit faire l'objet d'une revue explicite contre cet invariant.

### 10.8 Multi-source obligatoire (I-4, I-5)

**Toute intégration externe critique** (résolution domaine, ingestion SIRENE, dirigeants RNE, email Dropcontact) **doit avoir au moins 1 fallback** de source différente. Mono-source = SPOF interdit, refusé en CI sur tout PR ajoutant ou modifiant un adapter externe.

**Adapters concernés et fallbacks attendus v1** :

| Adapter | Source primaire | Fallback(s) requis |
|---|---|---|
| `resolveDomain` | site-finder heuristique (DDG search) | `recherche-entreprises.api.gouv.fr` (en mode dégradé : SIREN-on-page check), Mojeek search, Ecosia search (cf. `feat(site-finder): cascade multi-backend webSearch`). |
| `sireneIngestion` | OpenDataSoft (`economicref-france-sirene-v3`) | API INSEE directe (`api.insee.fr`), miroir SIRENE alternative (à identifier). |
| `rneEnrichment` | `recherche-entreprises.api.gouv.fr` | `annuaire-entreprises.data.gouv.fr` HTML scraping (mode dégradé), `api.insee.fr` SIRENE individuelle. |
| `dropcontactAdapter` | Dropcontact `/qualification/v2` | Patterns internes + scraping site officiel + LinkedIn signal (`internal_patterns`, `internal_scraping`, `linkedin_signal` de l'enum `SOURCES`). |

**Fallback local pour mémoire externe (I-5)** : toute écriture critique vers une mémoire externe (Mem0, KV, Storage distant) doit avoir un fallback local **avant l'écriture distante** (fichier JSONL, log structuré, queue locale). Si l'écriture distante échoue, le fallback local devient la source de vérité jusqu'à reprise.

**Cas concret v1** : tout `add_memory` Charli vers Mem0 cloud doit d'abord poser le fait dans `~/.charli/fallback/<YYYY-MM-DD>-<topic>.jsonl`. Mem0 down ne perd jamais la mémoire continue. Re-publication automatique à la reprise.

Test CI (§11.2) `i4-multi-source-fallback.test.js` valide chaque adapter contre cet invariant.

---

## 11. Tests d'intégrité

> Cette section enforce les invariants doctrinaires I-1 à I-10 (`LEADBASE_LESSONS_v1.md`) en CI et en audit prod. Trois niveaux : **unitaires schéma** (§11.1), **intégration invariants** (§11.2), **E2E permanents** (§11.3). Tous lancés sur tout PR touchant LeadBase, lead-exhauster, site-finder, sirene-ingestion ou enrich-leadbase.

### 11.1 Tests unitaires schéma (CI obligatoire)

Tests TDD dans `tests/unit/leadbase/`, lancés par `npm test`.

| Test | Vérification |
|---|---|
| `schema-v1.test.js` | Une entrée v1.0 valide possède toutes les colonnes Couche 1 NON-NULL listées §5. |
| `pk-rk-format.test.js` | `partitionKey` matche regex département stricte (cf. §3.1). `rowKey` matche `/^[0-9]{9}$/`. |
| `tranche-codes.test.js` | `trancheEffectif` ∈ codes INSEE TEFEN valides. |
| `naf-format.test.js` | `codeNaf` matche `/^[0-9]{2}\.[0-9]{2}[A-Z]?$/`. |
| `sireneRunId-trace.test.js` | Tout `sireneRunId` présent en LeadBase a un audit dans `SireneIngestionRuns`. |
| `writer-isolation.test.js` | Pour chaque writer, vérifie qu'il n'écrit que dans ses colonnes owned (mock TableClient). |
| `schema-version-required.test.js` | Toute entrée a `schema_version` non vide. |
| `leadcontacts-schema-v1.test.js` | Toute entrée LeadContacts v1 a `schema_version`, `leadBaseSchemaVersion`, `costCents` (pas `cost_cents`), `resolvedAt`. |

### 11.2 Tests d'intégration invariants (CI obligatoire)

Tests dans `tests/integration/leadbase/`, mockent Storage Tables ou utilisent une émulation Azurite locale.

| Invariant | Test | Vérification |
|---|---|---|
| **I-1** Contrat de couches | `i1-couche1-prerequisite.test.js` | Tente write Couche 2/3/4 sur entrée sans Couche 1 conforme → doit échouer + warning `safeLog` + audit `LeadBaseIntegrityViolations`. |
| **I-2** Discriminant lecture | `i2-reader-discriminant.test.js` | Lint AST des `listEntities` calls dans tout le code → tout reader passe `schema_version` ou `sireneRunId` dans `queryOptions.filter`. |
| **I-3** Filtre serveur-side | `i3-server-side-filter.test.js` | Bench scan filtré server-side vs scan complet + filter client-side → ratio > 50× sur sample 100k. |
| **I-4** Multi-source | `i4-multi-source-fallback.test.js` | Pour chaque adapter externe (resolveDomain, RNE, SIRENE, Dropcontact), simule indisponibilité primaire → fallback s'active. |
| **I-7** Time-budget | `i7-time-budget.test.js` | Calcul `polls × delay × concurrency × batch_size` ≤ window FA pour AirWorker / lead-exhauster / sirene-ingestion. |
| **I-8** Cache TTL | `i8-cache-ttl.test.js` | Grep tous les caches du codebase → vérifie qu'un TTL est exposé (positif différent de négatif). |
| **I-9** Sémantique unique | `i9-column-semantics.test.js` | Lit `LEADBASE_SCHEMA_v1.md` §5-9 + grep usages → vérifie `prenomDirigeant` lu seulement avec gate `categorieJuridique` EI. |
| **I-10** Audit `*At` | `i10-audit-at-required.test.js` | Tout write d'une couche pose son timestamp `*At` correspondant (mock TableClient avec spy). |

### 11.3 Tests E2E permanents (CI obligatoire)

Tests dans `tests/e2e/`, lancés sur tout PR touchant la cascade. Cf. `LEADBASE_LESSONS_v1.md` §6.

| Test | Scénario | Critère succès |
|---|---|---|
| `e2e-cascade-complete.test.js` | SIRENE ingestion → RNE enrichissement → siteFinder → lead-exhauster → David `runSequence` (dryRun) | 5 étapes OK en moins de 8 min, échec localisé précisément si plante. |
| `e2e-discrimination-origine.test.js` | LeadBase mix legacy + v1 → tous readers de prod ne lisent QUE `schema_version='1.0'`. | Aucun reader ne remonte une entrée legacy non discriminée. |
| `e2e-fallback-multi-source.test.js` | Simule indispo de chaque source externe une à une (data.gouv 503, OpenDataSoft 503, Dropcontact timeout, RNE 500). | Aucune source seule ne cause un downtime LeadBase. |
| `e2e-budget-temps.test.js` | Run AirWorker complet batch 10 leads avec polls Dropcontact max + scraping max. | Temps total ≤ 8 min (marge 2 min sur fenêtre 10 min FA Consumption). |

### 11.4 Audit intégrité prod (run hebdomadaire)

Script `scripts/audit-leadbase-integrity.js` (à créer Bloc 1 suite) : scan complet de LeadBase, agrège les violations par catégorie. À lancer hebdomadairement en heures creuses (cron Mac Air worker), alerter sur drift > 0.1%.

Catégories de violations détectées :
- Entrées sans `schema_version` (devrait être 0% sur table v1).
- `partitionKey` / `rowKey` invalides.
- `trancheEffectif` hors valeurs INSEE.
- `siteWeb` peuplé sans `siteWebSource` (writer fautif, violation I-9).
- Couche 2-5 peuplée sans Couche 1 sous-jacente complète (violation I-1).
- Entrées LeadContacts orphelines (`leadBaseSchemaVersion` ne matche pas la version actuelle de l'entrée parente).
- Caches sans expiration récente (violation I-8).

Audit historisé dans `LeadBaseIntegrityRuns` (table d'audit). Alerting en cas de dérive : message direct `direction@oseys.fr`.

---

## 12. Évolutions futures

### 12.1 Migrations de schéma

- v1.0 → v1.1 : ajout de colonnes optionnelles. Les entrées v1.0 restent valides. Le writer migrant pose `schema_version='1.1'` au passage.
- v1.x → v2.0 : changement structurant (ex. renommage `dept` PK → `region` PK). Document `LEADBASE_SCHEMA_v2.md` requis avec procédure de migration documentée + script de migration testé.

### 12.2 Multi-tenant Prospérenne

À horizon Tranche 8 (commercialisation Prospérenne), le filtrage tenant se fait **côté lecture**, pas côté écriture LeadBase. La table reste mono-tenant Pereneo (base commune). Chaque tenant client (OSEYS, futurs clients Prospérenne) lit à travers une vue filtrée selon sa cible (NAF + tranche + département).

**Conséquence** : aucun champ `tenantId` n'est ajouté à LeadBase. Si nécessaire, un mapping tenant↔config sera dans une table de config dédiée (ex. `TenantConfigs`).

### 12.3 Backlogs ouverts en lien

- Refonte schéma LeadContacts (cohérence camelCase + schema_version) — **incluse v1.1 §8** (mandat anti-silos).
- Implémentation Couche 5 LinkedIn — arbitrage provider Paul en attente.
- Audit hebdomadaire intégrité (script + alerting) — Bloc 1 du chantier refonte.

---

## 13. Gouvernance

Toute modification de ce document requiert :
1. Une PR sur la branche `feat/leadbase-schema-v{X}` cohérente avec un changement code.
2. Mise à jour des tests d'intégrité §11 si applicable.
3. Validation Charli ou COMEX avant merge.

Versioning : `v1.0` → `v1.1` (mineure) → `v2.0` (majeure). Chaque palier figé dans un fichier distinct (`LEADBASE_SCHEMA_v2.md`) pour préserver l'historique.

---

*v1.1 — figé 2026-05-07 PM. Intégration des invariants doctrinaires I-1 à I-10 (`LEADBASE_LESSONS_v1.md`), refonte LeadContacts dans le scope, tests d'intégration et E2E permanents enforcés en CI. Première implémentation conforme via Blocs 2-3 du chantier refonte (branche `feat/leadbase-v2-refonte`). Charli, DG Pereneo.*
