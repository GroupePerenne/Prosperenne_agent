# AirWorker Waterfall Continuous — Setup

## Vue d'ensemble

Script Node.js qui tourne en continu sur un Mac dédié pour pré-peupler la table `LeadContacts` avec les emails dirigeants extraits via Playwright (rendu JS local) sur les sites entreprises.

Architecture cible :
- **AirWorker (Mac local)** : lit `LeadBase` (Storage Table) → écrit `LeadContacts` enrichis
- **FA Azure pereneo-mail-sender** : lit `LeadContacts` pré-rempli → génère et envoie les emails consultants
- 0 appel FA Azure runtime, 0 Container App, ~0 Mem0
- API externes : Dropcontact en dernier recours uniquement (pay-on-success), Storage Tables Azure SDK direct

## Mesure performance probe v8 (8 mai 2026 PM)

Sur 10 leads sweet spot OSEYS (Morgane + Johnny) :
- **10/10 domaines résolus** (100%)
- **7/10 emails résolus** (70%) — vs 1/10 (10%) avec SMTP+Dropcontact seul
- Latence moyenne par lead avec domaine : ~5-10s (parallélisation pages Playwright)

## Pré-requis

```bash
# Node 22+
node -v

# Repo cloné dans ~/Documents/Professionnel/GROUPE PERENNE/Pereneo_agents
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
npm install

# Playwright Chromium (~150 MB)
npx playwright install chromium

# Azure CLI (pour récupérer les secrets)
az login --tenant 70f9e20f-964f-4925-8dc2-b72d62384629
```

## Configuration

### Étape 1 — Récupérer les secrets et créer le fichier env

```bash
mkdir -p ~/.config/charli
cat > ~/.config/charli/airworker.env <<'EOF'
export DROPCONTACT_API_KEY="$(az keyvault secret show --vault-name pereneo-prod-kv --name DropcontactApiKey --query value -o tsv)"
export AzureWebJobsStorage="$(az functionapp config appsettings list --name pereneo-mail-sender --resource-group oseys-prospection-rg --query "[?name=='AzureWebJobsStorage'].value" -o tsv)"
export LEADBASE_STORAGE_CONNECTION_STRING="$(az functionapp config appsettings list --name pereneo-mail-sender --resource-group oseys-prospection-rg --query "[?name=='LEADBASE_STORAGE_CONNECTION_STRING'].value" -o tsv)"
export DROPCONTACT_ENABLED=true
export DROPCONTACT_API_URL=https://api.dropcontact.io/batch
export DROPCONTACT_MONTHLY_BUDGET_CENTS=2400
export AIRWORKER_CONCURRENCY=2
export AIRWORKER_BATCH_SIZE=10
export AIRWORKER_SLEEP_BATCH_MS=30000
EOF
chmod 600 ~/.config/charli/airworker.env
```

### Étape 2 — Tester en dry-run

Le mode dry-run (`AIRWORKER_DRY_RUN=1`) ne fait **aucune** écriture Storage (LeadContacts/Jobs/Progress).

```bash
source ~/.config/charli/airworker.env
AIRWORKER_DRY_RUN=1 AIRWORKER_BATCH_SIZE=3 \
  node scripts/airworker-waterfall-continuous.js
```

Surveiller les logs pour confirmer :
- `[airworker] starting — concurrency=2, batchSize=3, dryRun=true`
- `[airworker] cycle start, N briefs actifs`
- `[airworker] {siren} {firstName} {lastName} → ok|unresolvable {email}` par lead

Stopper avec `Ctrl+C` (SIGINT) après 1-2 cycles.

### Étape 3 — Lancement production via LaunchAgent

Adapter les chemins dans `scripts/launchd/com.pereneo.airworker-waterfall.plist` puis :

```bash
# Copier le plist dans LaunchAgents
cp scripts/launchd/com.pereneo.airworker-waterfall.plist ~/Library/LaunchAgents/

# Charger
launchctl load ~/Library/LaunchAgents/com.pereneo.airworker-waterfall.plist

# Vérifier qu'il tourne
launchctl list | grep airworker

# Suivre les logs
tail -f ~/Library/Logs/airworker-waterfall.log
```

Pour désactiver :
```bash
launchctl unload ~/Library/LaunchAgents/com.pereneo.airworker-waterfall.plist
```

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `AIRWORKER_CONCURRENCY` | 2 | Leads en parallèle (pMapLimit). Risque ban Google si > 3. |
| `AIRWORKER_BATCH_SIZE` | 10 | Taille batch passée à selectCandidatesForConsultant |
| `AIRWORKER_SLEEP_BATCH_MS` | 30000 | Pause entre batches (politesse + reload briefs) |
| `AIRWORKER_SLEEP_EMPTY_MS` | 300000 | Pause si aucun brief actif (5 min) |
| `AIRWORKER_DRY_RUN` | 0 | Si '1' : pas d'écriture Storage Tables |
| `LEADCONTACTS_POSITIVE_TTL_DAYS` | 90 | TTL cache positif (email résolu, pas re-traité avant N jours) |
| `LEADCONTACTS_NEGATIVE_RETRY_DAYS` | 7 | TTL cache négatif (unresolvable retenté après N jours) |
| `DROPCONTACT_API_KEY` | requis | Clé API Dropcontact (KV) |
| `DROPCONTACT_ENABLED` | true | Active/désactive Dropcontact dernier recours |
| `AzureWebJobsStorage` | requis | Connection string compte Storage Tables |
| `LEADBASE_STORAGE_CONNECTION_STRING` | requis | Connection string LeadBase (peut différer) |

## Tables Storage utilisées

| Table | Sens | Usage |
|---|---|---|
| `LeadBase` (compte LeadBase) | lecture | Source candidats SIRENE + RNE |
| `consultantOnboarding` | lecture | Briefs consultants actifs |
| `LeadContacts` | écriture | Résultats enrichissement par siren+name |
| `CharliBackgroundJobs` | écriture | Audit trail par run (PartitionKey=date) |
| `AirWorkerProgress` | écriture | État reprise après crash (par consultant) |

## Monitoring

### Stats du cycle

À la fin de chaque cycle complet, log console :
```
[airworker] cycle done. stats: processed=X resolved=Y (Z%) cached=W errors=N
```

### Vérification manuelle

```bash
# Combien de LeadContacts résolus aujourd'hui ?
az storage entity query --table-name CharliBackgroundJobs \
  --filter "PartitionKey eq 'airworker-$(date +%Y-%m-%d)'" \
  --connection-string "$AzureWebJobsStorage" \
  --query "items[].{siren:siren,status:status,email:email,source:source}" -o table

# Progress par consultant
az storage entity query --table-name AirWorkerProgress \
  --connection-string "$AzureWebJobsStorage" -o table
```

## Arrêt propre

`SIGTERM` ou `SIGINT` déclenche le shutdown gracieux :
- Ferme les browsers Playwright (Google + Extractor)
- Termine le batch en cours
- Pas d'écriture pendante

## Troubleshooting

### Google CAPTCHA après quelques heures
- Pause AirWorker
- Augmenter `AIRWORKER_SLEEP_BATCH_MS` à 60000+ ms
- Réduire `AIRWORKER_CONCURRENCY` à 1

### Dropcontact 402 quota exceeded
- Augmenter le cap mensuel sur le dashboard Dropcontact
- Désactiver via `DROPCONTACT_ENABLED=false` (cascade aboutira à unresolvable sur les leads en dernier recours)

### Mac sleep / réveil
- Mac Air dédié devrait être configuré avec "Empêcher la veille automatique" + "Démarrer automatiquement après une coupure de courant"
- LaunchAgent KeepAlive=true relance après wake si crash
