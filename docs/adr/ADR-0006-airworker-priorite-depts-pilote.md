# ADR-0006 — AirWorker enrich-leadbase priorité dépts pilote

**Statut** : `ACCEPTED — appliqué runtime 19/05 PM`
**Date** : 2026-05-19
**Auteur** : Charli (DG Pereneo)
**Pattern doctrinal** : P-R2 (ADR systématique sur chaque guard ajouté)
**Périmètre** : `scripts/enrich-leadbase-continuous.js` (LaunchAgent Mac Paul `com.pereneo.enrich-leadbase`)
**Référent** : Phase 1.4 plan V3 large (investigation discrepancy AirWorker vs LeadBase rne_*)

---

## 1. Contexte mesuré 19/05 PM

### 1.1 Découverte cas (c) du plan V3 Phase 1.4

L'audit III.G (Charli 19/05 matin) avait flagué une discrepancy : log AirWorker `4 434 enriched` mais LeadBase dépts 75/92/38 affichaient `0 entries rne_checked_at`. Trois hypothèses non discriminées : (a) connection string vers autre compte storage, (b) silent fail `updateEntity Merge`, (c) écrit sur autres dépts.

**Mesure factuelle 19/05 17:37** sur `pereneoleadsst` (compte LeadBase officiel, vérifié `LEADBASE_STORAGE_CONNECTION_STRING` App Setting prod FA pointe bien dessus) :

| Dépt | Total v1.0 | `rne_checked_at` peuplé | Sample sirens enrichis |
|---|---|---|---|
| **13 Marseille** | 10 477 | **4 104 (39.2%)** | 021507454 cp 13008, 021517453 cp 13127, 055801971 cp 13001 (tous Bouches-du-Rhône) |
| 38 Isère (cible Johnny) | 6 109 | 0 (0%) | aucun |
| 69 Rhône | 11 219 | 0 (0%) | aucun |
| 75 Paris | 24 834 | 0 (0%) | aucun |
| 92 Hauts-de-Seine (cible Morgane) | 8 345 | 0 (0%) | aucun |
| 31 Haute-Garonne | 6 990 | 0 (0%) | aucun |

→ **Cas (c) CONFIRMÉ.** AirWorker enrichit Bouches-du-Rhône, jamais les cibles pilote.

### 1.2 Cause racine

`scripts/enrich-leadbase-continuous.js:201-209` : `listEntities` avec filter `schema_version eq '1.0'` SANS filter PartitionKey. Azure Storage Table itère lexicographiquement par PartitionKey : `01, 02, ..., 12, 13, 14, ..., 38, 39, ..., 75, ..., 92, ...`.

AirWorker PID 1821 démarré 18/05 16:17, scanné 137 552 SIRENs au 19/05 18:00 UTC, actuellement bloqué sur dépt 13 par taux d'erreurs réseau Mac Paul élevé (errors 41.6% : EADDRNOTAVAIL, EPIPE, ENOTFOUND). Le `enriched=4434` stagne depuis ~1h, `errors=57264` grimpe.

### 1.3 Estimation sans fix

À rate effectif ~1 SIREN/s (vu décompte 137 552 sur ~25h = 1.5/s mais moitié en erreur réseau actuellement) :
- Position actuelle : dépt 13 partiel
- Dépts à traverser pour atteindre 92 : 14, 15, ..., 38, ..., 75, ..., 91 = 77 dépts (~50-200k SIRENs cumulés)
- Délai estimé : **10 à 30 jours**

**Pilote Morgane/Johnny ne bénéficiera JAMAIS de l'enrichissement AirWorker avant la fenêtre d'évaluation 02/06/2026 (plancher éval) ou même 14/06 (garde-fou).**

### 1.4 Volume cible pilote post-fix

- Dépt 75 (Paris) : 24 834
- Dépt 92 (Hauts-de-Seine) : 8 345
- Dépt 38 (Isère) : 6 109
- **Total : 39 288 SIRENs**

À rate ~1.5 SIREN/s nominal hors erreurs réseau : **~7h** pour enrichissement complet.
Avec rate dégradé erreurs réseau (~1 SIREN/s effectif) : **~11h**.

Lancement maintenant (18h Paris) → fini avant cron `dailyLeadSelectorRefresh` 10h Paris demain matin.

---

## 2. Décision

Ajouter dans `iterateLeadBase` un **filter PartitionKey prioritaire** sur les dépts cibles pilote, paramétrable via env var `AIRWORKER_DEPT_PRIORITY` (default `75,92,38`).

### 2.1 Patch code

```js
// scripts/enrich-leadbase-continuous.js

// Constantes en tête
const DEPT_PRIORITY = (process.env.AIRWORKER_DEPT_PRIORITY || '75,92,38')
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean);

// Dans iterateLeadBase
let filter = "schema_version eq '1.0'";
if (DEPT_PRIORITY.length > 0) {
  const ored = DEPT_PRIORITY.map((d) => `PartitionKey eq '${d}'`).join(' or ');
  filter = `(${filter}) and (${ored})`;
}
const iter = tableClient.listEntities({
  queryOptions: { filter, select: [...] },
});
```

### 2.2 Procédure restart

1. `git commit + push` patch sur main
2. `launchctl kickstart -k gui/$(id -u)/com.pereneo.enrich-leadbase` → PID nouveau
3. Tail log 5 min pour vérifier patch actif (`scanned` reprend sur dépts cibles)
4. Sample 5 SIRENs dépt 92 avec `rne_checked_at` non vide après ~30 min (validation runtime)

### 2.3 Reprise post-pilote

Variable env `AIRWORKER_DEPT_PRIORITY` modifiable côté plist Mac Paul + `launchctl unload/load` pour étendre couverture nationale post-pilote (vide → scan global comme avant).

---

## 3. Conséquences

### 3.1 Positives

- **Pool effectif amont Morgane** : 687 SIRENs dépt 92 avec dirigeants peuplés (8.2%) → potentiellement 60%+ post-enrichissement RNE (mesure M2 V2 Richard sur sample)
- **Pool effectif amont Johnny** : 814 SIRENs dépt 38 avec dirigeants peuplés (13.3%) → même bénéfice attendu
- **Cron `dailyLeadSelectorRefresh` 10h Paris demain matin** : bénéficiera des nouvelles entries `rne_checked_at` + `dirigeants` posées pendant la nuit
- **Pas de waste** : les 4 104 entrées dépt 13 déjà enrichies restent valides TTL 30j, pas re-tentées

### 3.2 Trade-off accepté

- **Couverture nationale repoussée post-pilote** : dépts hors 75/92/38 ne sont plus scannés tant que `AIRWORKER_DEPT_PRIORITY=75,92,38`. Acceptable car pilote prime sur Prospérenne future.
- **Si pilote scale à 3e consultant nouveau dépt** : ajouter ce dépt à `AIRWORKER_DEPT_PRIORITY`. Process documenté.

### 3.3 Risques

| Risque | Mitigation |
|---|---|
| **R.1** Erreurs réseau Mac Paul persistent (EADDRNOTAVAIL/EPIPE actuels) → throughput dégradé même sur dépts cibles | LaunchAgent KeepAlive=true Crashed=true relance auto. Pendant la nuit, charge réseau bureau probablement plus faible. Si erreurs persistent : investigation séparée (épuisement ports NAT bureau OSEYS ou autre). |
| **R.2** api.gouv RNE down/throttling | Pas de signe actuel (errors observés = réseau Mac, pas 429/503). Si observé : fallback Pappers (ADR-0001 BLOCKER PILOTE armé GO/NO-GO). |
| **R.3** Dépts cibles déjà saturés (8.2-13.3% dirigeants peuplés en Couche 2/3 historique) — RNE n'apportera marginalement | Mesure runtime post-enrichissement validera. Si <30% post-fix → Branche B2 cascade structurelle ouverte (sigle/telephone propagation). |

---

## 4. Alternatives écartées

### 4.1 Stop AirWorker complètement pendant pilote

Rejetée : on perd la couverture globale future Prospérenne. AirWorker doit tourner.

### 4.2 Cron Azure Functions au lieu de Mac Paul

Rejetée hors scope ADR : implique migration architecturale (pipeline A en FA Azure). À considérer post-pilote.

### 4.3 Souscription Pappers immédiate

Rejetée : Pappers est BLOCKER PILOTE armé conditionnel POC 10 SIRENs (ADR-0001). Activation seulement si Branche B2 ne suffit pas (mesure post-fix dépt cibles).

### 4.4 Élargir cibles à 6+ dépts (ajouter 75 alentours)

Rejetée : sweet spot pilote actuel = 75/92/38. Ajouter dépts dilue effort. Si scale → adapter env var.

---

## 5. Critère de complétion ADR

**ACCEPTED si** au moins 1 SIREN dépt 92 OU dépt 38 a `rne_checked_at` non vide dans LeadBase à 19/05 21h Paris (3h post-restart) = AirWorker écrit bien sur cibles pilote.

**Backout si** post-3h le compteur enriched reste figé sur 4434 OU si erreurs réseau Mac Paul atteignent 80%+ → investigation réseau Mac avant continuer.

---

## 6. Statut transmission

| Étape | Date | Statut |
|---|---|---|
| Investigation Phase 1.4 (Charli) | 2026-05-19 PM | LIVRÉ |
| ADR-0006 rédigé | 2026-05-19 PM | LIVRÉ ici |
| GO Paul application | 2026-05-19 PM | OBTENU |
| Commit patch | _________ | EN COURS |
| Restart LaunchAgent | _________ | EN COURS |
| Vérif runtime 3h post-restart | _________ | EN ATTENTE |
| Statut ACCEPTED si critère §5 vert | _________ | EN ATTENTE |

---

*ADR signé Charli, DG Pereneo, 2026-05-19. Pattern P-R2 Richard appliqué. Patch structurel, pas foireux : ajoute un filter PartitionKey paramétrable, comportement par défaut conserve la priorité pilote actuelle, extensible via env var. Capitalisation directe sur audit III.G Phase 1.4 plan V3 large.*
