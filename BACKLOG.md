# Backlog — post-pilote et évolutions

Ce fichier recense les chantiers identifiés pendant l'intégration Mem0 (session 2026-04-21) mais volontairement mis de côté. Priorité : livraison du pilote interne OSEYS (Morgane + Johnny).

---

## Phase 1bis — à traiter avec le chantier plateforme de leads (ARCHITECTURE §7)

### Namespace croisé Mem0 `consultant:{id}:prospect:{siren}`
Capter les apprentissages **spécifiques d'un consultant sur un prospect** (ex: Morgane a déjà travaillé ACME en 2024 sur un angle qui a marché, cette info n'est pas partagée avec Johnny).
- **Aujourd'hui** : les mémoires prospect sont globales (namespace `prospect:{siren}`), les mémoires consultant sont globales (namespace `consultant:{id}`). Pas de croisement.
- **Cible** : namespace hiérarchique ou metadata de scoping. Le design de l'adapter D1 supporte trivialement un préfixe supplémentaire dans le `userId`.
- **Condition de déclenchement** : co-requis avec la nouvelle plateforme de leads (§7 ARCHITECTURE) pour avoir la source de vérité consultant × prospect.
- **Pour le pilote** : non nécessaire — 2 consultants sans chevauchement attendu.

### Wording escalation fuzzy match pour clients Prospérenne externes
Le template actuel `agents/david/orchestrator.js` (via `shared/worker.sendFuzzyMatchEscalation`) suppose que le destinataire sait ce qu'est Pipedrive et Prospérenne (« ton pipeline », « on voulait contacter via David »).
- **Aujourd'hui** : ton familier OSEYS, wording interne.
- **Cible** : template configurable par tenant, wording neutre pour clients externes (ex: "Un prospect que nous allions contacter apparaît déjà dans votre CRM...").
- **Condition** : à revoir avant le premier client Prospérenne externe.

---

## Phase 2 — Mem0 self-hosted

### Réévaluer `infer:true` avec reformatage prose pour `storeConsultant` / `storeProspect`
- **Contexte** : smoke test 2026-04-21 a démontré que Mem0 Cloud avec `infer:true` + JSON stringifié n'extrait **aucune** mémoire. Décision D3 initiale ("consolidation native") inopérante en pratique. Fallback actuel : `infer:false` partout → snapshot verbatim, pas de consolidation.
- **Cible** : extraction LLM côté self-hosted via Haiku 4.5 Batch API (décision ARCHITECTURE D3 Phase 2), avec reformatage des payloads en prose conversationnelle :
  ```
  [
    { role: 'user', content: 'Le consultant Morgane préfère un ton direct_cordial et cible les secteurs services_btb et conseil.' },
    { role: 'assistant', content: 'Noté.' }
  ]
  ```
- **Bénéfice** : dédoublonnage natif des stores successifs, consolidation des faits accumulés (interaction_history qui ne grossit pas linéairement).
- **Condition** : Mem0 self-hosted configuré, coûts LLM Haiku 4.5 Batch absorbables.

---

## Dédoublonnage Pipedrive — ✓ DONE (session 2026-04-21, voir commits 4.5 bis)

Les 3 items bloquants go/no-go mercredi ont été implémentés et testés dans cette session :

- [x] **Item 1** — Check deal ouvert avant `createDeal` : si existant → reuse + log info, skip `bootstrapSequence`. Si >1 deal → warn + plus récent. Helper `resolveOrCreateDeal` + `pickMostRecent` dans `agents/david/orchestrator.js`.
- [x] **Item 2** — Consommer `needsEscalation: true` : mail d'escalation au consultant owner du deal existant (fallback `direction@oseys.fr` si owner non résolvable). Helper `sendFuzzyMatchEscalation` dans `shared/worker.js`.
- [x] **Item 3** — Lire `retry_available_after` et `opt_out_until` avant création : opt-out sticky prioritaire sur cooldown. Helper `checkLeadCooldown` dans `agents/david/orchestrator.js`.

Extension mineure de `shared/pipedrive.js:findOpenDealsForPersonInOurPipe` avec param `{ includeClosed }` — nécessaire car les champs de cooldown/opt-out vivent sur des deals fermés (stages `CLOSED_SILENCE` / `CLOSED_REFUSAL`).

Pré-requis restants côté configuration Pipedrive avant activation en prod :
- Créer le champ custom SIREN sur les Organisations Pipedrive si absent.
- Renseigner `PIPEDRIVE_ORG_FIELD_SIREN` dans `local.settings.json` + Azure App Settings.
- Garantir que la base curée de Constantin peuple ce champ sur chaque org créée.
