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

## Architecture T1

```
shared/site-finder/
├── index.js                         orchestrateur public
├── sources/
│   └── apiGouv.js                   T1 — API Recherche d'entreprises
├── validation/
│   ├── sirenExtractor.js            extraction SIREN robuste depuis HTML
│   └── siteValidator.js             validateCandidate(url, targetSiren)
├── cache/
│   └── websitePatternsCache.js      cache Azure Tables WebsitePatterns
└── utils/
    ├── urlNormalizer.js             normalisation URL canonique
    └── pageFetcher.js               fetch home + mentions légales
```

T2 ajoutera `sources/scrapeAggregators.js` (societe.com, verif.com, pages-jaunes.fr) et T3 ajoutera `sources/duckDuckGo.js`. Aucun changement à l'orchestrateur n'est prévu pour ces extensions — l'ordre des sources est piloté par `SOURCES_ORDER_T1` (qui deviendra `SOURCES_ORDER`).

## Variables d'environnement

```
SITE_FINDER_TIMEOUT_MS=15000                    # mode à-la-demande
SITE_FINDER_CONFIDENCE_THRESHOLD=0.85
SITE_FINDER_CACHE_TTL_VALIDATED_DAYS=90
SITE_FINDER_CACHE_TTL_UNVERIFIED_DAYS=30
WEBSITE_PATTERNS_TABLE=WebsitePatterns
WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING=     # KV ref en prod ; fallback AzureWebJobsStorage
RECHERCHE_ENTREPRISES_API_URL=https://recherche-entreprises.api.gouv.fr
```

En prod, `WEBSITE_PATTERNS_STORAGE_CONNECTION_STRING` doit être une référence Key Vault (jamais une chaîne en clair). Si absente, le module fallback sur `AzureWebJobsStorage` (pattern Sprint 1 leadbase-table). Si les deux sont absents, le cache est désactivé silencieusement et toutes les requêtes appellent les sources directement.

## Note sur le doublon resolveDomain

`shared/lead-exhauster/resolveDomain.js` fait déjà un appel à l'API Recherche d'entreprises pour extraire le `site_web` d'un SIREN. site-finder est volontairement distinct :

- `resolveDomain` retourne **un** domaine et lui donne autorité 0.90 sur la simple foi du payload API gouv.
- `findWebsite` traite chaque candidat comme une hypothèse et exige une **preuve par SIREN dans les mentions légales du site** pour atteindre une confidence ≥ 0.99.

Les deux modules co-existent jusqu'à un chantier de cohérence ultérieur (hors scope Sprint 2).
