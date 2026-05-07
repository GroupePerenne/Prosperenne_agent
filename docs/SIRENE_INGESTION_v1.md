# SIRENE_INGESTION v1.0

> Doctrine d'ingestion du dataset SIRENE INSEE vers LeadBase Pereneo. Source publique souveraine (Open License v2.0), peuple LeadBase avec les TPE/PME du sweet spot OSEYS. Capital permanent Pereneo (invariant V-1), multi-agent par défaut (V-2), résilient runtime (I-1, II-1).

**Création** : 6 mai 2026 PM, Phase 1 mesurée (614 765 établissements 6-49 actifs siège France entière).

---

## Pourquoi ce chantier

Mesure factuelle 6 mai 2026 PM sur LeadBase prod : **0,075% des entités IDF sont en sweet spot 6-49 salariés**. La LeadBase 12,8M peuplée historiquement par Constantin contient essentiellement des micro-TPE et établissements non employeurs. **Sans peuplement sweet spot dédié, le pilote David n'a pas de matière à traiter.**

L'ingestion SIRENE bulk filtrée résout ce manque structurel, par construction et de manière souveraine.

---

## Source de données

**Endpoint** : OpenDataSoft public, dataset `economicref-france-sirene-v3`
- URL records : `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/records`
- URL exports CSV : `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/exports/csv`
- Publisher : INSEE (license Open License v2.0)
- Volume total : 43 116 645 établissements (snapshot 9 février 2026)
- Mis à jour mensuellement par OpenDataSoft

**Pourquoi pas data.gouv.fr direct** : l'infra `*.infra.data.gouv.fr` n'est pas accessible depuis l'IP du Mac de Paul (constat 6 mai 2026, mémoire `project_acces_data_gouv_bani`). OpenDataSoft sert le même dataset INSEE en miroir. À l'avenir, si OpenDataSoft change de modèle, alternative INSEE direct ou autre miroir public à documenter.

**Format export** : CSV séparateur `;`, encoding UTF-8 BOM, échappement RFC 4180 par guillemets.

---

## Cible doctrinale OSEYS

Sweet spot 6-49 salariés (codes INSEE labels OpenDataSoft) :

| Code interne | Label OpenDataSoft | Volume France actif siège |
|---|---|---|
| `03` | "6 à 9 salariés" | 267 358 |
| `11` | "10 à 19 salariés" | 213 966 |
| `12` | "20 à 49 salariés" | 133 441 |
| **TOTAL 6-49** | – | **614 765** |
| `21` (option LARGE) | "50 à 99 salariés" | 49 768 |
| **TOTAL 6-99 (mode LARGE)** | – | **664 533** |

**Mode `LARGE`** activable via env `SIRENE_TRANCHES_INCLUDE` (par défaut sweet spot strict 6-49 = `03,11,12`). Pour Prospérenne future ou audit ad-hoc, override sans toucher au code.

**Filtres complémentaires invariants** :
- `etatadministratifetablissement = "Actif"` — exclut les fermés
- `etablissementsiege = "oui"` — un siren = un siège, évite les duplications
- `activiteprincipaleetablissement` non vide — exclut les NAF inconnus
- Exclusions NAF OSEYS via `mappings/naf-exclusions.json` existant (avocats, comptables, B2C, etc.) appliquées côté ingestion

Volume estimé après tous filtres : 500-580k entités sweet spot 6-49 actionnables.

---

## Architecture des modules

```
shared/sirene/
├── parser.js     RFC 4180 strict, gère ; dans champs quotés
├── mapper.js     SIRENE row → LeadBase entity (PartitionKey=département, RowKey=siren)
├── downloader.js download CSV par département via OpenDataSoft /exports/csv
└── writer.js     Merge idempotent dans table LeadBase, audit dans SireneIngestionRuns

scripts/
└── sirene-bulk-import.js  Orchestrateur CLI : download → parse → map → write par département

tests/unit/sirene/
├── parser.test.js
├── mapper.test.js
└── writer.test.js
```

**Aucune dépendance externe ajoutée** au-delà de ce qui est déjà dans `package.json` (`@azure/data-tables`). Parser CSV maison ~50 lignes (cohérent invariant I-1, réduction des risques de chaîne d'approvisionnement).

---

## Stratégie d'écriture LeadBase

**Schéma** :
- PartitionKey = code département (2 chars, ex `75` pour Paris). Les 2 premiers chars du code postal.
- RowKey = `siren` (9 chars)
- Si déjà dans LeadBase (legacy Constantin) → **Merge** : on met à jour les colonnes SIRENE avec les valeurs fraîches, on ne touche pas aux colonnes peuplées par d'autres workers (`siteWeb`, `siteWebSource`, `siteWebLastCheckedAt`, `dirigeants`, `rne_checked_at`, `emailDirigeant`).
- Si nouveau → **CreateEntity** avec colonnes SIRENE + champs vides pour ce que les autres workers vont peupler.

**Colonnes peuplées par SIRENE writer** :
- `siren`, `nom` (denominationunitelegale ou denominationusuelle1unitelegale fallback), `sigle` (sigleunitelegale)
- `codeNaf` (activiteprincipaleetablissement)
- `categorieJuridique` (categoriejuridiqueunitelegale)
- `trancheEffectif` (code dérivé du label : "6 à 9 salariés" → "03", "10 à 19 salariés" → "11", etc.)
- `trancheEffectifLabel` (le label OpenDataSoft brut, audit)
- `adresse` (numerovoie + typevoie + libellevoie)
- `codePostal`, `ville` (libellecommuneetablissement)
- `dateCreation` (datecreationetablissement)
- `prenomDirigeant`, `nomDirigeant` (prenom1unitelegale, nomunitelegale — uniquement pour catégorie juridique personne physique)
- `sireneSourcedAt` (ISO timestamp ingestion)
- `sireneSnapshotVersion` (version OpenDataSoft / date du dernier traitement)
- `sireneRunId` (UUID de la run d'ingestion, pour audit/rollback)

**Colonnes NON touchées par SIRENE writer** (préservées si déjà peuplées par autres workers) :
- `siteWeb`, `siteWebConfidence`, `siteWebSource`, `siteWebProofType`, `siteWebLastCheckedAt`, `siteWebVersion`
- `emailDirigeant`
- `dirigeants` (JSON RNE peuplé par enrich-leadbase-continuous.js)
- `rne_checked_at`, `rne_dirigeants_count`

**Idempotence** : rerun du même CSV même jour = no-op net (les hash colonnes SIRENE sont identiques, écriture skippée si pas de delta).

---

## Audit dans `SireneIngestionRuns`

Chaque run d'ingestion crée une ligne dans la table `SireneIngestionRuns` :
- PartitionKey = `YYYY-MM-DD` (date de la run)
- RowKey = `runId` (UUID)
- Colonnes : `runId`, `startedAt`, `endedAt`, `departements` (JSON), `snapshotVersion`, `entitiesCreated`, `entitiesUpdated`, `entitiesSkipped`, `entitiesError`, `bytesDownloaded`, `tranches`, `mode` (strict/LARGE), `dryRun`

Permet rollback ciblé (purge des entités d'une run précise) si bug détecté post-ingestion.

---

## Conformité invariants

| Invariant | Conformité | Note |
|---|---|---|
| **I-1 offline runtime** | ✅ | Ingestion = batch download manuel ou cron mensuel. Aucun appel runtime à OpenDataSoft. La LeadBase enrichie sert ensuite les pipelines à la demande sans appel externe. |
| **II-1 anti-SPOF** | ⚠️ partiel | OpenDataSoft est une source unique pour SIRENE. Atténuation : le dataset est public (open license), le download persiste localement, miroirs alternatifs (INSEE direct) documentables. La défaillance OpenDataSoft = pas de refresh mensuel mais ne casse pas le runtime. |
| **II-2 cap budget** | ✅ | Source gratuite (Open License v2.0), aucun cap requis. |
| **III-1 cohérence doctrine/code** | ✅ | Tranches définies dans cette doctrine + dans `mapper.js` constantes (audit possible). |
| **III-2 mémoires expirables** | ✅ | `sireneSnapshotVersion` permet le diff. Refresh mensuel programmable. |
| **IV-1 mesure business** | ✅ | Audit `SireneIngestionRuns` exposable via `/api/budgetStatus` ou endpoint dédié `/api/sireneIngestionStatus`. |
| **V-1 capital permanent** | ✅ | LeadBase devient un dataset propriétaire Pereneo construit à partir de sources souveraines. |
| **V-2 multi-agent** | ✅ | Données INSEE neutres, tranches configurables par tenant. Réutilisable David, Alicia, Richard. Pas de hardcoding OSEYS. |

---

## RGPD

**Données à caractère personnel ingérées** :
- Pour les entreprises individuelles (catégorie juridique 1xxx) : `prenom1unitelegale`, `nomunitelegale`, `sexeunitelegale`. Donnée publique INSEE.
- Pour les sociétés (catégorie juridique 5xxx, 6xxx, 7xxx, etc.) : aucune donnée personnelle dans SIRENE. Les dirigeants nominatifs viennent du RNE (worker `enrich-leadbase-continuous.js` actif), avec sa propre conformité.

**Base légale** : intérêt légitime B2B (prospection ciblée TPE/PME, finalité commerciale légitime documentée).

**Information / opt-out** :
- Les entreprises individuelles ont un droit d'opposition au démarchage commercial (Bloctel pour téléphone, opt-out mail spécifique B2B).
- Le pilote David ne contacte que les leads passés par le formulaire consultant qui valide la cible — pas un envoi de masse depuis SIRENE direct.
- Une entité ingérée mais jamais sélectionnée par un consultant n'est jamais contactée.

**Rétention** :
- Refresh mensuel automatique → données toujours à jour vis-à-vis de SIRENE.
- Suppression d'une entité : si l'établissement est supprimé de SIRENE (état `Fermé` ou disparu du dump), la run mensuelle ne le re-touche pas. Une politique de purge `etatadministratifetablissement != "Actif"` peut être ajoutée Phase 5+.

---

## Phases d'implémentation

| Phase | Effort | Livrable | Critère sortie |
|---|---|---|---|
| **1 — Investigation** | 4h | Cette doctrine, mesures volumes/format/durée | ✅ fait 6 mai 2026 PM |
| **2 — MVP modules + orchestrateur + tests** | 1-2j | parser/mapper/downloader/writer + script CLI + tests verts | sur 1 département test, ingestion idempotente, distribution conforme |
| **3 — Première ingestion réelle 1 dép.** | 30 min | Run sur Paris, mesure volume + distribution NAF + audit | volume sweet spot ajouté > 5k pour Paris |
| **4 — Re-smoke vérité aval** | 30 min | Smoke sur leads ingérés pour mesurer taux résolution email post-peuplement | taux résolution > 0% (juste valider que le pipeline aval marche sur sweet spot) |
| **5 — Scale France + scheduling** | 1-2j | LaunchAgent mensuel + endpoint status + reporting COMEX | ingestion automatique mensuelle, reporting accessible |

---

## Décisions ouvertes (à arbitrer Paul / COMEX)

1. **Stockage du CSV downloaded** : conserver les fichiers CSV bruts post-ingestion (pour rollback / audit) ou les supprimer après ingestion réussie ? Reco initiale : conserver 3 mois rolling dans `~/Pereneo/sirene-snapshots/` (3 × ~150 MB compressés gzip = ~500 MB peak), au-delà purge.
2. **Multi-tenant Tranche 8** : quand Prospérenne sera commercialisée multi-tenant, chaque tenant pourra avoir sa propre `SIRENE_TRANCHES_INCLUDE` (ex Prospérenne pourrait élargir à 100-499 si segment cible différent). Actuellement par env globale, à externaliser config tenant.
3. **Refresh frequency** : mensuel par défaut (cohérent avec rythme INSEE). Possible passage hebdo si besoin de fraîcheur pour signaux croissance/transmission, à arbitrer après mesure de la valeur du delta hebdo vs mensuel.
