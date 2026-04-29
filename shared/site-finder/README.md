# site-finder

Pour un SIREN dont LeadBase n'a pas de `siteWeb` connu (ou avec une valeur potentiellement obsolète), retourne l'URL canonique du site web officiel avec preuve forte (SIREN trouvé dans les pages mentions légales du site) ou `null` avec la trace des tentatives.

## API publique

```js
const { findWebsite } = require('shared/site-finder');

const out = await findWebsite({
  siren: '123456789',
  companyName: 'ACME SAS',
  ville: 'Lyon',
  codePostal: '69003',
  options: {
    confidenceThreshold: 0.85,  // défaut env SITE_FINDER_CONFIDENCE_THRESHOLD
    timeoutMs: 15000,           // défaut env SITE_FINDER_TIMEOUT_MS
    forceRefresh: false,
    skipCache: false,
  },
});
// → { siteUrl, confidence, source, proofType, proofDetails?, signals,
//     costCents, validatedAt, attempted: [{ source, candidates, rejectedReason? }] }
```

## Architecture

```
shared/site-finder/
├── index.js                         orchestrateur public + modes on_demand/batch
├── sources/
│   ├── apiGouv.js                   T1 — API Recherche d'entreprises
│   ├── webSearch.js                 T2 — cascade de requêtes web
│   └── webSearchBackends/
│       └── duckduckgoHtml.js        T2 — backend DDG HTML scrape
├── validation/
│   ├── sirenExtractor.js            extraction SIREN robuste depuis HTML
│   └── siteValidator.js             validateCandidate(url, targetSiren)
├── cache/
│   └── websitePatternsCache.js      cache Azure Tables WebsitePatterns
├── writers/
│   └── leadbaseWriter.js            T3 — écriture Merge sur LeadBase
└── utils/
    ├── urlNormalizer.js             normalisation URL canonique
    └── pageFetcher.js               fetch home + mentions légales
```

Cascade de l'orchestrateur : `cache → apiGouv → webSearch (5 stratégies) → null`. Les agrégateurs publics (societe.com, verif.com, pages-jaunes.fr…) ont été abandonnés en T2 — soit la donnée n'est pas publiée dans le HTML public, soit les sites sont protégés par Cloudflare (cf. note plus bas).

### Cascade webSearch — 5 stratégies de query

Quand `apiGouv` ne retourne aucun candidat ou que les candidats retournés ne passent pas la validation, le module bascule sur une cascade de requêtes web. Chaque stratégie est appliquée dans l'ordre, on s'arrête dès qu'un candidat est validé :

1. `name_city` — `"<companyName>" <ville>` (la plus discriminante en général)
2. `name_postcode` — `"<companyName>" <codePostal>`
3. `name_siren` — `"<companyName>" <siren>` (puissante quand le site mentionne le SIREN en footer)
4. `name_director` — `"<companyName>" "<dirigeantName>"`
5. `name_naf_city` — `"<companyName>" <libelleNaf> <ville>`

Backend par défaut : DuckDuckGo HTML scrape (`html.duckduckgo.com/html/`). DDG retourne occasionnellement un challenge anti-bot ("anomaly modal") — détecté et propagé comme `SearchBlockedError`. Quand le backend est bloqué, la cascade s'arrête (pas de retry martelant).

Backends alternatifs prévus en backlog : SearXNG self-hosté, Brave Search API. Architecture pluggable via `webSearchBackends/`.

### Filtrage des agrégateurs

`webSearch.AGGREGATOR_DOMAINS` liste les domaines connus (societe.com, linkedin.com, pappers.fr, pagesjaunes.fr, infogreffe.fr, manageo.fr, kompass.com, europages.fr, annuaire-entreprises.data.gouv.fr…). Les URLs candidates appartenant à ces domaines sont filtrées avant d'être présentées au validator.

### Pourquoi pas societe.com / verif.com / pages-jaunes.fr en source directe

Reconnaissance T2.0 (2026-04-29) sur 3 SIREN (Danone + 2 PME OSEYS-cible) :

- **societe.com** : HTTP 200, mais le HTML public ne contient PAS de lien vers le site web réel de l'entreprise. La donnée est probablement derrière une feature payante.
- **verif.com** : HTTP 403 Cloudflare Challenge (`<title>Just a moment…</title>`). Inutilisable sans browser headless.
- **pages-jaunes.fr** : HTTP 403 Cloudflare CAPTCHA explicite (tag analytics `p=CLOUDFLARE::CAPTCHA`). Inutilisable.

Décision : on attaque le problème via DuckDuckGo (qui indexe ces sources et exclut leur contenu cloué derrière du JS). L'investissement browser headless / API payante reste possible en backlog si le ROI le justifie ultérieurement.

## Variables d'environnement

```
SITE_FINDER_TIMEOUT_MS=15000                            # mode à-la-demande
SITE_FINDER_CONFIDENCE_THRESHOLD=0.85
SITE_FINDER_CACHE_TTL_VALIDATED_DAYS=90
SITE_FINDER_CACHE_TTL_UNVERIFIED_DAYS=30
WEBSITE_PATTERNS_TABLE=WebsitePatterns
WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING=             # KV ref en prod ; fallback AzureWebJobsStorage
RECHERCHE_ENTREPRISES_API_URL=https://recherche-entreprises.api.gouv.fr

# T2 — cascade webSearch
SITE_FINDER_WEBSEARCH_MAX_RESULTS_PER_QUERY=10
SITE_FINDER_WEBSEARCH_POLITENESS_DELAY_MS=2000          # entre 2 requêtes au même backend
SITE_FINDER_WEBSEARCH_USER_AGENT=                       # défaut Chrome 120 macOS si vide
SITE_FINDER_DDG_HTML_URL=https://html.duckduckgo.com/html/

# T3 — modes on_demand / batch
SITE_FINDER_ON_DEMAND_TIMEOUT_MS=20000                  # mode interactif, bornes serrées
SITE_FINDER_ON_DEMAND_POLITENESS_BUDGET_MS=5000         # max politesse cumulée mode on_demand
SITE_FINDER_BATCH_TIMEOUT_MS=90000                      # mode batch (run continu)
```

## Modes on_demand vs batch (T3)

`findWebsite` accepte `options.mode`. Default `'on_demand'`.

- **`on_demand`** : mode interactif (intégré dans le pipeline d'enrichissement, latence importe). Limite à 2 stratégies (`name_city`, `name_siren`), timeout 20s, budget politesse 5s.
- **`batch`** : run continu (futur wrapper standalone, smoke tests, scripts de migration). 5 stratégies appliquées, timeout 90s, politesse illimitée.

Si la politesse cumulée dépasse `politenessBudgetMs` (mode on_demand surtout), la cascade s'arrête tôt avec `attempted` contenant `{source: 'websearch_skipped', rejectedReason: 'politeness_exhausted'}`.

## Intégration pipeline (T3)

Pré-passe automatique dans `shared/lead-exhauster/enrichBatch.js` (étape 1.5, entre `selectCandidatesForConsultant` et la boucle exhauster) :

1. Pour chaque candidate sans `hintedEmail` : appel `findWebsite()` en mode `'on_demand'`.
2. Si validé, écriture Merge sur LeadBase via `writers/leadbaseWriter.js` (sauf en `dryRun`). Champs ajoutés : `siteWeb`, `siteWebConfidence`, `siteWebSource`, `siteWebProofType`, `siteWebValidatedAt`, `siteWebLastCheckedAt`, `siteWebVersion`.
3. Le `companyDomain` du candidate est enrichi → l'exhauster en bénéficie pour `resolveDomain`.

Compteurs ajoutés au `meta` retourné par `enrichBatchForConsultant` : `siteFinderAttempts`, `siteFinderOk`, `siteFinderSkipped`, `siteFinderCacheHits`, `siteFinderCostCents`. Propagés automatiquement par `enrichAndProfileBatchForConsultant` dans son meta global.

Fail-safe : si `findWebsite` throw ou retourne null, le candidate continue dans le pipeline sans `companyDomain` enrichi (l'exhauster fait son boulot avec ce qu'il a). Pas de blocage du pipeline.

En prod, `WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING` doit être une référence Key Vault (jamais une chaîne en clair). Si absente, le module fallback sur `AzureWebJobsStorage` (pattern Sprint 1 leadbase-table). Si les deux sont absents, le cache est désactivé silencieusement et toutes les requêtes appellent les sources directement.

## Note sur le doublon resolveDomain

`shared/lead-exhauster/resolveDomain.js` fait déjà un appel à l'API Recherche d'entreprises pour extraire le `site_web` d'un SIREN. site-finder est volontairement distinct :

- `resolveDomain` retourne **un** domaine et lui donne autorité 0.90 sur la simple foi du payload API gouv.
- `findWebsite` traite chaque candidat comme une hypothèse et exige une **preuve par SIREN dans les mentions légales du site** pour atteindre une confidence ≥ 0.99.

Les deux modules co-existent jusqu'à un chantier de cohérence ultérieur (hors scope Sprint 2).
