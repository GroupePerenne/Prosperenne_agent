# Tests E2E LeadBase — grille permanente

Cf. `docs/LEADBASE_SCHEMA_v1.md` §11.3 et `docs/LEADBASE_LESSONS_v1.md` §6.

## Convention de skip

Ces tests E2E nécessitent un environnement complet (Storage Tables réelles ou Azurite, secrets KV, providers externes). Ils sont **skip** par défaut et activés via env :

```bash
LEADBASE_E2E=1 npm test -- tests/e2e/leadbase
```

Sans `LEADBASE_E2E=1`, les tests sont marqués `skip` avec un message expliquant pourquoi.

## Variables d'environnement requises

```bash
LEADBASE_STORAGE_CONNECTION_STRING  # CS pereneoleadsst
DROPCONTACT_API_KEY                  # pour Dropcontact adapter
ANTHROPIC_API_KEY                    # pour David runSequence (dryRun)
LEADBASE_E2E=1                       # active la suite E2E
```

## Tests

| Fichier | Scénario | Critère succès |
|---|---|---|
| `e2e-cascade-complete.test.js` | SIRENE → RNE → siteFinder → exhauster → David runSequence dryRun | 5 étapes OK ≤ 8 min |
| `e2e-discrimination-origine.test.js` | LeadBase mix legacy + v1, readers ne lisent que v1 | 0 entrée legacy remontée |
| `e2e-fallback-multi-source.test.js` | Indispo simulée chaque source externe | Cascade continue avec dégradation gracieuse |
| `e2e-budget-temps.test.js` | Run AirWorker batch 10 leads worst case | Temps total ≤ 8 min |

## Statut implémentation

Tous les tests E2E sont en **stub** au 7 mai 2026. Implémentation effective au fil des Blocs 2-3 du chantier refonte LeadBase v1, quand l'infrastructure de test sera en place (premier run SIRENE bulk France, LeadBase_v1 propre, adapters wired).
