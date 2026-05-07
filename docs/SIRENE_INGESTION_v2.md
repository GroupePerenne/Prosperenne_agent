# SIRENE_INGESTION v2.0 — Pipeline pérenne (Bloc 2 chantier refonte LeadBase v1)

> Amende `SIRENE_INGESTION_v1.md` (création 6 mai 2026 PM, Phase 1 measure 614 765 établissements). v2 industrialise l'ingestion en pipeline récurrent mensuel pérenne, conforme schéma v1.0 et invariants I-1 à I-10.
>
> **Rédigé** : 2026-05-07 PM (Charli, Bloc 2 chantier refonte).
> **Statut** : v2.0 — figé.
> **Cohérence** : `LEADBASE_SCHEMA_v1.md` v1.1, `LEADBASE_LESSONS_v1.md` invariants I-1 à I-10, `project_roadmap_air_worker.md` (5 mai 2026, Paul).

---

## 1. Évolutions v2 vs v1

| Aspect | v1.0 | v2.0 |
|---|---|---|
| **Conformité schéma LeadBase** | `schema_version` non posé | `schema_version='1.0'` posé par mapper, vérifié par `validateLeadBaseEntity` (I-2 enforced en lecture aval) |
| **Cadence** | Run manuel ad-hoc | Cron launchd Mac Air mensuel (1er du mois 03h Paris) |
| **Source primaire** | OpenDataSoft `economicref-france-sirene-v3` | Inchangé |
| **Source fallback (I-4)** | Aucune (mono-source SPOF) | À livrer Palier 3 — INSEE direct API (`api.insee.fr`) ou miroir alternatif |
| **Multi-tenant ready** | OSEYS hardcodé via défaut sweet spot | Filtres tranche/NAF en env config externalisée (`SIRENE_TRANCHES_INCLUDE`, `naf-exclusions.json`) |
| **Audit** | `SireneIngestionRuns` Storage Table | Inchangé |
| **Run via** | Manuel CLI | launchd plist `com.pereneo.sirene-monthly` |

---

## 2. Pivot architectural — pourquoi cron Mac Air et pas Function App timer

Le plan initial Bloc 2 prévoyait un **Function App timer mensuel**. Auto-critique au 7 mai 2026 PM (séance Charli/Paul) :

**Argument retenu** : on a déjà un Mac Air worker éprouvé pour `enrich-leadbase-continuous.js` (cf. CLAUDE.md §5.3, plist template `enrich-leadbase-launchctl.plist.template`). Doubler l'infra avec une FA pour SIRENE = over-engineering.

**Argument cohérent avec roadmap** : `project_roadmap_air_worker.md` (5 mai 2026, Paul) acte explicitement "pipeline lourd → Mac Air worker continu (semaine), Container Apps pour Prospérenne futur". V1 OSEYS reste sur Mac Air.

**Bénéfices** :
- Pas de coût FA Consumption (l'ingestion bulk dépasse la fenêtre 10 min).
- Pas de quota Storage cold-start.
- Pattern launchd déjà validé en prod (BL-43 résolu).
- Logs dans `/tmp/pereneo-sirene-monthly.{out,err}.log`, intégrables à un audit hebdo.

**Trade-off accepté** : si le Mac Air est éteint au 1er du mois 03h, launchd déclenche au prochain démarrage (option `RunAtLoad=false`). Risque opérationnel acceptable, monitoring via `SireneIngestionRuns` table.

**Évolution future** : à la commercialisation Prospérenne (Tranche 8), portage vers Container Apps avec scheduled job — code script identique, juste l'orchestrateur change.

---

## 3. Installation cron Mac Air worker

**Plist** : `scripts/sirene-monthly-launchctl.plist.template`.

```bash
# 1. Personnaliser {REPO_PATH} dans le template
sed "s|{REPO_PATH}|$HOME/Documents/Professionnel/GROUPE PERENNE/Pereneo_agents|" \
  scripts/sirene-monthly-launchctl.plist.template \
  > ~/Library/LaunchAgents/com.pereneo.sirene-monthly.plist

# 2. Charger
launchctl load ~/Library/LaunchAgents/com.pereneo.sirene-monthly.plist

# 3. Vérifier
launchctl list | grep com.pereneo.sirene-monthly

# 4. Test manuel (sans attendre le 1er du mois)
launchctl start com.pereneo.sirene-monthly
tail -f /tmp/pereneo-sirene-monthly.out.log

# 5. Arrêter
launchctl unload ~/Library/LaunchAgents/com.pereneo.sirene-monthly.plist
```

**Pré-requis env** : `LEADBASE_STORAGE_CONNECTION_STRING` doit être présent dans `local.settings.json` du repo (lu par le script via cascade).

---

## 4. Conformité invariants I-1 à I-10

| Invariant | Statut v2.0 | Détail |
|---|---|---|
| **I-1** Contrat de couches | ✅ Couche 1 SIRENE = seule autorisée à créer une entrée. Writers Couches 2-5 utilisent `safeMergeCoucheN` qui vérifie Couche 1 conforme. | Cohérent §10.3 SCHEMA |
| **I-2** Discrimination origine | ✅ `schema_version='1.0'` posé sur tout write SIRENE (Palier 1 livré, commit c1a866e) | Tests `tests/unit/sirene/conformity-v1.test.js` |
| **I-3** Filtre serveur-side | ✅ Filtres tranche/NAF/dept appliqués via `where` OpenDataSoft (cf. `shared/sirene/downloader.js` `buildWhereClause`) | Pas de filter client-side après scan |
| **I-4** Multi-source | ⏳ Palier 3 à livrer — fallback INSEE direct si OpenDataSoft 503 | Test `tests/integration/leadbase/i4-multi-source-fallback.test.js` (todo Bloc 2) |
| **I-5** Fallback local | ✅ Snapshots locaux dans `~/Pereneo/sirene-snapshots/sirene-DEP-YYYYMMDD.csv` permettent rerun parser sans re-télécharger | |
| **I-6** Test E2E par palier | ⏳ Palier 4 à livrer — test E2E ingestion → read back → assert schéma v1 conforme | Stub existant `tests/e2e/leadbase/e2e-cascade-complete.test.js` |
| **I-7** Time-budget | ✅ `DEFAULT_TIMEOUT_MS = 180000` (3 min) par département, France entière mesurée à ~21 min, soutenable par cron Mac Air sans contrainte FA window | |
| **I-8** Cache TTL | ✅ Snapshots locaux ont TTL implicite par date dans le filename (rerun complet mensuel) | |
| **I-9** Sémantique unique | ✅ `prenomDirigeant` / `nomDirigeant` peuplés UNIQUEMENT pour EI (catégorie juridique commençant par '1'). Sociétés via Couche 2 RNE. | Test conformité-v1 |
| **I-10** Audit `*At` | ✅ `sireneSourcedAt` ISO 8601 posé sur tout write. `sireneSnapshotVersion` (mois INSEE source). | |

---

## 5. Multi-tenant ready

**V1 OSEYS** : filtres sweet spot 6-49 + NAF exclusions OSEYS via :
- `SIRENE_TRANCHES_INCLUDE='03,11,12'` (env, défaut sweet spot strict)
- `shared/mappings/naf-exclusions.json` (cabinets juridiques/comptables, administration publique, enseignement, organisations associatives)

**Tranche 8 Prospérenne** : la même base SIRENE V2 sera lue par d'autres tenants avec leurs propres filtres. Les colonnes de filtrage (`trancheEffectif`, `codeNaf`, `dept`) sont déjà serveur-side enforced (I-3). Filtre tenant-side via `composeDiscriminantFilter` du SDK schéma v1.

Aucun champ `tenantId` n'est ajouté à LeadBase (cf. `LEADBASE_SCHEMA_v1.md` §12.2). LeadBase reste base commune Pereneo, lue à travers vues filtrées.

---

## 6. Roadmap Bloc 2 paliers

| Palier | Statut | Livrable |
|---|---|---|
| 1 — Conformité v1 mapper + writer | ✅ commit `c1a866e` | `schema_version='1.0'`, tests conformité v1 |
| 2 — Cron Mac Air launchd | ✅ ce commit | `scripts/sirene-monthly-launchctl.plist.template` + doc install |
| 3 — I-4 multi-source fallback | ⏳ à livrer | Wrapper downloader OpenDataSoft → fallback INSEE direct si 503 |
| 4 — Test E2E ingestion Bloc 2 | ⏳ à livrer | Active stub `e2e-cascade-complete.test.js` étape 1 (ingestion → read back) |
| 5 — Documentation finale | ⏳ à livrer | Amender ce doc avec retour d'expérience premier run mensuel |

---

## 7. Évolutions futures

- **v2.1** : I-4 multi-source fallback INSEE direct (Palier 3 ce sprint).
- **v3.0** : portage Container Apps Prospérenne (Tranche 8 commercialisation).
- **v3.x** : multi-tenant runtime — chaque tenant Prospérenne aura sa propre config NAF/tranche injectée par le scheduler.

---

*v2.0 — figé 2026-05-07 PM. Charli, Bloc 2 chantier refonte LeadBase v1.*
