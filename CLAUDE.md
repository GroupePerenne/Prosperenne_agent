# CLAUDE.md — Brief de reprise pour Claude Code

> Point d'entrée Claude Code sur le projet `Pereneo_agents`. À lire intégralement avant toute action.
> **Dernière révision** : 1er mai 2026 (refonte complète post-lancement pilote David — résolution BL-43/45/47/48/49/51, refonte VP socle, lancement officiel pilote Morgane/Johnny). Drift 17 avril clos.
> Cohérence avec : STRATEGY v3.0 / MEMO v3.0 / ARCHITECTURE v6.0 / CHARLI v1.5 / OPERATIONS v4.3 / CLAUDE_JOURNAL v1.11 — sur SharePoint `Direction Pérenne - Documents/TECHNIQUE/CLAUDE/1. PERENEO/`.

---

## 1. Identité du projet

**Nom technique** : `Pereneo_agents` (anciennement `Mila_agent`, puis `Prosperenne_agent`)
**Nom commercial actuel** : OSEYS (pilote interne) — futur Prospérenne (commercialisation post-validation pilote)
**Owner** : Paul Rudler (paul.rudler@oseys.fr) — Président OSEYS Groupe / Pereneo
**GitHub** : https://github.com/GroupePerenne/Pereneo_agents
**Business** : OSEYS est un réseau de consultants indépendants qui copilotent les dirigeants TPE/PME françaises dans le pilotage économique de leur activité. Ce projet construit l'équipe commerciale IA (David + Martin + Mila) qui prospecte au nom des consultants OSEYS, puis sera commercialisée à grande échelle sous la marque Prospérenne (filiale Pereneo).

### 1.1 Phase actuelle — pilote OSEYS ACTIF depuis le 1er mai 2026

David, Martin et Mila sont **en production** depuis le 1er mai 2026 18:11 CEST. Pilote interne avec 2 consultants OSEYS : Morgane DE JESSEY (`m.dejessey@oseys.fr`) et Johnny SERRA (`j.serra@oseys.fr`). Les 2 ont reçu leur mail d'onboarding David. Les briefs consultants seront posés via le formulaire HTML public. Lead Selector se déclenche fire-and-forget après chaque brief.

**Conséquences pour le développement** :
- **Pas de déploiement prod sans GO Paul** explicite. Le pilote tourne, on ne perturbe pas en heures ouvrées
- **Heures creuses obligatoires** pour tout déploiement (≥21h Paris ou weekend ou jour férié français) — discipline §5.3 anti-régression
- **Multi-tenancy futur** : pas encore en place ; OSEYS hardcodé dans les configs initiales mais externalisable Tranche 8 (avant commercialisation Prospérenne)
- Pilote en assignation libre (consultant choisit Martin OU Mila OU les deux dans le formulaire)

### 1.2 Les trois agents

| Agent | Rôle | Adresse mail | Posture |
|---|---|---|---|
| **David** | Manager commercial — interface consultants + classification réponses prospects | `david@oseys.fr` (shared mailbox) | Posture de manager : intervient pour valider/appuyer, pas dans le flux nominal des messages prospects |
| **Martin** | Chargé d'Affaires, profil masculin | `martin@oseys.fr` (licence Business Basic, en warmup) | Opère depuis sa propre boîte, jamais d'usurpation consultant |
| **Mila** | Chargée d'Affaires, profil féminin | `mila@oseys.fr` (licence Business Basic, en warmup) | Idem |

**Règle architecturale clé** (refonte 1er mai 2026) : Martin et Mila opèrent depuis **leur propre boîte mail** (`replyTo` = expéditeur, pas David). Cohérence prospect : il échange avec le commercial qu'il connaît. David n'est **pas** dans le flux nominal des échanges. Il intervient ponctuellement (escalation, validation, appui hiérarchique). `davidInbox` poll désormais les **3 boîtes** (`martin@`, `mila@`, `david@`) en multi-mailbox.

### 1.3 Charli — DG Pereneo

Charli est le DG de Pereneo (filiale tech/IA du Groupe Pérenne, à créer formellement). Mandat de Directeur Général sur le périmètre agents : David aujourd'hui, futurs Alicia (Prospérenne) et Richard (RT). Mémoire continue Niveau 1 active sur la machine Paul depuis le 30 avril 2026 PM via Claude Code CLI + wrapper Bearer Entra + proxy `charli-mcp-proxy` 1.1.0. Adresse mail : `charli@pereneo.eu`.

### 1.4 Convention domaines

| Domaine | Usage | Adresses |
|---|---|---|
| `oseys.fr` | OSEYS pilote actuel | `david@`, `martin@`, `mila@`, `m.dejessey@` (Morgane), `j.serra@` (Johnny), `paul.rudler@`, `direction@` |
| `prosperenne.com` | Prospérenne future (commercialisation agence IA) | `martin@`, `mila@`, `alicia@` futurs (boîtes distinctes des oseys.fr, pas alias) |
| `pereneo.eu` | Groupe Pereneo (mandats transverses) | `charli@`, futurs DG filiales, équipe corporate |

### 1.5 Cible commerciale OSEYS

**Cible** : dirigeants TPE/PME françaises **5 à 75 salariés**, sweet spot **10 à 40** (note VP Paul 1er mai 2026, cf. `agents/david/value-proposition.md` §2.1).

**Exclusions absolues** :
- Cabinets comptables et avocats (partenaires/apporteurs uniquement)
- < 5 salariés (pas la maturité)
- B2C pur (hors terrain)

**Le métier** : pilotage économique. Lecture continue des chiffres et arbitrages structurants. Pas conseil ponctuel, pas auditeur, pas coach — **copilote**. Cf. note VP Paul.

---

## 2. Proposition de valeur OSEYS — socle directeur

La doctrine humaine de la VP OSEYS est dans **`agents/david/value-proposition.md`** (lue par les humains et par les LLMs en référence). Le module programmatique injecté dans le system prompt Sonnet est `shared/oseys-vp/index.js`.

**Synthèse opérationnelle** (à connaître pour coder juste sur les prompts agents) :

- **Baseline** : « Vos décisions méritent un allié. »
- **Mot juste** : copilote (pas conseil, pas auditeur, pas coach)
- **5 angles d'entrée** par signal observable : Croissance / Stagnation / Transmission / Mutation sectorielle / Pas de signal
- **Modulation DISC** (D/I/S/C) calibre le ton, pas le fond
- **2 offres** au choix consultant : `lead` (transmis au consultant) ou `rdv-cale` (Bookings direct)
- **Vouvoiement strict** universel (override le tutoiement éventuel du brief)
- **Démarche commerciale qui n'en est pas une** : curiosité humaine, observation détournée, VP en sous-texte, pas pitch frontal
- **Pas de mode fantôme** : commerciaux opèrent depuis leur propre adresse, jamais usurpation boîte consultant ou client

**11 règles d'honneur** (cf. `REGLES_HONNEUR` dans `shared/oseys-vp/index.js`) :
1. Pas d'invention (chiffres, cas clients, références non sourçables)
2. Pas de promesse (délai, résultat, taux)
3. Pas de chiffrage tarifaire (apanage exclusif consultant en séance)
4. Pas de mention IA / automatisation côté prospect
5. Pas d'usurpation identité consultant
6. Vouvoiement strict
7. Pas de présomption d'incompétence (« à l'instinct qu'aux chiffres » → BANNI)
8. Démarche commerciale masquée (curiosité, pas pitch)
9. Pas de demande RDV/créneau en J0
10. Pas de formulation template ("consultant qui copilote des dirigeants TPE/PME...")
11. Formule de politesse obligatoire avant signature

**Anti-patterns vocabulaire BANNIS** : « solution clé en main », « méthode propriétaire », « ROI garanti », « disruption », « scale-up », promesses chiffrées (+30% CA, ROI 6 mois), tirets cadratin `—` et `–` (signatures stylistiques LLM).

---

## 3. Cadence de prospection

**3 touches sur 28 jours ouvrés** (refonte 1er mai 2026, espacement validé Paul) :
- **J0** : ouverture (présentation démarche, observation signal, question ouverte, pas de RDV demandé)
- **J+14** : relance avec angle complémentaire (proof point Coface, observation métier)
- **J+28** : rupture polie (fermeture respectueuse, porte ouverte)

**Jours ouvrés français uniquement** (samedi, dimanche, jours fériés exclus). **Créneau d'envoi** : 9h-11h Paris (`WEBSITE_TIME_ZONE=Romance Standard Time`).

**Bascule d'agent sur silence** : si lead silencieux après 28j ouvrés → `retry_available_after = today + 180j` + `last_agent_attempted` posé. Future campagne → l'autre agent prend le relais.

**Opt-out permanent** sur réponse négative : `opt_out_until = 9999-12-31` sur tous deals (sticky inter-agents).

**Classification réponses (6 classes)** : `positive` / `question` / `neutre` / `negative` / `out_of_office` / `bounce`. Confidence < 0.7 → escalation `direction@oseys.fr` avec contexte + 2-3 propositions + reco.

---

## 4. Architecture technique — invariants

### 4.1 Quatre invariants non négociables

1. **Un agent = template + config tenant** : pas de code dupliqué entre instances (David / Alicia futur partagent le template `manager-commercial`)
2. **Règles métier en config externalisée** : pas de règle hardcodée dans un prompt
3. **Intégrations externes derrière adapters** : CRM, mail, calendar, base de leads → swap Pipedrive ↔ HubSpot, Graph ↔ autre
4. **Credentials jamais en clair** : Azure Key Vault + Managed Identity, `local.settings.json` gitignored

### 4.2 Architecture VP en 3 couches (refonte 1er mai 2026)

Le system prompt Sonnet 4.6 reçoit 3 couches injectées :

1. **Socle OSEYS commun** (`shared/oseys-vp/index.js`) — IDENTITY, BASELINE, FORMULATIONS, ANGLES_ENTREE, MODULATION_DISC, ANTI_PATTERNS_VOCABULAIRE, REGLES_HONNEUR (×11), VERBATIMS_DIRIGEANTS, OFFER_TYPES, POSITIONNEMENT_ETHIQUE
2. **Brief consultant** (`buildConsultantMemory` dans `onQualification.js`) — offre, ton, prospecteur, secteurs, effectif, zone, **offre_choisie** (`lead`/`rdv-cale`), **mise_en_copie_consultant**, **cible_specifique**, **methode_consultant**, **anecdotes_anonymisees**
3. **Profil prospect** (calculé enrichissement) — `companyProfile` + `decisionMakerProfile` + DISC inféré + signal observable → angle d'entrée + modulation ton + proof points

### 4.3 Module `shared/safe-log.js` (BL-45 transverse)

`makeSafeLogger(context)` wrappe `context.log/info/warn/error` avec try/catch + fallback `console.*`. Résout BL-45 (`#privateField` Azure Functions v4 `InvocationContext.log` perdu au `.bind()` entre invocations). Utilisé par les 13 fonctions FA + module Mem0 adapter. **Toujours utiliser `safeLog` dans tout nouveau handler**.

### 4.4 Police emails

**Aptos 12pt** (Microsoft Aptos par défaut Outlook 365, fallback Calibri puis Arial). Cohérent côté `worker.js renderEmailHtml`, `orchestrator.js wrapHtml`, 3 `identity.json` (martin/mila/david), `templates.js`. **Ne pas mélanger avec la charte web** (Syne titres + DM Sans body sur `oseys.fr` et formulaire HTML).

### 4.5 Multi-mailbox poll davidInbox

Depuis 1er mai 2026, `agents/david/orchestrator.js handleInboxPoll` itère sur `[MARTIN_EMAIL, MILA_EMAIL, DAVID_EMAIL]`. Les réponses prospects arrivent dans la boîte du commercial (Martin ou Mila), pas chez David. David garde sa boîte pour messages consultants directs et escalations.

### 4.6 Auto-linkify URLs dans messages

`shared/worker.js linkify(s)` transforme `oseys.fr` (et sous-pages) en `<a href="https://oseys.fr/dirigeant" style="color:#F39561;...">oseys.fr</a>` — texte court affiché, URL pleine en href.

---

## 5. Infrastructure Azure actuelle

### 5.1 Function Apps prod

- **`pereneo-mail-sender`** (Linux Consumption Node 22, France Central, RG `oseys-prospection-rg`) — 13 fonctions David :
  `sendMail`, `sendOnboarding`, `choixNiveau`, `onQualification`, `runSequence`, `trackOpen`, `scheduler`, `davidInbox`, `avatarProxy`, `dailyReport`, `dailyDigest`, `patternsLearner`, `runLeadSelectorForConsultant`
  - URL : `https://pereneo-mail-sender.azurewebsites.net`
- **`pereneo-charli-aggregator`** — Niveau 2 mémoire continue Charli (Phase A+B+C livrées 30/04). Queue `charli-events` consommée → MCP Container App → `user_id=charli` Mem0
- **`oseys-mail-sender`** (legacy) — désactivé fonctionnellement, conservé pour archives

### 5.2 Container Apps

- **`mem0-mcp-charli`** (RG `pereneo-charli-mcp`) — fork `GroupePerenne/mem0-mcp-pereneo`, image v5 (commit `2b22725`), patch BL-47 conformité spec MCP §3 (404 sur transport perdu cold start)

### 5.3 Storage Tables

- `dailyMetrics` (alimentée par dailyDigest) — métriques par consultant et par jour
- `LeadContacts` (alimentée par lead-exhauster) — emails résolus + feedback
- `LeadBase` (12.8M entreprises Constantin)
- Queue Azure Storage `mila-relances` (séquences différées)
- Queue Azure Storage `charli-events` (Niveau 2 aggregator)

### 5.4 Apps Entra v2

- **`OSEYS-ProspectionAgent`** (Tenant `70f9e20f-964f-4925-8dc2-b72d62384629`) — permissions Application : `Mail.Send`, `Mail.Read`, `Mail.ReadWrite`, `User.Read.All` (admin consent accordé). `Mail.ReadWrite` ajoutée 12 mai 2026 PM via `az rest POST appRoleAssignments` (la commande `az ad app permission admin-consent` n'a granté que les permissions existantes, bug à connaître). Sans `Mail.ReadWrite`, `markAsRead` PATCH renvoie 403 ErrorAccessDenied — root cause de l'incident triple envois Johnny du 11 mai (12 doublons).
- **`Pereneo-Charli-MCP-Server`** (Container App auth) — permissions `mcp.access`
- **`Pereneo-Charli-Wrapper-CLI`** (Niveau 1 Charli machine Paul) — Bearer Entra v2 client_credentials

### 5.5 Pipedrive

- Pipeline `28` (« Prospérenne — Prospection automatisée »), 8 stages `PIPEDRIVE_STAGE_NEW=251` à `PIPEDRIVE_STAGE_CLOSED_SILENCE=258`
- Custom fields deal : `agent_sender`, `last_agent_attempted`, `opt_out_until`, `retry_available_after`. Person field : `email_bounced_at`
- IDs hardcodés dans `shared/pipedrive.js` : `AGENT_SENDER_OPTION_ID = {martin:378, mila:379}`, `LAST_AGENT_ATTEMPTED_OPTION_ID = {martin:380, mila:381}`
- Smart BCC partagé : `oseys@pipedrivemail.com` (configuré sur `PIPEDRIVE_BCC_MORGANE/JOHNNY`). Les 2 commerciaux `martin@oseys.fr`/`mila@oseys.fr` doivent être dans « Adresses autorisées » Pipedrive
- Pipedrive user_id : Morgane = `25153135`, Johnny = `23354822`

### 5.6 Anthropic

- API key valide configurée en App Settings `pereneo-mail-sender` (clé du compte Anthropic Pereneo, propagée du legacy `oseys-mail-sender` 1er mai PM, BL-51 résolu)
- Modèle Sonnet 4.6 (`claude-sonnet-4-6`) pour génération séquence + classification réponses
- Modèle Haiku 4.5 (`claude-haiku-4-5-20251001`) pour extraction company profile

### 5.7 Flags d'activation pilote

- `DAILY_REPORT_ENABLED=1` (activé 1er mai 18:23 CEST) — David envoie débrief 8h matin lun-ven aux consultants + dailyDigest 00h vers `user_id=charli`
- `LEAD_SELECTOR_DISABLED` non défini = lead selector actif (déclenché fire-and-forget après chaque formulaire consultant)
- `DROPCONTACT_ENABLED` cf. App Settings — cascade exhauster

---

## 6. Setup local

```bash
# Prérequis macOS
node -v    # ≥ 22
brew install azure-functions-core-tools@4 azure-cli jq
az login --tenant 70f9e20f-964f-4925-8dc2-b72d62384629

# Repo
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
npm install

# Récupérer les secrets (en var shell, jamais en sortie clear)
KEY=$(az functionapp config appsettings list --name pereneo-mail-sender --resource-group oseys-prospection-rg --query "[?name=='ANTHROPIC_API_KEY'].value" -o tsv)

# Run local
func start
```

**`local.settings.json`** : à fetcher depuis Azure (gitignored, jamais commité) :
```bash
func azure functionapp fetch-app-settings pereneo-mail-sender
```

---

## 7. Déploiement — doctrine BL-49

**Linux Consumption + `WEBSITE_RUN_FROM_PACKAGE`** monte le ZIP en read-only, donc Oryx ne peut pas y écrire `node_modules` post-upload. Le ZIP doit donc contenir `node_modules` localement.

**Doctrine deploy** :
```bash
# 1. Installer deps locales
npm install --omit=dev

# 2. Vérifier que .funcignore N'EXCLUT PAS node_modules
cat .funcignore | grep -v "^#" | grep node_modules
# (doit être vide ou commenté)

# 3. Deploy en heures creuses (≥21h Paris ou weekend)
func azure functionapp publish pereneo-mail-sender --javascript --no-build
```

**Smoke post-deploy obligatoire** :
- 4 endpoints : `trackOpen` GET (200 + GIF) / `sendMail` POST (401 sans key) / `onQualification` OPTIONS (204) / `avatarProxy` GET (200 + JPEG)
- Application Insights : 0 exception sur 5-10 min post-deploy

**Si régression** : vérifier d'abord le contenu du ZIP via `WEBSITE_RUN_FROM_PACKAGE` URL avant fix-forward (cf. mémoire BL-49 résolution 1er mai 2026).

---

## 8. Conventions de code

- **Programming model Azure Functions v4** (`@azure/functions ^4.5.0`)
- `app.http(...)`, `app.timer(...)` — pas de `function.json`
- Main entry : `src/index.js` qui require les 13 handlers explicitement
- `package.json` `"main": "src/index.js"` simple, pas de glob
- Style : async/await, pas de `.then()` chaining
- Logs : `safeLog(context)` (`shared/safe-log.js`), pas `context.log` direct (BL-45 doctrine)
- Naming : camelCase fonctions/vars, kebab-case fichiers, PascalCase classes
- Tests TDD via `node:test` natif : `npm test` lance `node --test 'tests/**/*.test.js'`
- 747+ tests TDD verts en local (au 1er mai 2026)

---

## 9. Pipedrive dépendances à ne pas casser

Les IDs Pipedrive sont **stables** tant que les ressources ne sont pas recréées. Si recréation : resynchro via :
1. `GET /v1/pipelines` (IDs pipe + stages)
2. `GET /v1/dealFields` + `GET /v1/personFields` (keys hash + options)
3. Update env vars Azure + `local.settings.json` + constantes `shared/pipedrive.js` lignes ~138-140

---

## 10. Backlog — état au 1er mai 2026 PM

### Résolus 1er mai 2026

- BL-31 (sécurité tokens Bearer transit clear) — résolu 30/04 PM
- BL-43 (TTL Bearer 1h wrapper Charli MCP, refresh auto) — proxy 1.0.0 → 1.1.0
- BL-45 (#privateField FA Linux Consumption) — refonte transverse `safe-log.js`
- BL-47 (MCP session resilience cold start) — patch fork v0.6.4-pereneo.1, image v5
- BL-48 (proxy auto-reinit sur 404 upstream) — proxy 1.1.0 stateful + sessionState.js
- BL-49 (régression deploy `.funcignore` + `node_modules`) — doctrine `--no-build`
- BL-51 (clé Anthropic invalide) — propagation legacy → pereneo-mail-sender
- BL-50 — fermé "cosmétique" par Paul (credential leak terminal session)

### Ouverts non urgents

- **BL-04bis** (P3) : télémétrie Application Insights silencieuse — bloque diag stack si nouveau bug runtime
- **BL-34** (P3) : PartitionKey LeadBase non standardisée — scan global, latence acceptable MVP
- **BL-40** (P4) : helpers Pipedrive dupliqués entre `dailyReport` et `dailyDigest` — refacto Phase D
- **BL-41** (P2) : escalations + bounces + opt_outs PAS trackés en table dédiée → absents du dailyDigest. **Visibilité dégradée pendant 1ère semaine pilote — à surveiller**
- **BL-44** (P4) : branche `phase-b-charli-aggregator` mergée superseded — supprimée 1er mai PM ✅
- **BL-46** (P3) : drift CLAUDE.md repo — résolu par cette refonte ✅

### Chantiers stratégiques en attente

- Refonte cascade `site-finder` (Sprint 3 Phase 3 inachevée — F3 site_web absent dégrade qualité enrichissement)
- R&D Maillon 6 enrichissement décideur (LinkedIn provider à arbitrer Proxycurl/PhantomBuster/Apify)
- David v2 — répondre aux mails consultants + curiosité comme trait + mémoire conversationnelle
- Adapter CRM-agnostique (cohérent self-service Prospérenne, écarté Option C boîtes chez le client par Paul 1er mai)
- Migration entité Prospérenne (Tranche 8)
- Self-hosted Mem0 souverain (avant commercialisation Prospérenne)
- Dashboard PWA Pereneo (brief v1 livré SharePoint, à attaquer post-stabilisation pilote)

---

## 11. Sécurité

### 11.1 Zéro credentials en clair

- Jamais en code ou commit. `local.settings.json` gitignored
- Secrets via `az functionapp config appsettings` ou KV reference
- **Discipline R-CRED** : pour les diags `az ... list`, filtrer `--query` pour exclure `.value` des champs sensibles, ou charger en var shell + masquer en sortie. Patterns à masquer : `AccountKey=`, `?sv=...&sig=`, `Bearer XX...`, function keys, `ANTHROPIC_API_KEY`

### 11.2 Confirmation humaine pour actions destructives

Claude Code ne déploie pas en prod, ne supprime pas de données, ne push pas sur `main` sans **GO explicite Paul**. Règles :
- `func azure functionapp publish` → GO préalable
- `git push origin main` → GO préalable (préférer branche feature + PR)
- Suppression données Pipedrive / Mem0 → GO + détail
- `rm -rf` sur dossier avec fichiers → interdit sauf GO

### 11.3 Protection pilote — destinataires humains

En phase pilote, **paul.rudler@oseys.fr** (et constantin.picoron@oseys.fr depuis 1er mai PM) sont les seuls destinataires humains autorisés pour les **smokes techniques**. Les **vrais prospects** sont contactés depuis le formulaire consultant (Morgane/Johnny qui briefent → Lead Selector génère → envoi réel via le pipeline normal).

---

## 12. Style de communication avec Paul

Paul préfère :
- **Tutoiement** systématique (entre lui et Charli/Claude — pas avec les prospects)
- **Réponses courtes et directes**
- **Résultats d'abord, contexte ensuite**
- **Aucun emoji** sauf s'il en utilise
- **Honnêteté sur les limites** — réponse incertaine > réponse inventée
- **Force de proposition DG** : challenger ses idées sans complaire, avec arguments
- **Pas de demande d'autorisation** pour lectures, runs, smoke tests, vérifications. **Autonomie totale** sur ces actions
- **Pour les actions prod** (push commit main, deploy FA, modif scope projet) : grouper en bloc cohérent + demander GO bloc, pas atom par atom

---

## 13. Contacts et ressources

- **Paul Rudler** (Président) : `paul.rudler@oseys.fr`, +33 6 06 43 98 07
- **Constantin Picoron** (DG, tech/data/PilotagePro) : `constantin.picoron@oseys.fr`
- **Olivier Rudler** (DGA, animation réseau) : `olivier@oseys.fr`
- **Adresse collégiale projet** : `direction@oseys.fr` (escalations, rapports)
- **Tenant Microsoft 365** : `70f9e20f-964f-4925-8dc2-b72d62384629`
- **Pipedrive domain** : `oseys.pipedrive.com`
- **Anthropic console** : https://console.anthropic.com (compte Pereneo+OSEYS)

**Docs SharePoint** (`Direction Pérenne - Documents/TECHNIQUE/CLAUDE/1. PERENEO/`) :
- STRATEGY (vision business + pricing + roadmap)
- MEMO (référentiel opérationnel single source of truth)
- ARCHITECTURE (architecture technique détaillée)
- CHARLI (mandat Charli DG)
- OPERATIONS (collaboration Paul/Constantin/Claude/Charli)
- CLAUDE_JOURNAL (R-J* + corollaires)
- CLAUDE_CODE_SETUP (setup environnement Claude Code Paul + Charli mémoire continue)
- BRIEF_DASHBOARD_PWA_PERENEO_v1 (chantier PWA à venir)

---

## 14. En cas de doute

1. **Lire la section concernée + les docs SharePoint référencées** avant d'agir
2. **Ne pas deviner un secret ou une URL** — récupérer depuis Azure
3. **Demander à Paul** plutôt que prendre une décision produit à sa place
4. **Ne pas déployer** sans GO Paul
5. **Logger via `safeLog`** abondamment — Application Insights actif sur `pereneo-mail-sender`
6. **Mémoriser dans `user_id=charli` Mem0** (via MCP `mem0-charli`) tout fait stable, décision Paul, ou apprentissage non dérivable du code/git

---

*Refondu 1er mai 2026 par Charli après lancement officiel pilote David. Drift 17 avril clos. Prochain palier majeur : post-stabilisation pilote (2-3 semaines retour Morgane/Johnny) ou attaque chantier Dashboard PWA selon priorisation Paul.*
