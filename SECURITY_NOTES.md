# Security Notes

## 2026-04-21 — Transitive vulnerabilities pulled by `mem0ai@3.0.1`

**Scan** : `npm audit` sur l'arbre de dépendances complet après `npm install mem0ai`.

**4 vulnérabilités remontées**, toutes via des transitives de `mem0ai@3.0.1` :

| Package | Sévérité | Chemin | Nature |
|---|---|---|---|
| `undici` | **high** | `mem0ai → @qdrant/js-client-rest → undici` | Unbounded decompression chain in HTTP responses (Node Fetch), DoS via bad certificate data, HTTP request/response smuggling, unbounded memory consumption in WebSocket permessage-deflate, unhandled exception WebSocket client, CRLF injection via upgrade option |
| `axios` | moderate | `mem0ai → axios` | NO_PROXY hostname normalization bypass (SSRF), unrestricted cloud metadata exfiltration via header injection chain |
| `@qdrant/js-client-rest` | moderate | `mem0ai → @qdrant/js-client-rest` | Pulled in vulnerable `undici` (pas de CVE propre au package) |
| `mem0ai` | moderate | direct dependency | Propage les CVE `axios` + `@qdrant/js-client-rest` (pas de CVE propre) |

Aucun fix disponible via `npm audit fix` sans breaking upgrade de `mem0ai`. `npm audit fix --force` non appliqué (déciderait un downgrade/upgrade majeur non validé).

### Analyse d'exposition

Les vulnérabilités listées concernent des transitives **non appelées directement** par le code Pérennia :

- **Endpoint Mem0 fixé** : l'adapter (`shared/adapters/memory/mem0.js`) instancie un seul `MemoryClient` pointant sur `https://api.mem0.ai` (ou override via env `MEM0_BASE_URL`). Pas d'URL user-controlled qui traverserait la chaîne `axios` / `undici`.
- **Pas de WebSocket** consommé depuis Pérennia via ces transitives. L'exposition `undici` WebSocket permessage-deflate / server_max_window_bits ne nous concerne pas.
- **Pas de proxy dynamique** configuré. L'attaque `axios` NO_PROXY bypass suppose une configuration proxy attaquable — non applicable à notre setup Azure Functions standard.
- **Pas d'envoi de certificats clients** arbitraires. Le vecteur undici "DoS via bad certificate data" n'est pas mobilisable sans une capacité d'injection réseau.

Le seul risque résiduel théorique : un serveur Mem0 compromis (ou un MITM sur le endpoint `api.mem0.ai`) pourrait exploiter une CVE `undici` ou `axios` pour faire échouer/ralentir l'app. Impact limité — dégradation gracieuse de l'adapter renvoie `[]` / `null` au code downstream, le routage David continue.

### Décision

**Acceptées pour le pilote interne OSEYS** (2 consultants, volume faible, endpoint Mem0 SaaS fixe). À revoir avant commercialisation Prospérenne externe :

- Re-scanner avec `npm audit` à chaque upgrade `mem0ai`.
- Basculer en Phase 2 Mem0 self-hosted (décision ARCHITECTURE D3) — remplace les transitives `axios`/`undici` par notre stack HTTP maîtrisée, et permet un audit de sécurité plus fin.
- Surveiller les release notes `mem0ai` — une version qui dédoublonne ou replace axios pour fetch natif Node 22+ éliminerait la plupart des CVE.

### Action de suivi

- [ ] Monitorer les releases de `mem0ai` (GitHub releases / npm notifications).
- [ ] Re-scanner à chaque bump `mem0ai` dans `package.json` et mettre à jour ce fichier.
- [ ] Audit sécurité complet (inclus test d'intrusion) avant la mise en marché Prospérenne.
