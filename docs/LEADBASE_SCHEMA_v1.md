# LEADBASE_SCHEMA v1.0

> Schéma de référence figé de la table `LeadBase` Pereneo et de son cluster de tables liées.
> Source de vérité unique pour tout writer/reader de la base. Toute modification suit la procédure de versioning §11.
>
> **Rédigé** : 2026-05-07 (Charli, refonte LeadBase v1, branche `feat/leadbase-v2-refonte`).
> **Statut** : v1.0 — figé. Première implémentation conforme livrée par Bloc 2 du chantier refonte.
> **Cohérence** : `ARCHITECTURE_v6.0` §invariants (1) template+config, (2) règles métier en config externalisée, (3) intégrations derrière adapters, (4) credentials jamais en clair.

---

## 1. Objectif et cadrage

`LeadBase` est la base commune Pereneo des entreprises françaises ciblables, alimentée par ingestion SIRENE INSEE et enrichie en couches successives par les workers Pereneo. Cette doctrine fixe :

- Le schéma figé de `LeadBase` : colonnes, types, NULLability, owner writer.
- Les tables liées du cluster : `LeadContacts`, `SireneIngestionRuns`, `EmailPatterns`, etc.
- La convention de write : 1 writer par couche, jamais d'override silencieux entre couches.
- La politique de migration future via `schema_version`.

**Hors scope v1** : refonte des tables liées (LeadContacts, EmailPatterns, etc.) — elles sont documentées en l'état mais leur évolution n'est pas dans ce palier.

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
│ LEADCONTACTS (table liée, Couche 4 Email — schéma préservé hors scope v1)    │
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
    + Experiments + LeadSelectorTrace (cluster lead-exhauster, hors scope v1)
```

---

## 3. Identifiants

### 3.1 PartitionKey

`partitionKey` = code département de l'établissement siège.

Format :
- Métropole : 2 chiffres `01` à `95`, ou `2A` / `2B` pour la Corse.
- DOM : 3 chiffres `971` à `976`.

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

## 8. Couche 4 — Email (table liée LeadContacts)

**Statut v1.0** : la couche email **ne s'écrit pas dans LeadBase**. Elle vit dans la table dédiée `LeadContacts`, jointe à LeadBase par SIREN.

**Writer** : `lead-exhauster` (`shared/lead-exhauster/`).
**Politique** : un SIREN dans LeadBase peut avoir 0, 1 ou N entrées dans LeadContacts (un email par contact résolu).

**Schéma LeadContacts (préservé hors scope v1)** :

```
PartitionKey = siren
RowKey       = email_{normFirstName}_{normLastName}  (normalisé : lowercase, sans accents, non-alpha → "_")
                                                     (catch-all : email__)
Colonnes :
  siren, email, confidence (0-1), source (cf. SOURCES enum),
  signals (JSON array), cost_cents,
  firstName, lastName, role, roleSource, roleConfidence,
  domain, domainSource (cf. DOMAIN_SOURCES enum),
  naf, tranche,
  resolvedAt (ISO), lastVerifiedAt (ISO),
  feedbackStatus (null|'delivered'|'bounced'|'replied'|'spam_flagged'), feedbackAt (ISO),
  experimentsApplied (JSON), beneficiaryId
```

**Évolution v2** : refonte du schéma LeadContacts pour cohérence avec LeadBase v1 (camelCase strict, schema_version, audit owner). Backlog refonte LeadContacts à ouvrir post-Bloc 4.

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

### 10.1 Un writer par couche

Chaque colonne est owned par exactement un writer. Aucun autre code ne doit écrire dans les colonnes d'une couche dont il n'est pas owner. Liste des writers et de leurs colonnes owned : §5 à §9.

**Conséquence** : toute écriture LeadBase doit utiliser un Merge sur sous-ensemble de colonnes (`updateEntity` mode `Merge`), jamais Replace.

### 10.2 Pas d'override silencieux

Un writer qui détecte qu'une colonne owned est déjà peuplée par un run précédent peut :
- L'**ignorer** (idempotent) si la valeur fraîche est identique.
- La **mettre à jour** si plus récente (audit `*At` à actualiser).
- **Jamais** écraser silencieusement avec une valeur dégradée (ex. ne jamais écraser `siteWeb` peuplé par un `null` car la résolution a échoué cette fois — au lieu de ça, n'écrire que `siteWebLastCheckedAt`).

### 10.3 Identifiants imposés

Le writer Couche 1 (SIRENE) est seul autorisé à créer une entrée. Les writers Couches 2-5 ne créent jamais d'entrée — ils ne font que `Merge`. Si une entrée n'existe pas dans LeadBase au moment du write Couche 2-5, le writer doit logger un warning et skipper.

### 10.4 Audit *At

Toute écriture d'une couche doit poser le timestamp d'audit correspondant (`sireneSourcedAt`, `rneCheckedAt`, `siteWebLastCheckedAt`). Permet le diagnostic de fraîcheur et le calcul de TTL pour skip-replay.

---

## 11. Tests d'intégrité

### 11.1 Tests automatisés (CI sur PR LeadBase)

Tests TDD à ajouter dans `tests/unit/leadbase/`, lancés par `npm test` (intégration au pipeline GitHub Actions à venir).

| Test | Vérification |
|---|---|
| `schema-v1.test.js` | Une entrée v1.0 valide possède toutes les colonnes Couche 1 NON-NULL listées §5. |
| `pk-rk-format.test.js` | `partitionKey` matche `/^([0-9]{2}|2A|2B|97[1-6])$/`. `rowKey` matche `/^[0-9]{9}$/`. |
| `tranche-codes.test.js` | `trancheEffectif` ∈ codes INSEE TEFEN valides. |
| `naf-format.test.js` | `codeNaf` matche `/^[0-9]{2}\.[0-9]{2}[A-Z]?$/`. |
| `sireneRunId-trace.test.js` | Tout `sireneRunId` présent en LeadBase a un audit dans `SireneIngestionRuns`. |
| `writer-isolation.test.js` | Pour chaque writer, vérifie qu'il n'écrit que dans ses colonnes owned (mock TableClient). |
| `schema-version-required.test.js` | Toute entrée a `schema_version` non vide. |

### 11.2 Tests d'intégrité table en production

Script `scripts/audit-leadbase-integrity.js` (à créer Bloc 1) : scan complet de LeadBase, agrège les violations par catégorie. À lancer hebdomadairement en heures creuses, alerter sur drift > 0.1%.

Catégories de violations détectées :
- Entrées sans `schema_version`.
- `partitionKey` / `rowKey` invalides.
- `trancheEffectif` hors valeurs INSEE.
- `siteWeb` peuplé sans `siteWebSource` (writer fautif).
- Couche 2-5 peuplée sans Couche 1 sous-jacente complète.

---

## 12. Évolutions futures

### 12.1 Migrations de schéma

- v1.0 → v1.1 : ajout de colonnes optionnelles. Les entrées v1.0 restent valides. Le writer migrant pose `schema_version='1.1'` au passage.
- v1.x → v2.0 : changement structurant (ex. renommage `dept` PK → `region` PK). Document `LEADBASE_SCHEMA_v2.md` requis avec procédure de migration documentée + script de migration testé.

### 12.2 Multi-tenant Prospérenne

À horizon Tranche 8 (commercialisation Prospérenne), le filtrage tenant se fait **côté lecture**, pas côté écriture LeadBase. La table reste mono-tenant Pereneo (base commune). Chaque tenant client (OSEYS, futurs clients Prospérenne) lit à travers une vue filtrée selon sa cible (NAF + tranche + département).

**Conséquence** : aucun champ `tenantId` n'est ajouté à LeadBase. Si nécessaire, un mapping tenant↔config sera dans une table de config dédiée (ex. `TenantConfigs`).

### 12.3 Backlogs ouverts en lien

- Refonte schéma LeadContacts (cohérence camelCase + schema_version) — post-Bloc 4 chantier refonte.
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

*v1.0 — figé 2026-05-07. Première implémentation conforme via Bloc 2 du chantier refonte LeadBase v1 (branche `feat/leadbase-v2-refonte`). Charli, DG Pereneo.*
