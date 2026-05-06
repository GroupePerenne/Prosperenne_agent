# Handover — SMTP probe Sprint 2 (intégration cascade + catch-all)

**Date** : 2026-05-06
**Auteur** : Charli (DG Pereneo) en session phase-1-observability
**Statut session** : MVP module livré, intégration différée à session suivante

## Ce qui est livré (MVP)

`shared/lead-exhauster/smtp-probe.js` :
- `probeEmail({ email, helloDomain, fromAddress, timeout, adapters })` → `{ status: 'ok'|'rejected'|'unknown', code, response, mxHost, elapsedMs }`
- `resolveMxHosts(domain, dnsImpl)` utility
- `smtpDialog({...})` — connexion TCP port 25 + EHLO + MAIL FROM + RCPT TO + QUIT

11 tests unitaires verts (mocks DNS + mocks dialog SMTP).

## Ce qui reste à faire (Sprint 2)

### 1. Détection catch-all

Ajouter `probeEmailWithCatchAll({ email, ...opts })` :
1. Probe `email` réel
2. Probe `random_${Date.now()}@<domain>` (email volontairement faux)
3. Logique :
   - Réel ok + random ok → `catch_all` (le serveur dit oui à tout, faible signal)
   - Réel ok + random rejected → `verified` (signal fort, confidence upgrade 0.65 → 0.90)
   - Réel rejected → `invalid` (confidence 0)
   - Sinon → `unknown`

### 2. Intégration cascade lead-exhauster

Dans `shared/lead-exhauster/index.js` ou un nouveau maillon `shared/lead-exhauster/sources/smtpProbeUpgrade.js` :
- Après le maillon `pattern_hint` qui retourne confidence 0.65, appeler `probeEmailWithCatchAll`
- Si `verified` → upgrade confidence à 0.90 + source 'smtp_verified'
- Si `invalid` → mark email null + source 'smtp_invalid' (caché en negative cache 7j)
- Si `catch_all` → laisser confidence 0.65 (pas envoyable doctrine 0.80)
- Si `unknown` → laisser tel quel, non-bloquant

### 3. Infrastructure : où ça tourne

**Azure Function App `pereneo-mail-sender` BLOQUE le port 25 outbound** (politique anti-spam Azure tier Consumption). Tester avec :
```bash
az webapp config appsettings list -g oseys-prospection-rg -n pereneo-mail-sender \
  --query "[?name=='WEBSITE_DISABLE_SMTP_PORT_25_BLOCK']"
# Si vide ou false : port 25 bloqué côté FA
```

**Solutions** :
1. **Mac Air worker** (recommandé) — la roadmap Air Worker mentionne déjà ce contexte. Le SMTP probe tournerait en post-traitement local des leads enrichis.
2. **Container App dédié** — port 25 ouvert sur Container Apps, mais coût marginal et infra à monter.
3. **API tierce email verification** — Hunter.io, ZeroBounce, NeverBounce. ~$0.005/probe, donc 100 probes = $0.50. À mettre dans le cap pereneo-budget global mais probablement préférable au probe maison long terme.

### 4. Réputation IP + warmup

Si on probe depuis une IP non-warmupée à >50/h, risque ban ESP majeur :
- Microsoft : ban à ~100 req/h depuis IP froide
- Google : grey-list automatique à >30 req/h
- ESP custom (BTP TPE auto-hosting) : pas de protection mais petits volumes

**Mitigation MVP** : limiter à 20 probes/heure (cap dans le code en Sprint 2).

### 5. Tests d'intégration réels

À lancer manuellement après Sprint 2 sur 10 emails connus mix :
- 3 emails OSEYS valides (paul.rudler@, m.dejessey@, j.serra@) — attendu `ok`
- 3 emails connus invalides (`fake_xxx@oseys.fr`) — attendu `rejected` ou `unknown` selon ESP
- 2 emails d'entreprises BTP boulonnaises connues (issus du brief Morgane) — résultat à observer
- 2 emails @gmail.com (doivent ressortir `unknown` ou `catch_all` car Gmail accepte tout en RCPT)

Documenter le taux de précision réel dans `infra/observability/smtp-probe-precision-202605.md`.

## Pourquoi ne pas avoir intégré dans cette session

1. Risque de régression sur la cascade en production (qui tourne actuellement avec le pilote David)
2. La détection catch-all est un sujet à part qui mérite des tests dédiés (false positives)
3. L'infrastructure (FA port 25 bloqué) impose un repackaging vers Mac Air worker — pas dans le scope d'une session "lance Phase 1"
4. Mem0 timeouts récurrents → risque de perdre la mémoire du contexte entre sessions, mieux vaut livrer brique par brique

## Premier réflexe session de reprise

1. Test direct du module sur Mac Air : `node -e "require('./shared/lead-exhauster/smtp-probe').probeEmail({email:'paul.rudler@oseys.fr'}).then(console.log)"`
2. Si ça répond `status: 'ok'` ou `status: 'rejected'` clean, le module est fonctionnel sur Mac Air. Sinon, debug DNS / port 25.
3. Coder `probeEmailWithCatchAll` dans le même module (~30 lignes + 4 tests)
4. Coder `sources/smtpProbeUpgrade.js` (intégration cascade) (~80 lignes + 5 tests)
5. Tester E2E sur les 9 SIRENs Morgane connus
