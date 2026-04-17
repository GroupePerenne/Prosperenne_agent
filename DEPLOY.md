# Déploiement

## Pré-requis côté Azure

Un Function App Node 20+ avec :
- Runtime `~4`
- Les variables d'environnement listées dans `.env.example`
- Un Storage Account attaché (pour la queue des relances)
- L'app registration `OSEYS-ProspectionAgent` avec la permission **Application** `Mail.Send` (consent accordé au niveau tenant)
- Les trois boîtes créées côté Microsoft 365 :
  - `david@oseys.fr` — shared mailbox
  - `martin@oseys.fr` — licence Business Basic
  - `mila@oseys.fr` — licence Business Basic

## Étape 1 — Cloner et installer

```bash
git clone https://github.com/GroupePerenne/Prosperenne_agent.git
cd Prosperenne_agent
npm install
```

## Étape 2 — Déployer sur Azure

Deux options.

### Option A — Azure Functions Core Tools (recommandée)

```bash
# Si pas encore installé
brew install azure-functions-core-tools@4   # macOS
# ou : npm i -g azure-functions-core-tools@4 --unsafe-perm true

# Publication
func azure functionapp publish oseys-mail-sender --javascript
```

### Option B — GitHub Actions (CI/CD)

Créer `.github/workflows/deploy.yml` avec le secret `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` (à récupérer depuis le portail Azure → Function App → "Get publish profile").

Template disponible sur demande — peut être ajouté au prochain commit.

## Étape 3 — Variables d'environnement

Dans le portail Azure → Function App → **Variables d'environnement**, créer toutes les clés listées dans `.env.example`. Les plus critiques :

- `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` : app registration Azure AD
- `PIPEDRIVE_TOKEN` : token d'API de l'utilisateur David dans Pipedrive
- `ANTHROPIC_API_KEY` : clé API Claude
- `AzureWebJobsStorage` : chaîne de connexion du storage (automatiquement définie par Azure si le storage est lié à la Function App)
- `DAVID_EMAIL`, `MARTIN_EMAIL`, `MILA_EMAIL` : les trois adresses

## Étape 4 — Stages Pipedrive

Créer un pipeline "OSEYS Prospection" dans Pipedrive avec 4 stages :

| Stage | ID typique | Usage |
|-------|------------|-------|
| Nouveau | 1 | Deal créé par David au J0 |
| Contacté | 2 | Au moins 1 touche envoyée |
| A répondu | 3 | Réponse reçue (automatique via David) |
| Fermé — pas de suite | 4 | Après J14 sans réponse |

Reporter les IDs dans `PIPEDRIVE_STAGE_*` dans les variables d'environnement.

## Étape 5 — Hébergement des formulaires

Le formulaire de qualification (`forms/qualification.html`) doit être accessible publiquement. Deux options :

1. **GitHub Pages** (gratuit) — Settings → Pages → source `main` branch, répertoire `/forms`. URL : `https://groupeperenne.github.io/Prosperenne_agent/forms/qualification.html`
2. **Azure Static Web App** — meilleure performance + domaine custom, quelques minutes à configurer.

Une fois en ligne, mettre à jour `PUBLIC_FORMS_BASE_URL` dans les variables d'environnement.

## Étape 6 — Test end-to-end

```bash
# 1. Envoyer un onboarding à un consultant test
curl -X POST "https://oseys-mail-sender-xxxx.azurewebsites.net/api/sendOnboarding?code=XXX" \
  -H "Content-Type: application/json" \
  -d '{"prenom":"Paul","nom":"Rudler","email":"paul.rudler@oseys.fr"}'

# 2. Cliquer un bouton dans le mail → vérifier la page de confirmation + l'accusé reçu

# 3. Remplir le formulaire → vérifier le mail de brief reçu par David

# 4. Déclencher une séquence test
curl -X POST "https://oseys-mail-sender-xxxx.azurewebsites.net/api/runSequence?code=XXX" \
  -H "Content-Type: application/json" \
  -d '{
    "consultant": {"nom":"Paul Rudler","email":"paul.rudler@oseys.fr","offre":"...","ton":"direct cordial","tutoiement":true},
    "brief": {"prospecteur":"both"},
    "leads": [{"prenom":"Constantin","entreprise":"Azur Domotic","email":"constantin.picoron@gmail.com","secteur":"domotique","ville":"Grasse","contexte":"installateur Côte d\'Azur"}]
  }'

# 5. Vérifier : J0 envoyé + 3 messages dans la queue Azure + log dans Pipedrive
```

## Monitoring

- **Application Insights** est activé via `host.json`. Tous les logs `context.log(...)` y remontent.
- **Queue dans le portail** : Storage Account → Queues → `mila-relances` — on voit les messages en attente et leur `nextVisibleOn`.
- **Pipedrive** : pipeline "OSEYS Prospection" — chaque deal a l'historique complet des activités.
