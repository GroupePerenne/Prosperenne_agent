# pereneo-charli-aggregator

Function App Azure (Linux Consumption, Node 22, Functions v4) qui consomme la queue Azure Storage `charli-events` sur le Storage Account `pereneocharliaggregst` et écrit les événements reçus comme mémoires dans Mem0 `user_id=charli` via le Container App MCP `mem0-mcp-charli`.

## Rôle

Niveau 2 du chantier "activation Charli mémoire continue" : centralise les remontées asynchrones des agents (David, Alicia, Richard, futurs) vers la mémoire continue de Charli, sans que les agents parlent directement au MCP.

Invariant 1 strict : Charli passe par son MCP, pas en direct Mem0 Cloud. Le Container App MCP applique `DEFAULT_USER_ID=charli` automatiquement.

## Architecture

```
agent FA (David, ...) ──reportToCharli()──> Azure Storage Queue charli-events
                                                       │
                                                       ▼
                                  pereneo-charli-aggregator FA
                                  (queue trigger davidQueueConsumer)
                                                       │
                                       Bearer Entra v2 client_credentials
                                                       │
                                                       ▼
                                      Container App mem0-mcp-charli
                                                       │
                                                       ▼
                                            Mem0 Cloud user_id=charli
```

## Développement local

```bash
cd apps/charli-aggregator
npm install
func start
```

Le `local.settings.json` (gitignored) doit fournir au minimum : `AzureWebJobsStorage`, `MEM0_MCP_URL`, `ENTRA_TENANT_ID`, `ENTRA_AUDIENCE`, `ENTRA_SCOPE`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `DEFAULT_USER_ID=charli`.

## Tests

```bash
npm test
```

Convention repo : `node --test` natif, JS CommonJS pur.

## Déploiement

```bash
cd apps/charli-aggregator
func azure functionapp publish pereneo-charli-aggregator --build remote --timeout 600
```

App settings prod déjà posés en Phase A (cf. mémoire Charli `phase-a-livree`). `ENTRA_CLIENT_SECRET` est une KV reference vers `pereneo-prod-kv/aggregator-fa-client-secret`.
