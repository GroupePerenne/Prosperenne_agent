# Lessons Learned — Incidents traités et enseignements opérationnels

## 2026-04-21 — Découpage de commits : adapter la méthode au niveau git du superviseur

### Contexte
Session d'intégration Mem0 sur Claude Code. Phase de commit final avec exigence de granularité (8 commits atomiques). Claude Code a proposé un pattern "revert temporaire → commit → restauration depuis backup tmpfs" pour découper les fichiers touchant à plusieurs commits. Paul a stoppé parce que l'edit ressemblait à une suppression de code validé.

### Ce qui s'est réellement passé
Le pattern proposé était valide en soi (couramment utilisé par les devs seniors), mais :
1. Il n'avait pas été annoncé comme séquence multi-étapes avant le premier edit — l'intention n'était lisible qu'en connaissant le script mental complet.
2. Le filet de sécurité était un backup tmpfs hors repo, pas un mécanisme git natif.
3. Paul, qui supervise la session, n'a pas l'expertise git avancée pour lire un revert temporaire comme une opération de découpage ; pour lui, c'était une régression.

### Règles opérationnelles pour Richard (et toute session Claude Code supervisée)

**R1 — Poser un filet git natif au démarrage de toute session multi-commits.**
`git tag session-start-<YYYY-MM-DD-HHMM>` ou `git branch backup/session-<nom>` avant la première modification. 2 secondes, zéro risque, rollback trivial via `git reset --hard <tag>`. Les backups tmpfs (`/tmp/...`) sont un complément acceptable, jamais un plan B principal.

**R2 — Annoncer les séquences multi-étapes avant le premier edit.**
Si un plan nécessite plus d'un edit pour atteindre le résultat final (ex : revert puis restauration, déplacement de fonction avec création de nouveau fichier), décrire la séquence complète et les checkpoints de vérification **avant** d'exécuter le premier edit. Le superviseur humain valide le plan, pas chaque maillon isolé.

**R3 — Adapter le niveau de lisibilité au niveau git du superviseur.**
Face à un superviseur non-expert git, préférer les patterns qui laissent le working tree intact en permanence (`git add -p`, `git reset -p`, staging par hunks avec `git diff --cached` montré avant commit). Face à un expert git, les patterns plus avancés (cherry-pick, rebase interactif, reverts temporaires) sont acceptables, à condition d'être annoncés (R2).

**R4 — Ne jamais modifier la sémantique du code en phase de commit final.**
Après annonce "GO commit + push", les opérations autorisées sont uniquement : staging, ordonnancement, messages de commit, corrections typo sur commentaires. Tout changement de logique doit intervenir avant la bascule en phase commit.

### Application future
Ces 4 règles seront intégrées au prompt système de Richard lors de sa préparation (conversation `[Dev] Prompt Richard` à venir). Elles s'appliquent à toute session Claude Code conduite sous supervision Richard ou Charli.
