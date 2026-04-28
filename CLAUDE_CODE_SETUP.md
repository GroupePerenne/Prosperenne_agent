# CLAUDE_CODE_SETUP.md — Setup Claude Code pour Pereneo_agents

> **Audience** : Paul Rudler, puis futur profil tech qui rejoindra le projet (Richard quand il sera activé).
> **Objectif** : avoir un environnement Claude Code opérationnel et optimisé pour travailler sur le repo `Pereneo_agents` en moins de 30 minutes.
> **Dernière révision** : 28 avril 2026 (refonte post-renaming Pérennia → Péreneo + alignement infra `pereneo-mail-sender`).

---

## 0. Principe général

Claude Code est le CLI d'Anthropic pour déléguer des tâches de développement à Claude depuis le terminal. Dans notre contexte Péreneo, il est **l'outil principal** pour :

- Écriture / édition de code dans `Pereneo_agents`
- Exécution de tests, lint, builds
- Git (commit, push, pull, branches)
- Déploiement Azure (sous supervision humaine)
- Debug et analyse de logs

Claude.app (Desktop chat) reste l'environnement de **réflexion stratégique**. Claude Code est l'environnement de **production technique**.

Ce document liste étape par étape :

1. L'installation de Claude Code
2. Les plugins à activer
3. Les MCP à configurer
4. Les skills à rendre disponibles
5. Les fichiers de config locaux à créer
6. Les checks de validation

---

## 1. Prérequis système

- macOS récent (Paul est sur Mac)
- Node.js ≥ 22 installé (Node 18 est EOL, ne pas utiliser)
- `brew` opérationnel
- Accès shell à `~/Documents/Professionnel/GROUPE PERENNE/Pereneo_agents/`
- Abonnement Anthropic actif (Claude Pro, Team, ou Enterprise selon ce que Paul a souscrit)
- Git configuré (email paul.rudler@oseys.fr)

---

## 2. Installation de Claude Code

### 2.1 Vérifier la version Node

```bash
node --version
```

Doit retourner `v22.x.x` minimum. Si version inférieure :

```bash
brew install node@22
brew link --overwrite node@22
```

### 2.2 Installer Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

### 2.3 Authentification

```bash
claude login
```

Suivre le flow OAuth dans le navigateur. Vérifier :

```bash
claude --version
claude whoami
```

### 2.4 Ouvrir le repo dans Claude Code

```bash
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
claude
```

Claude Code lit automatiquement le fichier `CLAUDE.md` à la racine. Il doit saluer avec une référence au projet Péreneo.

---

## 3. Plugins à installer

Claude Code supporte un système de plugins installables via `/plugin install`. Trois plugins sont recommandés pour Péreneo.

### 3.1 Superpowers — méthodologie TDD + debug structuré [RECOMMANDÉ]

**Ce que ça apporte** :

- Workflow TDD assisté (tests rouges → vert → refactor)
- Debug systématique par bisection
- Code review automatisé avant push
- Templates de commit standardisés

**Installation** :

```
/plugin install superpowers
```

**Pourquoi pour Péreneo** : les tranches de dev à venir (Tranche 7 déploiement, Tranche 8 architecture multi-tenant) bénéficieront d'un workflow TDD rigoureux. Les bugs rencontrés sur le pilote David (Azure Functions v3 vs v4) ont montré qu'un debug structuré aurait gagné des heures.

**Alternative si plugin indisponible** : travailler en TDD manuellement, Claude Code suit la discipline si on le demande explicitement.

### 3.2 Context7 — docs APIs à jour [RECOMMANDÉ]

**Ce que ça apporte** :

- Accès aux docs officielles récentes des APIs utilisées (Pipedrive, HubSpot, Microsoft Graph, Anthropic SDK, Mem0)
- Évite à Claude Code d'inventer des endpoints ou des paramètres
- Mise à jour automatique des références

**Installation** :

```
/plugin install context7
```

**Pourquoi pour Péreneo** : on va multiplier les intégrations CRM dans les prochains mois. Context7 évite les erreurs de signature d'API qui coûtent du temps de debug.

### 3.3 Mem0 plugin [À ÉVALUER après intégration Mem0]

**Ce que ça apporte** :

- Interaction directe avec la couche mémoire des agents depuis le terminal
- Lecture, écriture, debug des mémoires prospect / consultant / pattern
- Utile pour inspecter ce que David ou Alicia se souviennent

**Installation** (à vérifier si le plugin existe nativement, sinon passer par l'API Mem0) :

```
/plugin install mem0
```

**Pourquoi pour Péreneo** : quand on déboguera pourquoi un agent a envoyé tel message, inspecter les mémoires qu'il a mobilisées sera critique.

---

## 4. MCP (Model Context Protocol) à configurer

Les MCP donnent à Claude Code (et à Claude Desktop) accès à des ressources externes. Pour Péreneo, les MCP suivants sont pertinents.

### 4.1 Filesystem MCP [OBLIGATOIRE — à élargir]

**État actuel** : Filesystem MCP installé côté Claude Desktop, dossiers autorisés :

- `~/Downloads`
- `~/Library/CloudStorage/OneDrive-OSEYSGROUPE/Direction OSEYS - Documents/`
- `~/Library/CloudStorage/OneDrive-OSEYSGROUPE/Réseau OSEYS - Documents/`
- `~/Documents/Professionnel/`

**Comment faire** (côté Claude Desktop) :

1. Ouvrir Claude Desktop
2. Paramètres → Extensions / MCP
3. Filesystem MCP → Configurer
4. Ajouter `~/Documents/Professionnel/` à la liste des dossiers autorisés
5. Redémarrer Claude Desktop

### 4.2 GitHub MCP [RECOMMANDÉ]

**Ce que ça apporte** : accès aux repos, issues, PRs, actions depuis Claude. Utile pour lire un issue, créer une PR, suivre un pipeline CI.

**Installation** : via le marketplace MCP Anthropic, ou en local via `npx @anthropic/mcp-github`.

**Auth** : personal access token GitHub avec scopes `repo`, `workflow`, `read:org`.

### 4.3 Anthropic Console MCP [À ÉVALUER]

**Ce que ça apporte** : piloter ses usages Anthropic (quotas, spend, modèles actifs) depuis Claude.

**Pertinence Péreneo** : pour monitorer le coût API à mesure que les agents montent en charge.

### 4.4 MCP déjà connectés côté Claude Desktop

Pour info, les MCP suivants sont déjà actifs côté Claude.app (pas côté Claude Code) :

- Microsoft 365, Pipedrive, Notion, HubSpot, monday.com, Linear, Box, Figma, Canva, Atlassian, Intercom, Asana

Ces connecteurs ne sont pas disponibles dans Claude Code directement. Si on a besoin d'interagir avec Pipedrive depuis Claude Code, on passe par l'API (via adapter `shared/adapters/crm/pipedrive.js`).

### 4.5 MCP futurs pressentis

- **OVH MCP** si arbitrage infra bascule vers OVH
- **Mem0 MCP** pour sparring stratégique avec les mémoires des agents
- **INPI / EUIPO** pour la task force renaming (à explorer)

---

## 5. Skills Anthropic à utiliser

Les skills sont des modules préfabriqués qu'Anthropic fournit pour standardiser certaines tâches. Pour Péreneo, les skills utiles :

| Skill | Usage dans Péreneo |
|---|---|
| **frontend-design** | Dashboard Prospérenne, formulaires d'onboarding, UI email templates |
| **docx** | Génération de CGS, contrats clients, livrables consultants |
| **pdf** | Rapports trimestriels, exports Charli, factures automatisées |
| **xlsx** | Exports de données, rapports de performance, extractions Pipedrive |
| **pptx** | Pitch decks Prospérenne, supports commerciaux Charli |

Ces skills sont disponibles par défaut dans Claude (Desktop et Code). Pas d'installation requise, il suffit de les invoquer dans une tâche.

---

## 6. Fichiers locaux à créer

### 6.1 `local.settings.json` (gitignored)

À la racine du repo. Contient les vraies valeurs des variables d'environnement pour le run local.

**Structure attendue** :

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "<connection string>",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "TENANT_ID": "<tenant Microsoft>",
    "CLIENT_ID": "<app Azure AD>",
    "CLIENT_SECRET": "<secret, à renouveler périodiquement>",
    "DAVID_EMAIL": "david@oseys.fr",
    "MARTIN_EMAIL": "martin@oseys.fr",
    "MILA_EMAIL": "mila@oseys.fr",
    "ADMIN_EMAIL": "paul.rudler@oseys.fr",
    "PIPEDRIVE_TOKEN": "<token>",
    "PIPEDRIVE_COMPANY_DOMAIN": "oseys",
    "ANTHROPIC_API_KEY": "<sk-ant-...>",
    "MEM0_API_KEY": "<à ajouter Phase 2>",
    "QUEUE_NAME_RELANCES": "relances",
    "FUNCTION_APP_URL": "https://pereneo-mail-sender.azurewebsites.net",
    "FUNCTION_APP_HOST": "pereneo-mail-sender.azurewebsites.net",
    "PUBLIC_FORMS_BASE_URL": "<URL GitHub Pages>"
  }
}
```

**Règle absolue** : ce fichier ne doit **jamais** être commité. Vérifier qu'il est bien dans `.gitignore`.

### 6.2 `.env.example` (commité, pour référence)

Template vide qui liste les clés attendues, sans les valeurs. Permet à un nouveau contributeur de savoir ce qu'il doit remplir.

### 6.3 `.claude/settings.local.json` (gitignored)

Permissions locales de Claude Code (autorisations d'exécution bash, de modification de fichiers hors repo, etc.). Géré automatiquement par Claude Code, ne pas éditer à la main.

---

## 7. Checks de validation

Après installation, vérifier que tout fonctionne :

### 7.1 Claude Code démarre correctement

```bash
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
claude
```

Claude doit saluer et mentionner qu'il a lu `CLAUDE.md`.

### 7.2 Azure Functions Core Tools

```bash
func --version
```

Doit retourner `4.x.x`. Sinon :

```bash
brew tap azure/functions
brew install azure-functions-core-tools@4
```

### 7.3 `func start` local

```bash
func start
```

Doit lister les 9 endpoints Azure Functions (sendMail, davidInbox, etc.) et démarrer sur `http://localhost:7071`. Si erreur `0 functions found`, vérifier la structure (fonctions à la racine, pas sous `/functions/`) et le programming model v4.

### 7.4 Test pixel tracking

```bash
curl -v "http://localhost:7071/api/trackOpen?agent=martin&day=J0" > /tmp/pixel.gif
file /tmp/pixel.gif
```

Doit retourner `GIF image data, version 89a`.

### 7.5 Git remote pointe vers le bon repo

```bash
git remote -v
```

Doit afficher :

```
origin  https://github.com/GroupePerenne/Pereneo_agents.git (fetch)
origin  https://github.com/GroupePerenne/Pereneo_agents.git (push)
```

Si encore sur `Perennia_agents` ou `Prosperenne_agent` :

```bash
git remote set-url origin https://github.com/GroupePerenne/Pereneo_agents.git
```

### 7.6 Tests unitaires

```bash
npm test
```

Tous les tests doivent passer. Si échecs, ne pas push avant résolution. Référence règles méthodologiques : voir `CLAUDE_JOURNAL_v1.9.md` (corollaires C1-C10).

---

## 8. Workflow type Claude Code sur Péreneo

### 8.1 Démarrer une session de dev

```bash
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
git pull
claude
```

Donner à Claude Code la tâche précise, avec contexte :

> "Tâche : intégrer Mem0 dans le template manager-commercial. Contexte : Phase 2 du blindage Péreneo. Spec dans STRATEGY_v2.11.md §5.5. Commence par lire ARCHITECTURE.md et MEMO.md si présents à la racine."

### 8.2 Pattern de travail recommandé

1. **Explorer** — Claude Code lit les fichiers concernés et remonte ce qu'il comprend
2. **Plan** — Claude Code propose un plan (étapes, fichiers à toucher, tests à écrire)
3. **GO explicite** de Paul avant implémentation
4. **Implémenter par incréments** — une étape, un test, validation, étape suivante
5. **Commit** — Claude Code commit avec message clair
6. **Push** — uniquement après GO explicite de Paul

### 8.3 Règles absolues pendant le pilote

- Jamais de mail de test envoyé à un autre destinataire que **paul.rudler@oseys.fr**
- Jamais de `git push` sur `main` sans GO
- Jamais de `func azure functionapp publish` sans GO
- Jamais de suppression de données Pipedrive / Mem0 sans GO détaillé

---

## 9. Résolution de problèmes connus

### 9.1 `0 functions found` au `func start`

**Cause** : mauvaise structure de projet Azure Functions. La convention v3 attend les dossiers de fonctions à la racine, pas sous `/functions/`. La v4 attend un `src/index.js` avec `app.http(...)`.

**Solution** : vérifier que le projet est en v4 (`@azure/functions ^4.5.0` + `src/index.js`) et que `package.json` pointe `"main": "src/index.js"`.

### 9.2 Azure Cloud Shell heredoc casse au copy-paste

**Cause** : whitespace invisible avant le `EOF` de fin.

**Solution** : utiliser `printf` ou `echo` sur une seule ligne plutôt que heredoc.

### 9.3 `Mail.Read` permission refusée

**Cause** : permission pas accordée à l'app Azure AD.

**Solution** :

```bash
az ad app permission add --id <CLIENT_ID> \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 810c84a8-4a9e-49e6-bf7d-12d183f40d01=Role
az ad app permission admin-consent --id <CLIENT_ID>
```

Si l'admin-consent échoue, Paul le fait manuellement via le portail Azure AD.

### 9.4 `listKeys` storage account retourne 401

**Cause** : token d'app `client_credentials` ne marche pas pour `listKeys`.

**Solution** : utiliser un token `user_impersonation` (az login interactif).

### 9.5 Claude Desktop ne voit pas le repo local

**Cause** : `~/Documents/Professionnel/` pas dans les dossiers autorisés Filesystem MCP.

**Solution** : cf. section 4.1.

---

## 10. Actualisation du document

Ce document doit être mis à jour à chaque changement de stack outils :

- Nouveau plugin Claude Code évalué / adopté / retiré
- Nouveau MCP connecté
- Modification de la structure Azure (passage OVH, etc.)
- Changement de version Node ou Azure Functions Core Tools

**Responsable** : Paul + Claude. Toute recommandation d'optimisation de l'environnement de travail atterrit en §12 de `STRATEGY_v2.11.md`, et les actions prises sont répercutées ici.

---

*Fin de CLAUDE_CODE_SETUP.md — 28 avril 2026.*
