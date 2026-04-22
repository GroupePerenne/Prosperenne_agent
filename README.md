> Nom commercial : **Prospérenne**. Nom technique interne : `Prosperenne_agent`.

# OSEYS — Équipe commerciale IA

Trois agents commerciaux déployés pour le réseau OSEYS : **David** (manager), **Martin** et **Mila** (prospecteurs).

À terme, le système est conçu pour être **commercialisable** auprès d'autres réseaux — c'est une équipe commerciale IA louable, pas un outil interne OSEYS.

---

## L'équipe

<table>
<tr>
<td width="33%" align="center">
  <img src="agents/david/avatar.jpeg" width="120" style="border-radius:50%"/>
  <br><strong>David</strong>
  <br><sub>Responsable commercial</sub>
  <br><sub>david@oseys.fr — shared mailbox</sub>
</td>
<td width="33%" align="center">
  <img src="agents/martin/avatar.jpeg" width="120" style="border-radius:50%"/>
  <br><strong>Martin</strong>
  <br><sub>Prospecteur — profil masculin</sub>
  <br><sub>martin@oseys.fr</sub>
</td>
<td width="33%" align="center">
  <img src="agents/mila/avatar.jpeg" width="120" style="border-radius:50%"/>
  <br><strong>Mila</strong>
  <br><sub>Prospectrice — profil féminin</sub>
  <br><sub>mila@oseys.fr</sub>
</td>
</tr>
</table>

### David — Responsable commercial
Interface avec les consultants OSEYS. Onboarding, collecte du brief, orchestration Martin/Mila, suivi de la performance et gestion des réponses prospects (les replyTo de Martin et Mila pointent sur la boîte de David).

### Martin — Prospecteur (profil masculin)
Envoie les séquences au nom du consultant. Ton dynamique et cordial. Jamais en contact direct avec les consultants.

### Mila — Prospectrice (profil féminin)
Même rôle que Martin, profil féminin. Ton chaleureux et conversationnel. Testing comparatif homme/femme par secteur.

---

## Arborescence

```
Prosperenne_agent/
├── README.md                        Ce fichier
├── ARCHITECTURE.md                  Détail de l'orchestration
├── DEPLOY.md                        Procédure de déploiement Azure
├── .env.example                     Template des variables d'env
├── .gitignore
├── host.json                        Config Azure Functions
├── package.json                     Deps Node (Azure Functions SDK, Queue Storage)
│
├── agents/
│   ├── david/
│   │   ├── avatar.jpeg
│   │   ├── identity.json            Identité + signature
│   │   ├── prompt.md                System prompt manager (routage LLM)
│   │   ├── orchestrator.js          Lecture inbox + classification + action
│   │   └── onboarding.js            Envoi du mail d'accueil consultant
│   ├── martin/
│   │   ├── avatar.jpeg
│   │   ├── identity.json
│   │   └── worker.js                Wrapper autour de shared/worker.js
│   └── mila/
│       ├── avatar.jpeg
│       ├── identity.json
│       └── worker.js
│
├── shared/
│   ├── graph-mail.js                Microsoft Graph (send/read/markAsRead) + cache token
│   ├── pipedrive.js                 Client Pipedrive (orgs/persons/deals/activities)
│   ├── anthropic.js                 Wrapper Claude API
│   ├── sequence.js                  Générateur J0/J3/J7/J14 (appel Claude, sortie JSON)
│   ├── worker.js                    Logique commune Martin/Mila
│   ├── queue.js                     Azure Queue Storage pour les relances
│   └── templates.js                 Mail d'onboarding, page confirmation, pixel
│
├── functions/
│   ├── sendMail/                    POST — envoi générique via Graph (from whitelistée)
│   ├── sendOnboarding/              POST — envoie le mail David → consultant
│   ├── choixNiveau/                 GET  — clic bouton niveau/prospecteur
│   ├── onQualification/             POST — soumission du formulaire
│   ├── runSequence/                 POST — déclenche une séquence (J0 + schedule J3/J7/J14)
│   ├── trackOpen/                   GET  — pixel 1×1 de tracking
│   ├── scheduler/                   Timer 15min — consomme la queue des relances
│   └── davidInbox/                  Timer 5min  — lit la boîte David et route
│
└── forms/
    └── formulaire-oseys.html           Formulaire consultant (pré-remplissage URL)
```

---

## Flow complet

1. **Consultant inscrit** → `/api/sendOnboarding` déclenche un mail David avec boutons niveau + cartes Martin/Mila/les deux + lien formulaire pré-rempli.
2. **Consultant clique un bouton** → `/api/choixNiveau` enregistre le choix, envoie un accusé, notifie l'admin.
3. **Consultant remplit le formulaire** → `/api/onQualification` notifie David dans sa boîte, envoie un accusé.
4. **David valide le brief** (traitement manuel ou via l'orchestrator LLM) → appelle `/api/runSequence` avec les leads.
5. **Martin/Mila génèrent 4 messages via Claude** → envoient le J0 → poussent J3/J7/J14 dans la queue Azure avec `visibilityTimeout` de 3/7/14 jours.
6. **Scheduler timer toutes les 15 min** → récupère les messages dus → délègue à l'agent concerné → envoie → log Pipedrive.
7. **Prospect répond** → mail arrive chez `david@oseys.fr` (replyTo) → timer davidInbox (5 min) le lit, le classifie via Claude, prévient le consultant.

---

## Stack technique

- **Runtime** : Azure Functions Node 20 (France Central)
- **Mail** : Microsoft Graph API, permission Application `Mail.Send`, `Mail.Read`
- **CRM** : Pipedrive (via le token David)
- **LLM** : Anthropic Claude (Sonnet 4) pour génération de séquences et orchestration
- **Queue** : Azure Queue Storage (visibilityTimeout natif, at-least-once delivery)
- **Formulaires** : HTML standalone sur GitHub Pages (ou Azure Static Web App)

---

## Les 4 priorités — état

| # | Priorité | Fichiers | État |
|---|----------|----------|------|
| 1 | **Repo GitHub structuré** | README, ARCHITECTURE, DEPLOY, tout le reste | ✅ |
| 2 | **Pipedrive** (token David) | `shared/pipedrive.js` + env `PIPEDRIVE_TOKEN` | ✅ |
| 3 | **Formulaire pré-remplissage URL** | `forms/formulaire-oseys.html` | ✅ |
| 4 | **Séquence J0/J3/J7/J14** | `shared/sequence.js` + queue + scheduler | ✅ |

---

## Prochaines évolutions

- `.github/workflows/deploy.yml` — CI/CD automatique sur push `main`
- `forms/choice.html` — page web alternative au mail d'onboarding
- Warm-up automatique des boîtes Martin et Mila sur 2-3 semaines avant volume
- Dashboard de performance (taux d'ouverture/réponse par agent × secteur) pour éclairer le choix martin/mila/both
- Mode "niveau 3" — déploiement de l'infra dans le tenant Azure du client final (multi-tenancy)
