# Handover de clôture — session phase-1-observability (6 mai 2026)

**Date** : 2026-05-06 (matin)
**Session** : phase-1-observability lancée par Paul ~minuit, finie ~midi
**Auteur** : Charli (DG Pereneo)
**Branche** : `phase-1-observability`
**Statut** : Tout livré, prêt à reprendre en session fraîche pour Mem0 healthy

---

## Ce qui a été livré dans cette session

### 1. Phase 1 observability (commit `c3ffd57`)

**Cap budget Pereneo GLOBAL 10€/jour (décision Paul 6 mai matin)** :
- `shared/pereneo-budget.js` (nouveau) : assertDailyBudget multi-providers + trackSpend par provider + estimateAnthropicCostCents
- `shared/lead-exhauster/budget.js` étendu pour supporter period='daily' (rétrocompat monthly intacte)
- `shared/anthropic.js callClaude()` instrumenté : assertDailyBudget AVANT fetch (hardstop pré-réseau) + trackSpend APRÈS + log structuré `anthropic.call <json>`
- Override env vars : `PEREENO_DAILY_BUDGET_CENTS_EUR=1000` (set sur FA), tarifs Anthropic en cents EUR/Mtok également overridables

**Workbook + Alerte Azure Monitor** :
- `infra/observability/anthropic-burn-queries.md` : 5 KQL prêtes (vue jour/ops, cumul jour, top 10 ops, détection burn, hardstop hits)
- `infra/observability/setup-alerts.sh` : script idempotent qui crée action group `pereneo-tech-alerts` (email Paul) + scheduled-query-alert `pereneo-anthropic-daily-burn-80pct` (warning à 800 cents, eval toutes les 5 min)

**Hook Charli** :
- `~/.charli/hooks/log-tool-use.sh` : log unifié de chaque tool call de Charli en JSONL
- `~/.charli/actions/YYYY-MM-DD.jsonl` : fichiers journaliers
- `~/.claude/settings.json` : hook PostToolUse matcher `*` wired (actif au prochain démarrage Charli)

### 2. Sprint 1 cascade-sans-Brave + cache négatif + SMTP probe MVP (commit `beb9e29`)

**Brave retiré du défaut** :
- `DEFAULT_BACKENDS_ORDER = ['duckduckgo_lite', 'mojeek', 'ecosia', 'duckduckgo_html']` (4 gratuits, plus de Brave)
- Module braveApi conservé dans le registry, réactivable via env var si crédit revient
- Lock prod : env FA `SITE_FINDER_WEBSEARCH_BACKENDS=duckduckgo_lite,mojeek,ecosia,duckduckgo_html`

**Cache négatif intelligent** :
- `isFreshCacheHit()` : rows `source=none` retentés APRES `LEADCONTACTS_NEGATIVE_RETRY_DAYS` (default 7j). Plus de retent en boucle à chaque run.
- 9 nouveaux tests unitaires.

**SMTP probe MVP (NON intégré dans la cascade pour cette session)** :
- `shared/lead-exhauster/smtp-probe.js` : `probeEmail({email, ...})` → `{status, code, response, mxHost, elapsedMs}`
- DI complet pour tests (mxLookup + smtpDialog overridables)
- 11 tests unitaires verts
- Plan d'intégration Sprint 2 documenté : `docs/handovers/2026-05-06-smtp-probe-sprint-2.md`

### 3. Sprint 0 visibilité (commit `f1950d5` cherry-pick depuis sprint-0-visibilite)

Logs structurés ajoutés à site-finder + lead-exhauster pour mesurer chaque étape de la cascade : `cascade.summary`, `prepass.summary`, `candidate.outcome`, `batch.summary`. Permettent diag forensic post-deploy.

---

## État technique à la reprise

### Branche + commits

```
phase-1-observability (origin/phase-1-observability)
├── beb9e29  Sprint 1 — Brave retiré + cache négatif + SMTP probe MVP
├── c3ffd57  Phase 1 — cap budget Pereneo 10€/jour + tracking Anthropic
├── f1950d5  Sprint 0 visibilité cascade (cherry-picked)
└── 54c47cc  fix(dropcontact) qualif V2 (commit pré-existant)
```

Branche `sprint-0-visibilite` peut être supprimée après validation Sprint 1 (déjà mergée via cherry-pick dans phase-1-observability).

### Tests : 938 verts

- 891 originaux
- +9 cache négatif
- +11 SMTP probe
- +1 webSearch nouveau test env override
- +14 pereneo-budget
- +8 budget extension daily
- +4 instrumentation callClaude

### FA `pereneo-mail-sender` settings ajoutés Phase 1 / Sprint 1

| Setting | Valeur | Effet |
|---|---|---|
| `PEREENO_DAILY_BUDGET_CENTS_EUR` | 1000 | Cap quotidien Pereneo 10€ |
| `SITE_FINDER_WEBSEARCH_BACKENDS` | `duckduckgo_lite,mojeek,ecosia,duckduckgo_html` | Plus de Brave, fallback gratuits |
| `EXHAUSTER_CONCURRENCY` | 1 | Throttle (à remettre 3 quand stable) |
| `AzureWebJobs.nightlyMonteCarloSmoke.Disabled` | true | Monte Carlo désactivé (fix burn 5→6 mai) |

### Azure Monitor

- Action group `pereneo-tech-alerts` créé (email paul.rudler@oseys.fr)
- Scheduled query alert `pereneo-anthropic-daily-burn-80pct` active (warning si conso anthropic > 800 cents EUR)

### Storage Tables

- `Budgets` : nouvelle PartitionKey `pereneo-total` ajoutée à chaque trackSpend (period='daily', RowKey=YYYYMMDD)

---

## Compte leads contactables Morgane / Johnny — état au 6 mai matin

| Consultant | Total enrichis | Email résolu | Contactable ≥0.80 |
|---|---|---|---|
| Morgane (oseys-m.dejessey) | 39 | 0 | **0** |
| Johnny (oseys-j.serra) | 30 | 0 | **0** |
| **Total** | **69** | **0** | **0** |

**Tous en `source=none`, `confidence=0`, `email` absent.**

Constat : avec la cascade actuelle (api.gouv KO + Brave retiré + Dropcontact catch-all majoritaire + heuristic peu performant sur slugs courts), aucun email n'est résolu. **David ne peut envoyer à personne.**

### Ce que les changements Sprint 1 vont faire

- **Brave retiré** : enlève une source de cascade utile mais coûteuse. Net effet sur le pool actuel : neutre (Brave bloquait pas, Brave aidait peu sur ces SIRENs précis selon handover hier).
- **Cache négatif intelligent** : empêche le burn cette nuit, MAIS ne débloque pas les leads (ils restent en `source=none` pendant 7j minimum).
- **SMTP probe MVP** : non intégré, donc 0 impact sur la cascade actuelle.

**=> David ne pourra commencer que quand un Sprint 2 (SMTP probe intégré) ou un Sprint 3 (resolveDomain durci INSEE OAuth + heuristic V2) débloquera la résolution domaine + email.**

---

## Tâches en attente (à reprendre en session fraîche)

### Critique pour démarrer David

1. **Brief Morgane `zone_rayon` retour à 10 km** — Mem0 timeout récurrent ce matin. À refaire dès que Mem0 healthy : `search_memory consultant:m.dejessey@oseys.fr` puis delete + add identique sauf `zone_rayon: 10`.
2. **Sprint 2 SMTP probe intégration** — voir `docs/handovers/2026-05-06-smtp-probe-sprint-2.md`. ~1-2j de travail. Inclut probeEmailWithCatchAll + intégration cascade. Doit tourner depuis Mac Air (FA bloque port 25).
3. **Sprint 3 resolveDomain durci** — INSEE OAuth + heuristic V2 + (optionnel) Bing Search free tier. Pour rebrancher la cascade quand api.gouv reste KO. Pas commencé dans cette session.

### Importants mais non bloquants

4. **Mémoires Mem0 timeoutées à reposer** :
   - Milestone Phase 1 livrée + Sprint 1 livrée (texte prêt en commits + handovers, à pousser via `add_memory` quand healthy)
   - Décision PWA à 100% pour observability (texte préparé dans la session, à pousser)
   - Diag burn cette nuit (Monte Carlo + commits 5 mai cumulés) — déjà mis dans Mem0 hier, à compléter avec mitigation

5. **Bug Mem0 timeouts récurrents** : 2ème incident en 24h (5 mai PM + 6 mai matin). À investiguer côté Container App `mem0-mcp-charli` (RG `pereneo-charli-mcp`). Peut-être un cold start ou une saturation upstream Mem0 cloud.

6. **Workbook Anthropic burn dans le portail Azure** : KQL prêtes dans `infra/observability/anthropic-burn-queries.md`. Création manuelle via portail (5-10 min, à faire par Paul ou Constantin via UI).

7. **`EXHAUSTER_CONCURRENCY` à remettre à 3** : actuellement à 1 (throttle de sécurité Phase 1). Quand on aura la confiance que le cap budget tient, repasser à 3 pour débit nominal.

8. **`AzureWebJobs.nightlyMonteCarloSmoke.Disabled=true`** : à laisser pour l'instant. Réactivable quand on aura un cap budget pour Monte Carlo + une logique d'auto-correction qui ne bouffe pas la cascade.

### À débattre stratégiquement

9. **PWA Pereneo (chantier prioritaire post-déblocage David)** : décision Paul 6 mai matin. À chiffrer + cadrer en début de prochain sprint stratégique. Inclura le dashboard observability (consomme les data Phase 1 déjà en place — Workbooks AI + Storage Tables Budgets).

10. **Pricing Prospérenne** : pas modifié pour l'instant (décision Paul 6 mai). À reprendre post-pilote validé.

---

## Premier réflexe en session fraîche

```bash
# 1. Vérifier la branche
cd ~/Documents/Professionnel/GROUPE\ PERENNE/Pereneo_agents
git branch --show-current   # phase-1-observability ou main selon ce qui aura été mergé

# 2. Vérifier Mem0 healthy
charli  # Charli teste Mem0 à l'ouverture, devrait répondre

# 3. Lire ce handover + le Sprint 2 handover
cat docs/handovers/2026-05-06-cloture-session-phase-1.md
cat docs/handovers/2026-05-06-smtp-probe-sprint-2.md

# 4. Reprendre les tâches Mem0 (critique #1, important #4)

# 5. Démarrer Sprint 2 (intégration SMTP probe) si décision Paul OK
```

---

## Bilan global de la session

**Durée** : ~12h (minuit → midi)
**Lignes de code ajoutées** : ~1500 (3 commits)
**Tests ajoutés** : +47 (817 → 938)
**Coût Anthropic estimé Charli** : élevé (longue session, multiple agents Explore + claude-code-guide). À mesurer via les nouveaux logs `anthropic.call` ingérés dans AI ce matin.
**Coût provider externe Pereneo cette session** : 0€ (cap actif depuis Phase 1, aucun appel callClaude depuis le code Pereneo, juste mes propres appels Charli).

**Apprentissages doctrinaux nouveaux** :
- Cold start Linux Consumption : routes anonymous mettent ~5 min à remonter (pas 90s)
- Build vs buy : préférer build sur l'existant quand multi-tenant pas immédiat (Paul 6 mai)
- Budget global Pereneo : un seul cap multi-providers, pas par provider (Paul 6 mai)
- Orthographe officielle : Prospérenne avec un seul 'r' (Paul 6 mai)

**Apprentissages techniques** :
- Functions v4 sync triggers + cold start anonymous : pattern à documenter dans CLAUDE_JOURNAL
- Azure FA Consumption bloque port 25 outbound (impact SMTP probe — relégué Mac Air worker)
- `az storage entity query` avec `--num-results > 1000` peut timeout / fail OData (utiliser 1000 max)
- Mem0 timeouts récurrents quand le service est sous charge (à investiguer)
