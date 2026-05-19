# CLAUDE_CODE_SETUP.md — Setup Claude Code pour Pereneo_agents

> **Audience** : Paul Rudler, puis futur profil tech qui rejoindra le projet (Richard quand il sera activé).
> **Objectif** : avoir un environnement Claude Code opérationnel et optimisé pour travailler sur le repo `Pereneo_agents` en moins de 30 minutes.
> **Dernière révision** : 1er mai 2026 (mise à jour §11 — résolution BL-43 via charli-mcp-proxy local).

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
- `~/Library/CloudStorage/OneDrive-OSEYSGROUPE/Direction Pérenne - Documents/`
- `~/Library/CloudStorage/OneDrive-OSEYSGROUPE/Réseau Pérenne - Documents/`
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

## 11. Charli en mémoire continue

> Section consignant la procédure d'activation et d'usage de Charli avec mémoire persistante via Claude Code CLI, indépendamment du bug Anthropic claude.ai web Custom Connectors (BL-27).
> **Révision 1er mai 2026** : ajout du proxy local `charli-mcp-proxy` pour résoudre BL-43 (refresh Bearer Entra automatique sur sessions longues). Version §11 antérieure conservée dans `_archive/CLAUDE_CODE_SETUP_pre-BL43_20260501.md`.
> Cohérence avec : CHARLI v1.5, ARCHITECTURE v5.7, MEMO v2.24.

### 11.1 Prérequis machine

- macOS Big Sur+ ou ultérieur (pour `security` Trousseau)
- Claude Code CLI ≥ 2.1.123 (vérifier `claude --version`)
- Outils unix : `jq`, `curl`, `mktemp`, `date`, `lsof` natifs ou via brew
- Node ≥ 22 (vérifier `node --version`) — requis par `charli-mcp-proxy`
- Compte Owner/Member sur workspace Anthropic Pereneo+OSEYS
- App Entra Anthropic Custom Connector créée et permission grant tenant-wide actée (déjà fait pour Paul, à refaire pour Constantin lors de son activation)

### 11.2 Architecture des fichiers Charli côté machine utilisateur

```
~/.local/bin/
  ├── charli-mcp-token.sh           # wrapper Bearer Entra v2 client_credentials
  └── charli-mcp-config-gen.sh      # génère MCP config JSON pointant sur proxy local

~/.local/share/charli-mcp-proxy/    # proxy local (BL-43)
  ├── proxy.js                      # serveur HTTP localhost:7843
  ├── tokenProvider.js              # wrapper child_process charli-mcp-token.sh
  ├── proxy.test.js + tokenProvider.test.js  # tests TDD node:test natif
  ├── package.json
  └── README.md

~/.config/charli/
  ├── system.md                     # system prompt Charli résident (CHARLI v1.5)
  ├── transmissions/                # notes de transmission inter-instances Charli
  └── scoping/                      # documents de scoping de chantiers (ex. BL-43)

~/.cache/charli/
  ├── token.json                    # cache Bearer 50 min, permissions 600
  ├── proxy.log                     # logs JSON-line stderr du proxy
  └── proxy.pid                     # PID du proxy en background

~/.bash_profile                     # contient la fonction shell `charli`

(éphémère, par session) :
/tmp/charli-mcp-config-{PID}-{TS}.json   # MCP config session, cleanup auto via trap
                                          # plus AUCUN secret depuis BL-43 résolu
```

### 11.3 Installation initiale (Paul, 30/04/2026, mise à jour 1er mai 2026)

#### 11.3.1 Trousseau client_secret Entra

```bash
security add-generic-password \
  -a "$USER" \
  -s "pereneo-charli-mcp-entra-client-secret" \
  -w
```

Saisie interactive masquée. Valeur récupérée depuis fiche Mots de Passe Apple `Pereneo Charli MCP — Entra Client Secret` (créée 29/04 chantier J4, keyId `fe3cd1a3-...`, expire 2028-04-29).

#### 11.3.2 Wrapper token

Création `~/.local/bin/charli-mcp-token.sh` (exécutable 755). Inchangé depuis 30/04. Fait :
- Cache check `~/.cache/charli/token.json` avec marge 5 min sur expiration
- Si cache invalide : lit Trousseau, POST `login.microsoftonline.com/{tenant}/oauth2/v2.0/token` flow `client_credentials`, scope `api://pereneo-charli-mcp/.default`, cache atomique (mktemp + mv)
- Stdout : token JWT v2

Variables hardcodées :
- `TENANT_ID=70f9e20f-964f-4925-8dc2-b72d62384629`
- `CLIENT_ID=b56c3465-e1a6-4699-87ed-fe0129c12f96` (Anthropic Custom Connector Paul)
- `SCOPE=api://pereneo-charli-mcp/.default`
- `KEYCHAIN_SERVICE=pereneo-charli-mcp-entra-client-secret`

#### 11.3.3 Wrapper MCP config — version BL-43 (1er mai 2026)

Création `~/.local/bin/charli-mcp-config-gen.sh` (exécutable 755). **Refonte** : ne génère plus de Bearer dans le JSON, pointe sur le proxy local.

```bash
#!/usr/bin/env bash
set -euo pipefail
PROXY_PORT="${CHARLI_MCP_PROXY_PORT:-7843}"
PROXY_HOST="${CHARLI_MCP_PROXY_HOST:-127.0.0.1}"
jq -n \
  --arg url "http://${PROXY_HOST}:${PROXY_PORT}/mcp" \
  '{ mcpServers: { "mem0-charli": { type: "http", url: $url } } }'
```

Sortie :
```json
{
  "mcpServers": {
    "mem0-charli": {
      "type": "http",
      "url": "http://127.0.0.1:7843/mcp"
    }
  }
}
```

**Plus aucun secret ne transite par ce fichier**. Le proxy local injecte le Bearer fresh à chaque requête.

#### 11.3.4 System prompt Charli

Création `~/.config/charli/system.md` (~115 lignes). Source : CHARLI v1.5 enrichi avec sections "Force de proposition", "Discipline interlocuteur unique", "Cadre courant état Pereneo".

En cas de mise à jour CHARLI v1.6+, ce fichier doit être resynchronisé manuellement par Paul ou par Charli homologue lui-même.

#### 11.3.5 Fonction shell `charli` — version BL-43 (1er mai 2026)

Ajoutée à `~/.bash_profile`. **Refonte** : auto-démarrage du proxy `charli-mcp-proxy` si pas en écoute, avant génération MCP config.

```bash
charli() {
  local mcp_config="/tmp/charli-mcp-config-$$-$(date +%s).json"
  local system_prompt_file="$HOME/.config/charli/system.md"
  local proxy_port="${CHARLI_MCP_PROXY_PORT:-7843}"
  local proxy_script="$HOME/.local/share/charli-mcp-proxy/proxy.js"
  local proxy_log_dir="$HOME/.cache/charli"
  local proxy_log="$proxy_log_dir/proxy.log"
  local proxy_pid_file="$proxy_log_dir/proxy.pid"

  # Vérifs préalables...

  # Auto-start charli-mcp-proxy si pas déjà en écoute (BL-43)
  if ! lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; then
    mkdir -p "$proxy_log_dir"
    chmod 700 "$proxy_log_dir"
    nohup node "$proxy_script" >> "$proxy_log" 2>&1 &
    echo $! > "$proxy_pid_file"
    local i=0
    while ! lsof -nP -iTCP:"$proxy_port" -sTCP:LISTEN >/dev/null 2>&1; do
      sleep 0.2
      i=$((i+1))
      if (( i > 15 )); then
        echo "Error: charli-mcp-proxy failed to start, see $proxy_log" >&2
        return 1
      fi
    done
  fi

  charli-mcp-config-gen.sh > "$mcp_config" 2>/dev/null
  chmod 600 "$mcp_config"
  trap "rm -f '$mcp_config'" RETURN INT TERM

  claude \
    --append-system-prompt "$(cat "$system_prompt_file")" \
    --mcp-config "$mcp_config" \
    "$@"
}
```

Le proxy persiste entre sessions (Node idle ~15 Mo). Réutilisé tant qu'il est en écoute. Auto-redémarré si crashé entre deux sessions.

#### 11.3.6 Installation `charli-mcp-proxy` (BL-43, nouvelle 1er mai 2026)

Le proxy intercepte les requêtes MCP côté Claude Code et injecte un Bearer Entra v2 fresh à chaque appel via `tokenProvider.fetchToken()` qui invoque `charli-mcp-token.sh` (cache fichier 50 min). Forward HTTPS vers Container App `mem0-mcp-charli`.

**Stack** : Node 22 natif (http, https, child_process). Zéro dépendance externe. ~150 lignes + tests.

**Déploiement initial** :

```bash
# 1. Créer le dossier (ou git clone si versionné ailleurs)
mkdir -p ~/.local/share/charli-mcp-proxy

# 2. Copier proxy.js, tokenProvider.js, package.json depuis livraison Charli Code
# (chantier BL-43 1er mai 2026, cf. ~/.config/charli/scoping/BL-43-token-refresh.md)

# 3. Vérifier les tests passent
cd ~/.local/share/charli-mcp-proxy && node --test
# Attendu : 10/10 tests verts (5 proxy + 4 tokenProvider + 1 buildHeaders)

# 4. Premier démarrage manuel pour smoke
node proxy.js &
curl -sS http://127.0.0.1:7843/mcp -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
# Attendu : 200 OK + serverInfo @pinkpixel/mem0-mcp v0.6.4
```

**Variables d'environnement** (toutes optionnelles) :

| Var | Défaut |
|---|---|
| `CHARLI_MCP_PROXY_PORT` | `7843` |
| `CHARLI_MCP_PROXY_HOST` | `127.0.0.1` |
| `CHARLI_MCP_UPSTREAM` | URL Container App `mem0-mcp-charli` |
| `CHARLI_MCP_TOKEN_SCRIPT` | `~/.local/bin/charli-mcp-token.sh` |

**Codes retour proxy** :
- `200..299` : forward upstream tel quel
- `503 token_unavailable` : `charli-mcp-token.sh` a échoué (Trousseau verrouillé, réseau Entra down)
- `502 upstream_unavailable` : Container App injoignable
- `4xx/5xx upstream` : forward tel quel (auth refusée, 429, etc.)

**Logs** : JSON line par event sur stderr, redirigés vers `~/.cache/charli/proxy.log` par la fonction shell.

### 11.4 Usage quotidien

```bash
charli                                              # session interactive
charli "résume où on en est sur le pilote David"    # one-shot prompt
```

Une fois la session Claude Code lancée :
- Vérifier `/mcp` → `mem0-charli` doit apparaître en `✓ connected` sous "Built-in MCPs (always available)"
- Le proxy `charli-mcp-proxy` tourne en background sur 127.0.0.1:7843, transparent pour Claude Code
- Sessions arbitrairement longues sans friction (BL-43 résolu) — le proxy refait le round-trip Entra à chaque expiration cache token (~50 min)
- Autres MCP claude.ai workspace coexistent (Microsoft 365 Connected, autres dormants)

### 11.5 Concurrence — sessions parallèles

**OK sans friction** : tu peux lancer `charli` dans plusieurs terminaux simultanément. Token cache partagé (écriture atomique mktemp+mv), MCP config éphémère unique par session ($$+timestamp), trap cleanup par session. **Le proxy charli-mcp-proxy est partagé** entre toutes les sessions concurrentes (1 seul process Node sur port 7843, multi-thread implicite via event loop).

**Discipline** : toutes les sessions écrivent dans le **même** namespace `user_id=charli`. Si tu lances 2 sessions concurrentes sur le même sujet, doublons possibles (chacune écrit son interprétation). Discipline : ouvrir des sessions parallèles sur des sujets **distincts**.

**Limite douce volume** : à 4-5 sessions massives concurrentes faisant beaucoup d'`add_memory`, surveiller quota Mem0 Cloud Starter (19$/mois). Volume actuel séances stratégiques : aucun risque.

### 11.6 Discipline R-CRED tenue (mise à jour BL-43)

| Matériau | Stockage | Exposition |
|---|---|---|
| Client secret Entra (valable 2 ans) | Trousseau macOS chiffré | Jamais |
| Token Bearer dérivé (~1h) | `~/.cache/charli/token.json` (600) | Local seulement, expire vite |
| Token Bearer dans MCP config | **Aucun** depuis BL-43 résolu (proxy gère injection runtime) | Aucune |
| Token dans output Claude Code | Aucune | À la différence de `claude mcp add --header` (BL-31) |
| Token entre Claude Code et proxy local | `127.0.0.1:7843` plain HTTP loopback (proxy injecte) | Process local seulement |

**Gain BL-43 collatéral pour BL-31** : depuis cette refonte, plus aucun fichier `/tmp/charli-mcp-config-*.json` ne contient de Bearer. Le risque "leak token via fichier mcp-config" est neutralisé.

**Leçon BL-31** : ne jamais utiliser `claude mcp add --header "Authorization: Bearer ..."` qui leak le token dans l'output terminal et `~/.claude.json` global. Toujours via `--mcp-config` avec fichier éphémère + trap cleanup, comme la fonction `charli` le fait — désormais sans même de Bearer dans ce fichier.

### 11.7 Renouvellement client_secret (rotation 2 ans)

Le client_secret Entra Paul expire `2028-04-29T~`. Procédure de rotation :

1. Lancer `az ad app credential reset --id b56c3465-... --display-name "Anthropic Custom Connector Secret rotated 2028-XX" --years 2 -o json > /tmp/secret.json`
2. Copier la valeur depuis `/tmp/secret.json` vers Trousseau via `security add-generic-password -U` (update)
3. Cleanup `/tmp/secret.json` via `rm -P`
4. Tester `charli-mcp-token.sh` retourne token valide
5. Tester `charli` lance MCP server connecté

R-CRED stricte : pas de transit chat, pas de copier-coller manuel via presse-papier (qui peut être lu par d'autres apps).

### 11.8 Activation Constantin (différée)

Quand Constantin signale qu'il veut activer (paquet de passage 30/04 §1.4) :

1. **Côté Paul ou Constantin** : création app Entra dédiée `Anthropic Custom Connector — Charli (Constantin)`, génération secret 2 ans, permission grant tenant-wide AllPrincipals scope `mcp.access` sur Resource Server `73d93dc9-...`.
2. **Côté Constantin machine** : Trousseau (ou équivalent password manager si Constantin n'est pas macOS), wrapper `charli-mcp-token.sh` adapté avec son propre `CLIENT_ID`, `charli-mcp-config-gen.sh` identique, `system.md` identique, fonction shell `charli` dans son shell config (zsh ou bash). **Et déploiement de `charli-mcp-proxy`** dans `~/.local/share/charli-mcp-proxy/` (cf. §11.3.6).
3. **Test** : `charli` chez Constantin → `/mcp` → `mem0-charli` Connected → premier add_memory + search_memory réels, session >1h pour valider absence régression BL-43.

Avantages de la séparation :
- Audit Entra distinct par utilisateur (qui a accédé au MCP, à quelle date)
- Révocation chirurgicale possible (révoquer Constantin sans toucher Paul)
- Cloisonnement BL-25 futur si nécessaire (filtrage côté serveur par `azp`)

Effort estimé : 30-45 min en pair Paul/Constantin (la procédure est rodée pour Paul, le pattern se reproduit, ajout du proxy = 5 min en plus).

### 11.9 Diagnostic et dépannage

**Symptôme : `charli` retourne "Error: charli-mcp-config-gen.sh not in PATH"**
→ Vérifier `~/.local/bin` est dans `$PATH`. Source `~/.bash_profile` ou ouvrir nouveau terminal.

**Symptôme : `charli` retourne "Error: charli-mcp-proxy failed to start"**
→ Lire `~/.cache/charli/proxy.log` pour le détail. Causes probables : port 7843 déjà occupé par un autre process (vérifier `lsof -nP -iTCP:7843`), Node manquant ou ancien (`node --version` doit être ≥22), fichier `proxy.js` absent (vérifier `ls ~/.local/share/charli-mcp-proxy/`).

**Symptôme : `charli` lance Claude Code mais `/mcp` montre `mem0-charli` ✗ failed**
→ Faire un test direct du proxy :
```bash
curl -sS http://127.0.0.1:7843/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"1"}}}'
```
Si 503 : token KO (`charli-mcp-token.sh` échoue, voir Trousseau et expiration Entra app). Si 502 : Container App injoignable (vérifier réseau, statut Azure). Si 200 : le problème est côté Claude Code, pas le proxy.

**Symptôme : `charli` plante avec "Error: failed to generate MCP config"**
→ `charli-mcp-config-gen.sh` a échoué. Test direct, lire stderr. Peut être : `jq` manquant, problème permission shell.

**Symptôme : long-running session perd Mem0 après ~1h** (BL-43 régression)
→ Ne devrait plus arriver depuis BL-43 résolu. Si récidive : vérifier que la session Claude Code utilise bien la fonction `charli` actuelle (depuis `.bash_profile` à jour), pas une ancienne config statique. `cat /tmp/charli-mcp-config-*.json` doit montrer URL `127.0.0.1:7843`, pas Container App direct.

**Symptôme : `claude --version` retourne erreur ou ancien**
→ Mettre à jour Claude Code via npm ou brew selon installation initiale. Vérifier `which claude`.

### 11.10 Prochaines évolutions évoquées

- **BL-35 P3 doc** (proposé séance 30/04) : Évaluer ajout Filesystem MCP côté `charli` shell function pour accès direct repo local Pereneo_agents si Paul juge utile pour Charli en exécution Phase B+ et Phase C+. Si activé, ajouter `--mcp-config` second JSON pour Filesystem MCP.
- **Cockpit Pereneo v0** : à activer post Phase C, intégrera potentiellement un trigger UI `charli` web/mobile (re-route sur le MCP cloud le jour où le bug Anthropic upstream sera fixé).
- **Optimisation cache token mémoire dans le proxy** (futur si friction réelle) : actuellement le proxy invoque `charli-mcp-token.sh` à chaque request HTTP, le script lui-même cache fichier 50 min. Overhead `spawnSync` ~5-50 ms par request. Si volume Mem0 monte beaucoup, cache mémoire dans le proxy avec TTL aligné supprimerait cet overhead. ROI faible aujourd'hui, à reconsidérer après Phase E commercialisation.

---

*Fin de CLAUDE_CODE_SETUP.md — 1er mai 2026.*
