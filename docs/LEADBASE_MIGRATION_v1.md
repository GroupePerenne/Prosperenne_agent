# LEADBASE_MIGRATION v1.0 — Procédure migration legacy → v1

> Procédure d'exécution de la migration capital scrapé legacy LeadBase → schéma v1 (Bloc 3 chantier refonte).
>
> **Rédigé** : 2026-05-07 PM (Charli, Bloc 3).
> **Statut** : v1.0. Procédure prête, **exécution prod réservée à GO Paul/COMEX**.
> **Cohérence** : `LEADBASE_SCHEMA_v1.md` v1.1 §8.3 + `LEADBASE_LESSONS_v1.md` invariants I-1, I-9, I-10.

---

## 1. Objectif

Migrer le **capital scrapé** présent en LeadBase legacy (siteWeb, dirigeants RNE, audit `*At`) vers le schéma v1 conforme :
- Renommage `rne_checked_at` (snake_case) → `rneCheckedAt` (camelCase strict).
- Injection `migratedFromLegacyAt` audit pour traçabilité.
- Audit `*At` posé si manquant en legacy (I-10 enforcement).

**Ce que la migration ne fait PAS** :
- Ne supprime rien (non-destructive).
- Ne touche pas aux entrées sans `schema_version='1.0'` (filtre I-2 strict).
- Ne crée pas d'entrée nouvelle (I-1 contrat couches : Couche 1 SIRENE seule autorisée).
- Ne migre pas les `emailDirigeant` legacy directs vers LeadContacts (palier ultérieur).

---

## 2. Pré-requis avant exécution

| Pré-requis | Vérification |
|---|---|
| LeadBase v1 SIRENE peuplée | Run `scripts/sirene-bulk-import.js --departement 75` au moins une fois (ou cron mensuel actif) |
| `LEADBASE_STORAGE_CONNECTION_STRING` env présent | `echo $LEADBASE_STORAGE_CONNECTION_STRING \| head -c 30` ne doit pas être vide |
| Tests verts en local | `npm test` — 1100+ verts, 0 fail |
| Branche `feat/leadbase-v2-refonte` mergée sur main | `git log main --oneline \| grep "leadbase v1"` |
| Heures creuses (≥21h Paris ou weekend) | Cohérent CLAUDE.md §1.1 anti-régression |

---

## 3. Procédure étape par étape

### 3.1 Dry-run — comptage et audit sans write

```bash
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
node scripts/migrate-legacy-capital-to-v1.js --dry-run
```

**Sortie attendue (exemple)** :
```
=== Migration capital scrapé legacy → LeadBase v1 ===
Source : pereneoleadsst…[redacted]
[migrate] runId=migrate-2026-05-XXTYY-...
[migrate] mode=DRY-RUN limit=aucune

=== Résumé migration ===
runId           : migrate-2026-05-XX...
scanned         : 27408       # nombre d'entrées schema_version=1.0
needsMigration  : XXX         # nombre avec capital legacy à normaliser
migrated        : 0           # dry-run, aucun write
capitalRne      : XXX         # entrées avec dirigeants peuplé
capitalWeb      : XXX         # entrées avec siteWeb peuplé
elapsedMs       : XXXXX
```

**Critère décisionnel** : si `needsMigration` est 0 ou très petit (< 5%), la migration n'apporte rien — skip. Si `needsMigration` est significatif (≥ 5%), continuer §3.2.

### 3.2 Limit-run — test sur échantillon réduit

```bash
node scripts/migrate-legacy-capital-to-v1.js --limit 100
```

**Critères succès** :
- `errored = 0`
- `migrated > 0`
- Audit `LeadBaseMigrationRuns` table contient le run.

Vérifier manuellement quelques entrées migrées via Storage Explorer ou Azure portal :
- Colonne `rneCheckedAt` présente (camelCase).
- Colonne `migratedFromLegacyAt` présente.
- Colonne `rne_checked_at` legacy **toujours présente** (rétrocompat 30j).

### 3.3 Full-run — migration complète

```bash
# Heures creuses obligatoires
node scripts/migrate-legacy-capital-to-v1.js
```

Durée estimée : `scanned × 50ms` ≈ 1-3 min sur 27 408 leads Paris, plus si France entière.

**Critères succès** :
- Exit code 0.
- `errored = 0`.
- `migrated` ≈ `needsMigration` (taux d'échec marginal acceptable < 1%).

### 3.4 Audit post-migration

```bash
# Audit intégrité prod (Bloc 1 §11.4)
node scripts/audit-leadbase-integrity.js --limit 1000

# Vérifier que I-1 violations = 0
```

---

## 4. Plan de rollback

**Cas A — Migration mal exécutée, peu de changements** : la migration n'est pas destructive. Le capital legacy reste présent en parallèle. Pour annuler une migration ratée, il suffit de supprimer les colonnes `rneCheckedAt` (camelCase) et `migratedFromLegacyAt` posées par le script. Les colonnes `rne_checked_at` legacy n'ont pas été touchées.

**Cas B — Migration cause des bugs aval** : le script ne supprime aucune donnée. Il ajoute des colonnes camelCase et un audit. Les readers conformes v1 lisent `rneCheckedAt` ; les readers legacy lisent `rne_checked_at`. Pas de bug logique attendu.

**Cas C — Storage corrompu pendant migration** : le snapshot Storage Account `pereneoleadsst` n'a pas été pris (Bloc 1 a dégagé Phase 1 snapshot). Pour rollback complet, il faudrait re-merger la branche de pré-migration. Cas hypothétique très peu probable car les writes sont individuels Merge.

---

## 5. Post-migration — chantiers à enchaîner

| Étape | Quand | Action |
|---|---|---|
| Migration emails legacy → LeadContacts v1 | Sous-palier suivant Bloc 3 | Identifier les SIRENs avec `emailDirigeant` direct en LeadBase, créer entrées LeadContacts v1 conformes |
| Suppression colonnes legacy (`rne_checked_at`, etc.) | T+30j post-migration | Script de cleanup non-prioritaire |
| Bascule consommateurs (Bloc 4) | Quand v1 est complète et stable | AirWorker, lead-exhauster, smoke, David repointés |

---

## 6. Audit `LeadBaseMigrationRuns`

Toute exécution est tracée dans la table `LeadBaseMigrationRuns` (créée à la volée).

Schéma audit :
```
PartitionKey  : YYYY-MM-DD
RowKey        : migrate-YYYY-MM-DDTHH-MM-SS-Z-XXXXXXXX
runId         : idem RowKey
startedAt     : ISO 8601
endedAt       : ISO 8601
elapsedMs     : number
countersJson  : JSON { scanned, needsMigration, migrated, skipped, errored,
                       capitalRne, capitalWeb, capitalLinkedIn }
mode          : 'dry-run' | 'full'
```

---

## 7. Garanties d'invariants

| Invariant | Enforcement |
|---|---|
| **I-1** Contrat couches | Helper `safeMergeCoucheN` refuse write si Couche 1 v1 absente/non-conforme. Audit dans `LeadBaseIntegrityViolations`. |
| **I-2** Discrimination origine | Filtre `composeDiscriminantFilter()` schema_version='1.0' au scan (serveur-side). |
| **I-3** Filtre serveur-side | Filtre I-2 propagé via `safeListLeadBaseEntities`. |
| **I-9** Sémantique unique | Migration par couche distincte (RNE / Web / LinkedIn séparés). Patch RNE ne touche pas Web et inversement. |
| **I-10** Audit `*At` | `rneCheckedAt` / `siteWebLastCheckedAt` injectés à la date de migration si absent en legacy. `migratedFromLegacyAt` posé pour audit. |

---

*v1.0 — figé 2026-05-07 PM. Charli, Bloc 3 chantier refonte LeadBase v1.*
