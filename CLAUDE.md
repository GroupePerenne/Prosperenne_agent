# CLAUDE.md — Brief de reprise pour Claude Code

> Ce fichier est ton point d'entrée sur le projet. Lis-le intégralement avant toute action. Il contient le contexte produit, l'état de l'infra, les secrets à récupérer, les pièges connus, et le plan de travail priorisé.

---

## 1. Identité du projet

**Nom technique** : `Prosperenne_agent` (anciennement `Mila_agent`)
**Nom commercial** : Prospérenne
**Owner** : Paul Rudler (paul.rudler@oseys.fr) — Président d'OSEYS GROUPE
**GitHub** : https://github.com/GroupePerenne/Prosperenne_agent
**Business** : OSEYS est un réseau de consultants en développement commercial. Le projet construit une équipe commerciale IA (3 agents) déployable pour les consultants du réseau, puis commercialisable à d'autres réseaux à terme.

### Les trois agents

| Agent | Rôle | Adresse mail | Nature |
|-------|------|--------------|--------|
| **David** | Manager commercial — interface consultants | `david@oseys.fr` (shared mailbox) | Agent LLM conversationnel |
| **Martin** | Prospecteur, profil masculin | `martin@oseys.fr` (licence Business Basic) | Worker semi-déterministe |
| **Mila** | Prospectrice, profil féminin | `mila@oseys.fr` (licence Business Basic) | Worker semi-déterministe |

**Règle architecturale clé** : seul David parle aux consultants. Martin et Mila ne contactent que les prospects externes. Leur `replyTo` pointe sur `david@oseys.fr`, donc toute réponse de prospect atterrit chez David, qui la lit via le timer `davidInbox` et prévient le consultant concerné.

### 1.5 Positionnement produit — David est manager, pas exécutant

David est le manager commercial de l'équipe. Il ne prospecte jamais lui-même. Son équipe Martin + Mila exécute la prospection ; David coordonne, brief, suit, rapporte. Le consultant utilisateur voit les trois dans son quotidien :
- David au jour le jour (onboarding, briefs, comptes rendus hebdo)
- Martin et Mila nommément dans les dashboards, rapports de performance, notifications de réponse prospect

Pitch produit : "une équipe commerciale IA de 3 personnes", pas "un chatbot commercial". La métaphore RH est assumée — c'est ce qui fait la valeur perçue.

### 1.6 Phase actuelle — pilote interne OSEYS

Avant de commercialiser Prospérenne, on valide en interne avec 2 consultants OSEYS : Morgane et Johnny. L'équipe David+Martin+Mila doit être opérationnelle end-to-end (les 3 ensemble, pas séquentiellement — David sans Martin/Mila n'a pas de valeur).

Conséquences pour le développement :
- Pas de multi-tenancy pour l'instant (un seul Function App, un seul tenant Microsoft 365 OSEYS, une seule instance Pipedrive)
- Les règles métier OSEYS (cible "vente d'heures", tranches 5-75 salariés, exclusions comptables/avocats) sont la config initiale mais doivent rester externalisables pour le pivot Prospérenne
- Pas d'OSEYS hardcodé dans le code : chaque texte "OSEYS" dans un prompt, template ou règle métier doit venir d'une variable d'env ou d'un fichier de config tenant, jamais d'une constante en dur
- Pilote avec assignation forcée (1 prospecteur par consultant) recommandé avant d'activer le mode "both" par défaut

**TODO avant pilote Morgane/Johnny** : résoudre les `user_id` Pipedrive des 2 consultants (via `GET /v1/users?term=<email>`) et passer `owner_id` au `pipedrive.createDeal` dans `agents/david/orchestrator.js` → `launchSequenceForConsultant`. Sans ça, tous les deals créés ont David comme owner, ce qui casse le rapport quotidien `dailyReport` qui filtre par `user_id` du consultant. Paul récupère les IDs ou Claude peut le faire automatiquement depuis les env vars `MORGANE_EMAIL` / `JOHNNY_EMAIL`.

### 1.7 Règles produit validées (session du 17 avril 2026)

**Rythme de la séquence de prospection** : 5 touches sur 28 jours ouvrés → **J0**, **J+4**, **J+10**, **J+18**, **J+28**. Tous les offsets sont comptés en jours ouvrés français (hors samedi, dimanche, jours fériés).

**Jours ouvrés uniquement** : aucun envoi prospect un samedi, dimanche ou jour férié français. Si un job (immédiat ou différé) tombe hors jour ouvré ou hors plage 9h-11h Paris, il est reporté au prochain créneau ouvré.

**Créneau d'envoi** : 9h-11h Paris pour tous les envois prospects (ouverture + relances). Heure locale Paris garantie par l'app setting `WEBSITE_TIME_ZONE=Romance Standard Time` sur le Function App.

**Rapport quotidien David** : 8h Paris du lundi au vendredi. Un mail par consultant actif contenant activité de la veille (envois, ouvertures, réponses, RDV), analyse comparative Martin/Mila si pertinent, propositions d'actions pour la journée.

**A/B testing Martin/Mila permanent** : les deux agents coexistent toujours, on optimise lead-par-lead. Aucun "choix d'un gagnant" qui supprimerait un agent.

**Bascule d'agent sur silence** : si un lead termine ses 28 jours ouvrés sans réponse, il est flagué `retry_available_after = today + 180j` avec `last_agent_attempted = <agent_courant>`. Future campagne → l'autre agent prend le relais.

**Opt-out permanent sur réponse négative** : un prospect qui répond négativement est retiré de toute future campagne, tous agents confondus (`opt_out_until = 9999-12-31`).

**Classification des réponses prospects (6 classes)** : `positive` / `question` / `neutre` / `negative` / `out_of_office` / `bounce`. Si la confidence LLM est < 0.7 → escalation humaine obligatoire via la règle d'honneur.

**Règle d'honneur David** (non négociable, s'applique aussi à Martin et Mila dans la génération de leurs messages) :
1. **Pas d'improvisation** sur les cas ambigus. En cas de doute → mail à `direction@oseys.fr` (env var `ESCALATION_EMAIL`) avec contexte, 2-3 propositions, reco personnelle. Attendre validation humaine avant d'agir.
2. **Pas d'invention** : aucun chiffre, benchmark, cas client, référence ou nom non sourçable.
3. **Pas de promesse** : pas de garantie de résultat, délai, taux. Formulations qualitatives uniquement.

**URL canonique dans les signatures** : `https://oseys.fr/dirigeant` (et non plus `https://oseys.fr` nu).

**Filtrage des leads existants** : avant le J0, David vérifie via Pipedrive si le prospect est déjà dans un deal actif d'un autre pipeline. Match clair (même email ou même `person_id`) → skip silencieux. Match flou (même nom d'entreprise, prénoms différents) → escalation au consultant owner du deal existant, pas d'envoi tant que pas de réponse.

**Prise de RDV via Microsoft Bookings** : chaque consultant a sa page Bookings personnelle, URL stockée dans son brief et injectée par David dans les réponses positives aux prospects.

**Pipedrive Smart BCC hybride** : envoi principal via Graph API (pour contrôle du template) + BCC vers l'adresse Smart Email Pipedrive unique du consultant (pour tracking natif + timeline deal). Env var `PIPEDRIVE_BCC_<CONSULTANT>` par consultant.

**Cutoff déploiement prod** : aucun `func azure functionapp publish` tant que Paul n'a pas validé la base de leads livrée par Constantin avec Claude lors d'une session dédiée. Le code reste prêt sur `main` en attendant.

### 1.8 Dépendances externes à ne pas casser

Certains IDs Pipedrive sont **hardcodés** dans `shared/pipedrive.js` parce qu'ils sont stables tant que les ressources correspondantes ne sont pas recréées. Si tu supprimes et recrées un des éléments ci-dessous, il faut resynchroniser.

**IDs d'options des enum fields** (dans `shared/pipedrive.js`) :
- `AGENT_SENDER_OPTION_ID` : `martin = 378`, `mila = 379`
- `LAST_AGENT_ATTEMPTED_OPTION_ID` : `martin = 380`, `mila = 381`

**Keys de custom fields Pipedrive** (en env var, mais recréer = régénérer le hash) :
- `PIPEDRIVE_FIELD_AGENT_SENDER` (deal)
- `PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED` (deal)
- `PIPEDRIVE_FIELD_OPT_OUT_UNTIL` (deal)
- `PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER` (deal)
- `PIPEDRIVE_PERSON_FIELD_EMAIL_BOUNCED_AT` (person)

**IDs de stages** (en env var) :
- `PIPEDRIVE_PIPELINE_ID=28` — pipe "Prospérenne — Prospection automatisée"
- `PIPEDRIVE_STAGE_NEW=251` à `PIPEDRIVE_STAGE_CLOSED_SILENCE=258`

**Procédure de resynchro** si recréation :
1. `GET /v1/pipelines` pour retrouver l'ID du pipe et de ses stages.
2. `GET /v1/dealFields` et `GET /v1/personFields` pour retrouver les `key` (hash) et les options.
3. Mettre à jour les env vars Azure + `local.settings.json` + les constantes `AGENT_SENDER_OPTION_ID` / `LAST_AGENT_ATTEMPTED_OPTION_ID` dans `shared/pipedrive.js`.

### 1.9 Architecture scalable à planifier (Tranche 8 — avant commercialisation)

Le projet va évoluer :
- Groupe Pérenne (ex-OSEYS) va créer PérennIA comme entité/filiale pour exploiter une gamme d'agents IA
- Prospérenne sera la première offre commerciale (prospection via David/Martin/Mila)
- Prochaines offres prévues : Responsable Technique (branché PilotagePro), Community Manager, Créateur de sites, Contrôleur de gestion, Assistante de direction
- Deux versions de David prévues : une "interne Groupe Pérenne" dédiée aux consultants OSEYS, une "Prospérenne" exploitée à grande échelle pour des clients externes

Implications pour l'architecture :
- Introduire une notion de tenant (`/tenants/<slug>/`) séparée du code template des agents
- Externaliser les règles métier (ICP, cible, ton, règles) en config JSON par tenant, plus jamais hardcoder dans les prompts
- Préparer des adapters pour les intégrations externes (CRM, mail, calendar) afin de pouvoir swap Pipedrive ↔ HubSpot, Graph ↔ autre provider, etc.

Cette refacto ne bloque pas le pilote interne mais doit être faite avant commercialisation Prospérenne. À traiter après validation base de leads + pilote Morgane/Johnny.

### Cœur de cible OSEYS — critère qualitatif #1

Les entreprises qui **vendent des heures** : agences, cabinets, ESN, bureaux d'études, services B2B, artisans avec salariés. 5 à 75 salariés, sweet spot 10-20. Problèmes communs : croissance plafonnée par les heures d'équipe, pricing sous-évalué, zéro prospection active. Ce critère pilote le ciblage des leads et la qualification des briefs consultant.

---

## 2. État actuel (push du 17 avril 2026, commit `d03fbae`)

### Ce qui est dans le repo

43 fichiers organisés en 4 dossiers (`agents/`, `shared/`, `functions/`, `forms/`) + la doc (`README.md`, `ARCHITECTURE.md`, `DEPLOY.md`, `.env.example`).

**Lis dans cet ordre avant d'agir :**
1. `README.md` — vue d'ensemble
2. `ARCHITECTURE.md` — flow complet, responsabilités de chaque agent
3. `DEPLOY.md` — procédure Azure pas à pas
4. `.env.example` — toutes les variables d'environnement attendues

### Ce qui est déjà déployé sur Azure

- **Function App** : `oseys-mail-sender` (Node 22, France Central, plan Consumption)
  - **URL de base** : `https://oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net`
- **Function déjà live et testée** : `sendMail` (envoie via Graph API, testée avec succès vers constantin.picoron@gmail.com lors d'une session précédente)
- **App registration Azure AD** : `OSEYS-ProspectionAgent`
  - Tenant ID : `70f9e20f-964f-4925-8dc2-b72d62384629`
  - Permission `Mail.Send` de type **Application** accordée + consentement admin donné
- **Storage account** attaché au Function App (requis pour la queue — vérifier qu'il existe, sinon en créer un)

### Ce qui N'EST PAS encore déployé

- Les 7 autres functions (`sendOnboarding`, `choixNiveau`, `onQualification`, `runSequence`, `trackOpen`, `scheduler`, `davidInbox`) — leur code est dans le repo mais pas encore publié sur Azure
- La queue Azure Storage `mila-relances` (sera créée automatiquement au premier appel à `shared/queue.js` via `ensureQueue()`)
- La permission `Mail.Read` sur l'app registration (nécessaire pour `davidInbox`) — À AJOUTER

### Ce qui reste à configurer hors-code

- Les 3 custom fields Pipedrive (voir section 8.2)
- GitHub Pages pour héberger le formulaire publiquement (voir section 8.3)
- Le warm-up des boîtes Martin et Mila (2-3 semaines avant volume)

---

## 3. Setup de l'environnement local

Prérequis macOS (Paul travaille sur Mac) :

```bash
# Vérifie les versions
node -v    # doit être ≥ 20
npm -v

# Azure Functions Core Tools (si absent)
brew tap azure/functions
brew install azure-functions-core-tools@4

# Azure CLI (pour récupérer les secrets existants)
brew install azure-cli
az login --tenant 70f9e20f-964f-4925-8dc2-b72d62384629
```

Installation des deps du projet :

```bash
cd ~/Downloads/Prosperenne_agent
npm install
```

---

## 4. Récupération des secrets (NE JAMAIS LES COMMITTER)

Les secrets existent déjà côté Azure — on les lit, on ne les recrée pas.

### 4.1 Depuis le Function App existant

```bash
# Liste les variables d'env déjà configurées sur oseys-mail-sender
az functionapp config appsettings list \
  --name oseys-mail-sender \
  --resource-group oseys-prospection-rg \
  --query "[].{name:name, value:value}" \
  -o table
```

Tu devrais voir au minimum : `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `FROM_EMAIL`, `AzureWebJobsStorage`.

### 4.2 Secrets à ajouter

Si ces clés ne sont pas encore dans le Function App, il faut les ajouter :

| Clé | Où la trouver |
|-----|---------------|
| `DAVID_EMAIL` | `david@oseys.fr` (statique) |
| `MARTIN_EMAIL` | `martin@oseys.fr` (statique) |
| `MILA_EMAIL` | `mila@oseys.fr` (statique) |
| `ADMIN_EMAIL` | `paul.rudler@oseys.fr` (statique) |
| `PIPEDRIVE_TOKEN` | Pipedrive > Personal Preferences > API (compte David) |
| `PIPEDRIVE_COMPANY_DOMAIN` | `oseys` (statique) |
| `PIPEDRIVE_STAGE_NEW/CONTACTED/REPLIED/CLOSED_LOST` | Créer le pipeline "OSEYS Prospection" dans Pipedrive, relever les IDs |
| `ANTHROPIC_API_KEY` | console.anthropic.com — créer une clé dédiée à ce projet si elle n'existe pas |
| `QUEUE_NAME_RELANCES` | `mila-relances` (statique) |
| `PUBLIC_FORMS_BASE_URL` | `https://groupeperenne.github.io/Prosperenne_agent/forms` (une fois GitHub Pages activé) |
| `FUNCTION_APP_HOST` | `oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net` |
| `CHOIXNIVEAU_FUNC_CODE` | Sera généré après le 1er déploiement de `choixNiveau` |

### 4.3 Fichier local `local.settings.json` (pour `func start`)

À créer à la racine du repo, **gitignored** :

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "<connection string du storage>",
    "TENANT_ID": "70f9e20f-964f-4925-8dc2-b72d62384629",
    "CLIENT_ID": "<de l'env Azure>",
    "CLIENT_SECRET": "<de l'env Azure>",
    "DAVID_EMAIL": "david@oseys.fr",
    "MARTIN_EMAIL": "martin@oseys.fr",
    "MILA_EMAIL": "mila@oseys.fr",
    "ADMIN_EMAIL": "paul.rudler@oseys.fr",
    "PIPEDRIVE_TOKEN": "<à demander à Paul ou lire depuis Azure>",
    "PIPEDRIVE_COMPANY_DOMAIN": "oseys",
    "ANTHROPIC_API_KEY": "<clé dédiée>",
    "QUEUE_NAME_RELANCES": "mila-relances",
    "FUNCTION_APP_HOST": "oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net"
  },
  "Host": {
    "CORS": "*"
  }
}
```

Commande Azure CLI pratique pour générer ce fichier automatiquement :

```bash
func azure functionapp fetch-app-settings oseys-mail-sender
```

---

## 5. Phase 1 — Audit et validation (AUCUN DÉPLOIEMENT)

Ordre strict. Chaque étape doit passer avant la suivante.

### 5.1 Validation syntaxique de tous les modules JS

```bash
# Tous les .js du projet doivent parser sans erreur
for f in shared/*.js agents/*/*.js functions/*/index.js; do
  node --check "$f" && echo "OK  $f" || echo "FAIL $f"
done
```

Attendu : 19 fichiers `OK`, 0 `FAIL`.

### 5.2 Résolution des imports

```bash
# Avec les deps installées, chaque module doit se charger
node -e "
const files = [
  'shared/graph-mail.js','shared/pipedrive.js','shared/anthropic.js',
  'shared/sequence.js','shared/queue.js','shared/templates.js','shared/worker.js',
  'agents/david/orchestrator.js','agents/david/onboarding.js',
  'agents/martin/worker.js','agents/mila/worker.js',
  'functions/sendMail/index.js','functions/sendOnboarding/index.js',
  'functions/choixNiveau/index.js','functions/onQualification/index.js',
  'functions/runSequence/index.js','functions/trackOpen/index.js',
  'functions/scheduler/index.js','functions/davidInbox/index.js'
];
for (const f of files) {
  try { require('./' + f); console.log('OK  ' + f); }
  catch(e) { console.log('FAIL ' + f + ' — ' + e.message.split(String.fromCharCode(10))[0]); }
}
"
```

### 5.3 Validation des JSON

```bash
for f in agents/*/identity.json functions/*/function.json host.json package.json; do
  jq empty "$f" 2>/dev/null && echo "OK  $f" || echo "FAIL $f"
done
```

### 5.4 Vérification cohérence identités / prompts

```bash
# Les avatar_url dans identity.json doivent pointer vers les fichiers existants du repo
node -e "
const fs = require('fs');
['david','martin','mila'].forEach(a => {
  const id = JSON.parse(fs.readFileSync('agents/'+a+'/identity.json','utf8'));
  const local = id.avatar_path;
  const ok = fs.existsSync(local);
  console.log((ok?'OK  ':'FAIL')+' '+a+' → '+local);
});
"
```

---

## 6. Phase 2 — Test local

### 6.1 Lancer la Function App en local

```bash
func start
```

Les 8 endpoints doivent monter sans erreur :

```
Http Functions:
  choixNiveau:       http://localhost:7071/api/choixNiveau
  davidInbox:        (timer, pas d'URL)
  onQualification:   http://localhost:7071/api/onQualification
  runSequence:       http://localhost:7071/api/runSequence
  scheduler:         (timer, pas d'URL)
  sendMail:          http://localhost:7071/api/sendMail
  sendOnboarding:    http://localhost:7071/api/sendOnboarding
  trackOpen:         http://localhost:7071/api/trackOpen
```

### 6.2 Tests curl en local (avant déploiement prod)

**Test 1 — pixel de tracking** (inoffensif, ne touche pas Pipedrive si pas de deal/person) :

```bash
curl -v "http://localhost:7071/api/trackOpen?agent=martin&day=J0" > /tmp/pixel.gif
file /tmp/pixel.gif   # doit dire "GIF image data"
```

**Test 2 — sendMail vers une adresse test** :

```bash
curl -X POST http://localhost:7071/api/sendMail \
  -H "Content-Type: application/json" \
  -d '{
    "from":"david@oseys.fr",
    "to":"paul.rudler@oseys.fr",
    "subject":"Test local",
    "html":"<p>Ceci est un test depuis func start local. Ignore.</p>"
  }'
```

Attendu : `{"success":true,...}` et un mail arrive dans la boîte de Paul.

**Test 3 — onQualification avec un brief minimal** :

```bash
curl -X POST http://localhost:7071/api/onQualification \
  -H "Content-Type: application/json" \
  -d '{
    "nom":"Paul Rudler",
    "email":"paul.rudler@oseys.fr",
    "entreprise":"OSEYS GROUPE",
    "offre":"Test depuis func start local",
    "prospecteur":"both",
    "secteurs":"conseil",
    "registre":"direct_cordial",
    "vouvoiement":"tu"
  }'
```

Attendu : deux mails arrivent chez Paul (un notif David, un accusé).

**Test 4 — sendOnboarding (end-to-end)** :

```bash
curl -X POST http://localhost:7071/api/sendOnboarding \
  -H "Content-Type: application/json" \
  -d '{"prenom":"Paul","nom":"Rudler","email":"paul.rudler@oseys.fr"}'
```

Attendu : mail d'onboarding avec les 3 boutons niveau + cartes Martin/Mila/both + lien formulaire. Cliquer sur un bouton doit ouvrir la page de confirmation et déclencher les 2 mails (accusé consultant + alerte admin).

### 6.3 Test du formulaire en local

```bash
# Sert forms/ sur un port local
npx serve forms -p 8080
# Puis ouvre http://localhost:8080/formulaire-oseys.html?nom=Paul+Rudler&email=paul.rudler@oseys.fr&entreprise=OSEYS+GROUPE
```

Vérifie visuellement :
- Les champs sont bien pré-remplis et surlignés orange
- Le progress bar se met à jour
- La soumission appelle bien `onQualification` (configure `SUBMIT_ENDPOINT` en dur vers localhost si besoin pour le test local)

---

## 7. Phase 3 — Déploiement Azure

### 7.1 Décision gate avant de publier

**STOP** — avant tout `func azure functionapp publish`, valide avec Paul :
- Que les tests locaux ont tous passé
- Que les variables d'env prod sont toutes en place
- Qu'il est conscient qu'on va remplacer le code actuel de `sendMail` (qui tourne déjà en prod)

### 7.2 Publication

```bash
# Option A — publication standard (remplace tout le code)
func azure functionapp publish oseys-mail-sender --javascript

# Option B — publication sans build (si les deps sont dans node_modules local)
func azure functionapp publish oseys-mail-sender --javascript --nozip
```

### 7.3 Vérification post-déploiement

```bash
# Liste des fonctions déployées (doit en montrer 8)
az functionapp function list \
  --name oseys-mail-sender \
  --resource-group oseys-prospection-rg \
  --query "[].name" -o tsv

# Récupère le code de la fonction choixNiveau pour construire l'URL
az functionapp function keys list \
  --name oseys-mail-sender \
  --resource-group oseys-prospection-rg \
  --function-name choixNiveau
```

### 7.4 Smoke tests en prod

Reprends les curl de la 6.2 en remplaçant `http://localhost:7071` par `https://oseys-mail-sender-c8cveseah3g8a9gs.francecentral-01.azurewebsites.net` et en ajoutant `?code=<function_key>` pour les endpoints protégés.

---

## 8. Configurations hors-code à finaliser

### 8.1 Permission `Mail.Read` sur l'app Azure AD

Sans ça, `davidInbox` ne pourra pas lire la boîte de David.

```bash
# Via Azure CLI (à tester, sinon via portail)
az ad app permission add \
  --id <CLIENT_ID de l'app OSEYS-ProspectionAgent> \
  --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 810c84a8-4a9e-49e6-bf7d-12d183f40d01=Role

# Puis consentement admin
az ad app permission admin-consent --id <CLIENT_ID>
```

Ou via portail : Azure AD > App registrations > OSEYS-ProspectionAgent > API permissions > Add > Microsoft Graph > Application permissions > `Mail.Read` > Grant admin consent.

### 8.2 Pipeline et custom fields Pipedrive

Créer dans Pipedrive (via l'UI web, côté Paul si tu n'as pas les droits admin) :

**Pipeline** : "OSEYS Prospection" avec 4 stages :

| Ordre | Nom | Variable env |
|-------|-----|--------------|
| 1 | Nouveau | `PIPEDRIVE_STAGE_NEW` |
| 2 | Contacté | `PIPEDRIVE_STAGE_CONTACTED` |
| 3 | A répondu | `PIPEDRIVE_STAGE_REPLIED` |
| 4 | Fermé — pas de suite | `PIPEDRIVE_STAGE_CLOSED_LOST` |

**Custom fields sur Deal** :
- `agent_sender` (type : Single option) — options : `martin`, `mila`, `both`
- `consultant_nom` (type : Text) — qui est le consultant propriétaire de ce lead

Noter les IDs retournés par l'API Pipedrive (`GET /v1/dealFields`) et les reporter dans `shared/pipedrive.js` ligne 106 (actuellement `agent_sender` en placeholder).

### 8.3 Activation de GitHub Pages

Dans Settings du repo > Pages :
- Source : `Deploy from a branch`
- Branch : `main` / `(root)` ou `/forms`

URL résultante : `https://groupeperenne.github.io/Prosperenne_agent/forms/formulaire-oseys.html`

Mettre à jour `PUBLIC_FORMS_BASE_URL` dans les env Azure une fois l'URL live.

### 8.4 Warm-up des boîtes Martin et Mila

Avant d'envoyer du volume (>10 mails/jour/boîte) aux prospects froids :
- Envoyer pendant 2 semaines des mails "internes" chaleureux (vers comptes OSEYS)
- Recevoir des réponses (important — le ratio envoyé/reçu compte pour les algos anti-spam)
- Augmenter progressivement le volume
- Vérifier SPF/DKIM/DMARC sur `oseys.fr` (normalement OK vu que c'est un tenant Microsoft 365 géré)

---

## 9. Pièges connus / lessons learned

### 9.1 Azure Function App sans Storage
L'actuel `oseys-mail-sender` a eu des problèmes pendant une session précédente parce que créé initialement sans Storage Account. Si tu recrées une Function App, **toujours** l'associer à un Storage Account dès la création, sinon le runtime ne trouve pas le code déployé.

### 9.2 Kudu VFS vs Azure Files
Sur Windows Consumption plan, déposer des fichiers via Kudu VFS (`/api/vfs/site/wwwroot/...`) ne les rend PAS visibles au runtime Functions, qui lit depuis le share Azure Files. Toujours passer par `func azure functionapp publish` ou par un ZIP deploy propre.

### 9.3 Permission Application vs Delegated pour Mail.Send
Le code utilise le flow `client_credentials` → il lui faut `Mail.Send` de type **Application**. Si quelqu'un a accordé uniquement la version **Delegated**, l'envoi plantera en 403 `Access denied`. Vérifier dans portail Azure AD > App > API permissions > type doit dire "Application".

### 9.4 Shared mailbox et envoi via Graph
Microsoft autorise l'envoi depuis une shared mailbox via Graph `POST /users/{id}/sendMail` dès lors que l'app a `Mail.Send` en Application scope. Pas besoin de licence sur la shared mailbox si elle ne dépasse pas 50 Go.

### 9.5 Pipedrive custom fields
Quand tu crées un custom field via l'API, son "key" est un hash unique (ex : `a1b2c3...`) — pas le nom humain. Ce hash doit être utilisé dans les appels `createDeal`. Récupère-le via `GET /v1/dealFields` une fois le field créé, et mets à jour `shared/pipedrive.js` (ligne ~106).

### 9.6 Les réponses aux prospects arrivent chez David
Volontaire : `replyTo: process.env.DAVID_EMAIL` dans `shared/worker.js`. Ne pas changer ça — c'est ce qui permet à David de faire son boulot d'orchestrateur.

### 9.7 Le pixel de tracking et les images bloquées
Beaucoup de clients mail bloquent les images par défaut. Le tracking d'ouverture est donc **une métrique indicative, pas fiable**. La métrique qui compte vraiment : taux de réponse. Ne pas sur-investir dans l'analytics d'ouverture.

---

## 10. DON'Ts (choses à ne JAMAIS faire sans validation explicite de Paul)

- **Ne jamais committer de secrets** (`PIPEDRIVE_TOKEN`, `CLIENT_SECRET`, `ANTHROPIC_API_KEY`) — utiliser les variables d'env Azure uniquement
- **Ne jamais supprimer la Function App `oseys-mail-sender`** (la fonction `sendMail` existante y tourne déjà — on l'écrase, on ne la supprime pas)
- **Ne jamais envoyer en volume à des prospects sans warm-up** (risque de blacklist `oseys.fr` sur les listes anti-spam)
- **Ne jamais modifier le fichier `CLAUDE.md`** (celui-ci) sans expliquer pourquoi à Paul — c'est la source de vérité du projet
- **Ne jamais faire de `git push --force` sur `main`** sans avoir validé
- **Ne jamais ajouter une dépendance lourde** (framework, ORM, etc.) sans discussion — on vise une stack minimale
- **Ne jamais générer les photos d'agents** via AI — les 3 avatars actuels ont été choisis spécifiquement par Paul pour leur cohérence visuelle
- **Ne jamais envoyer de mail à un vrai prospect depuis l'environnement de test local** — toujours utiliser `paul.rudler@oseys.fr` ou `constantin.picoron@gmail.com` pour les tests

---

## 11. Style de communication avec Paul

Paul préfère :
- **Tutoiement** systématique
- **Réponses courtes et directes** — pas de préambule, pas de "je vais faire X, puis Y, puis Z" qui répète la demande
- **Résultats d'abord, contexte ensuite** — si une commande a échoué, dis-le en premier, explique la cause en second
- **Aucun emoji** sauf si lui-même en utilise
- **Pas de listes à puces quand une phrase suffit**
- **Être proactif sur les risques** — si tu détectes un truc qui va casser en prod, dis-le AVANT de lancer la commande
- **Honnêteté sur les limites** — si tu ne sais pas, dis-le. Paul préfère une réponse incertaine à une réponse inventée.

Paul est fondateur, formé finance / business, à l'aise avec la technique mais pas développeur pro. Il comprend les enjeux d'archi, ne veut pas être noyé dans les détails d'impl sauf s'ils bloquent une décision.

---

## 12. Plan de travail priorisé pour cette session

### Priorité 1 — Validation (pas de déploiement)
1. Setup env local (§3) et récup secrets (§4)
2. Validation syntaxique + imports + JSON (§5.1, 5.2, 5.3)
3. `func start` et vérif que les 8 endpoints montent (§6.1)
4. Rapport d'audit à Paul

### Priorité 2 — Tests locaux
5. Smoke tests curl (§6.2) vers paul.rudler@oseys.fr uniquement
6. Test formulaire local (§6.3)
7. Si tout passe → validation de Paul avant déploiement

### Priorité 3 — Déploiement
8. `func azure functionapp publish oseys-mail-sender --javascript`
9. Smoke tests en prod (§7.4)
10. Config permissions manquantes (Mail.Read — §8.1)

### Priorité 4 — Configurations externes
11. Pipeline et custom fields Pipedrive (§8.2)
12. Activation GitHub Pages (§8.3)
13. Préparer le warm-up des boîtes Martin/Mila (§8.4)

### Priorité 5 — Itération
14. CI/CD GitHub Actions (voir README — "prochaines évolutions")
15. Dashboard de performance
16. Page web `/forms/choice.html` alternative au mail d'onboarding

---

## 13. Contacts et ressources

- **Paul** : paul.rudler@oseys.fr, +33 (0) 6 06 43 98 07
- **Compte de test consultant** : `constantin.picoron@gmail.com` (ne pas utiliser pour du vrai envoi commercial)
- **Tenant Microsoft 365 OSEYS** : `70f9e20f-964f-4925-8dc2-b72d62384629`
- **Pipedrive domain** : `oseys.pipedrive.com`
- **Anthropic console** : https://console.anthropic.com
- **Portail Azure** : https://portal.azure.com (tenant OSEYS)
- **Documentation Pipedrive API** : https://developers.pipedrive.com/docs/api/v1
- **Documentation Microsoft Graph** : https://learn.microsoft.com/en-us/graph/api/user-sendmail

---

## 14. En cas de doute

1. **Lire la section concernée de ce fichier ET l'ARCHITECTURE.md avant d'agir**
2. **Ne pas deviner un secret ou une URL** — les récupérer depuis Azure
3. **Demander à Paul** plutôt que prendre une décision produit à sa place
4. **Ne pas déployer** sans avoir passé les tests locaux
5. **Logger abondamment** (context.log dans les Azure Functions) — Application Insights est activé

---

_Dernière mise à jour : 17 avril 2026, commit d03fbae — rédigé par Claude (conversation projet avec Paul)._
