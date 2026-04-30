# shared/charli-reporter

Module agent-agnostique permettant à n'importe quel agent du Groupe Pérenne (David, Alicia, Richard, futurs) de reporter ses événements asynchrones vers la mémoire continue de Charli, sans connaître le MCP ni Mem0.

## Pattern

Fire-and-forget : pose un message JSON sur la queue Azure Storage `charli-events` (Storage Account `pereneocharliaggregst`). Si la queue est indisponible, le caller continue (try/catch graceful, log warn). Cohérent avec l'arbitrage Q4 paquet de passage Niveau 2 (latence asynchrone).

## API publique (à implémenter en B.2)

```javascript
const { reportToCharli } = require('../../shared/charli-reporter');

await reportToCharli({
  agent: 'david',
  eventType: 'qualif_done',
  summary: 'Le dirigeant de SIREN 12345678901234 a été qualifié niveau 2 le 2026-04-30 par Morgane.',
  metadata: { consultantId: 'morgane', siren: '12345678901234' }
});
```

`eventId` et `timestamp` sont auto-générés si absents.

## Convention summary (Option B)

- Texte sémantique pur (pas de marqueur `[source: X]` dans le content — c'est de la metadata)
- Phrase complète intelligible
- 1 fait stable par event (granularité unitaire CHARLI v1.4 §9)
- Dates absolues
- Anonymisation PII prospect ("le dirigeant de SIREN XXX" plutôt que nom/email)

## Configuration caller

L'agent caller doit avoir `CHARLI_QUEUE_CONNECTION_STRING` (env var, KV reference vers la connection string du SA `pereneocharliaggregst`). Câblage côté David FA = Phase C, hors scope Phase B.
