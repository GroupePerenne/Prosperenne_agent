# Phase 2 — Rapport de tests locaux

**Date :** 17 avril 2026
**Commit de référence (HEAD fin de phase) :** [`b58225a`](https://github.com/GroupePerenne/Prosperenne_agent/commit/b58225a) — _UX form: fix progress bar, sweet spot 10-20, zone géo as optional override_
**Destinataire unique autorisé pendant la phase :** `paul.rudler@oseys.fr`

---

## 1. Récapitulatif des 7 tests

| # | Test | Statut | Durée handler | Observations |
|---|------|--------|---------------|--------------|
| 1 | `trackOpen` — pixel GIF | ✅ OK | 42 ms | GIF89a 1×1, 42 bytes, `Cache-Control: no-store`, branche Pipedrive skippée car `deal`/`person` absents de la query — pas de dépendance `PIPEDRIVE_TOKEN` |
| 2 | `sendMail` — david → paul | ✅ OK | 314 ms | `{success:true}` HTTP 200, mail reçu dans la shared mailbox `david@oseys.fr` |
| 3 | `sendMail` — martin puis mila (replyTo david) | ✅ OK | 705 ms + 651 ms | Expéditeurs affichés corrects (`martin@oseys.fr`, `mila@oseys.fr`), clic "Répondre" dans Outlook déclenche bien un mail vers `david@oseys.fr` |
| 4 | `onQualification` — soumission brief API | ✅ OK | 495 ms | `brief_id` généré, 2 mails émis (récap David + accusé consultant) |
| 5 | `sendOnboarding` — mail d'accueil consultant | ✅ OK | 281 ms | Rendu validé visuellement : avatar David, 3 boutons niveau, 3 cartes Martin/Mila/Les deux, CTA orange "Remplir mon brief", chargement des 3 avatars depuis `raw.githubusercontent.com/GroupePerenne/Prosperenne_agent/…` |
| 6 | `choixNiveau` — clic bouton local | ✅ OK | — | URL locale avec clé de fonction, page HTML de confirmation affichée, accusé + alerte admin reçus |
| 7 | Formulaire HTML + soumission end-to-end | ✅ OK | 654 ms | Pré-remplissage URL, sauvegarde locale, bascule override zone, soumission vers handler local, écran vert de succès, 2 mails reçus (récap lisible côté Paul) |

**Aucun destinataire autre que `paul.rudler@oseys.fr` / `david@oseys.fr` n'a été touché. Aucun déploiement. Aucun push non validé.**

---

## 2. Bugs détectés et corrigés pendant la Phase 2

### 2.1 Progress bar du formulaire — [`b58225a`](https://github.com/GroupePerenne/Prosperenne_agent/commit/b58225a)

- **Symptôme :** la barre ne bougeait pas quand le consultant remplissait plusieurs champs d'une même section (ex : téléphone, ville, linkedin après que nom/email/entreprise soient pré-remplis).
- **Cause racine :** `updateProgress()` comptait au niveau **section** (6 sections au total) — dès qu'un input d'une section était rempli, la section passait de 0 à 1 et ne bougeait plus, peu importe les autres champs de cette même section. Second bug : le handler `click` des choice cards martin/mila/both n'appelait pas `updateProgress()` (seuls les tags le faisaient).
- **Correctif :** refactor pour compter 14 champs individuels (6 personnels + `prospecteur` + `offre` + `secteurs` + `effectif` + `zone` + `registre` + `vouv` + `exemple`). Appel `updateProgress()` ajouté dans le handler click des choice cards.

### 2.2 Ajustement UX zone géographique — [`b58225a`](https://github.com/GroupePerenne/Prosperenne_agent/commit/b58225a)

- **Pivot produit :** premier round proposait 3 quick-picks "France entière / Ma région / 50km autour de moi" au-dessus d'un champ texte libre. Paul a revert après retour produit : la base de leads est pré-constituée par OSEYS à partir de l'adresse pro du consultant, donc la zone géographique n'est pas une saisie obligatoire mais une **surcouche optionnelle**.
- **Nouvelle UI :** état _collapsed_ par défaut (hint + bouton texte-lien "Modifier la zone"). Clic sur le bouton → déplie 4 radios (`adresse` / `region` / `france` / `custom`), dont `custom` révèle un champ texte libre. La valeur sérialisée dans `f_zone` est `"default"` tant que rien n'est modifié, sinon `adresse` / `region` / `france` ou la chaîne libre custom. Helper `restoreZoneFromValue()` ajouté pour `applyUrlParams` et `loadDraft`.

### 2.3 Sweet spot des effectifs recalibré 10-40 → 10-20 — [`b58225a`](https://github.com/GroupePerenne/Prosperenne_agent/commit/b58225a)

- **Origine :** retour produit de Paul (réalité terrain OSEYS : la valeur ajoutée maximale se capture plutôt autour de 10-20 salariés).
- **Propagation :**
  - `forms/qualification.html` : `selected` déplacé de `20-40` à `10-20`, mention "— sweet spot" déplacée.
  - `agents/david/prompt.md` : prompt système de David mis à jour.
  - `CLAUDE.md` §1 "Cœur de cible OSEYS" mis à jour.
  - `README.md` / `ARCHITECTURE.md` : aucune mention — rien à changer.

### 2.4 Fix confirmationPage — [`3c1da33`](https://github.com/GroupePerenne/Prosperenne_agent/commit/3c1da33)

- **Symptôme :** la page de confirmation après clic sur un bouton de niveau/prospecteur affichait un placeholder `"À définir"` à côté du vrai choix quand un seul des deux paramètres était fourni.
- **Correctif :** refactor pour n'afficher qu'un badge par valeur réellement fournie. Fallback `"Choix enregistré"` uniquement si aucun des deux paramètres n'est présent. Validation via 4 cas de test Node (niveau seul / prospecteur seul / les deux / rien).

### 2.5 Sections documentation produit ajoutées — [`d560584`](https://github.com/GroupePerenne/Prosperenne_agent/commit/d560584)

CLAUDE.md §1.5 (positionnement "David est manager, pas exécutant") et §1.6 (pilote interne OSEYS Morgane + Johnny, pas de multi-tenancy, pas d'OSEYS hardcodé).

---

## 3. Temps total Phase 2

Environ **40 minutes de tests effectifs** (10:19 → 10:59 heure locale, sur les logs `func start`), hors discussions produit et refactors UI. La durée réelle de la session Phase 2 incluant pivots produit et fixes ≈ **1h20**.

---

## 4. État de l'infra à la fin de la Phase 2

### Ce qui fonctionne
- **Les 8 functions bootent proprement en local** via `func start` (programming model v4 `@azure/functions ^4.5.0`, bootstrap `src/index.js` registrant les 8 handlers).
- **5 endpoints HTTP testés manuellement end-to-end** : `sendMail`, `sendOnboarding`, `choixNiveau`, `onQualification`, `trackOpen`.
- **Graph API `Mail.Send` valide depuis les 3 adresses** : `david@oseys.fr` (shared mailbox), `martin@oseys.fr` (licence Business Basic), `mila@oseys.fr` (licence Business Basic) — flow `client_credentials` sur l'app registration `OSEYS-ProspectionAgent`.
- **Microsoft 365 `replyTo` fonctionne** : un mail envoyé depuis `martin@` ou `mila@` avec `replyTo: david@oseys.fr` déclenche bien le bon destinataire au clic "Répondre" dans Outlook.
- **Formulaire consultant** : pré-remplissage URL, badges "pré-rempli", progress bar réactive par champ, sauvegarde draft dans `localStorage`, override zone géographique optionnel, soumission API end-to-end.

### Ce qui n'a pas été testé en Phase 2
- **Les 2 timer triggers** (`davidInbox` toutes les 5 min, `scheduler` toutes les 15 min) ne s'exécutent pas automatiquement en local pendant la durée de la session — seule leur détection au boot a été vérifiée. `davidInbox` a bien tenté de se déclencher une fois pendant la session (preuve que le timer est attaché au runtime) et est remonté avec `Graph 403 Access denied` faute de permission `Mail.Read`. Exécution réelle à valider en prod.
- **`runSequence`** et **`scheduler`** : dépendent de `ANTHROPIC_API_KEY` (génération LLM) et `PIPEDRIVE_TOKEN` (log activité) — non remplis en `local.settings.json`, non testés.
- **`davidInbox`** : dépend de la permission Graph `Mail.Read` non accordée — non testé en exécution.

---

## 5. Ce qui reste à faire avant Phase 3

- [ ] **Upload des photos Microsoft 365** pour les 3 boîtes (david/martin/mila) — en cours côté Paul, nécessaire pour que le trombinoscope Outlook des consultants matche les avatars GitHub.
- [ ] **Activation du proxy avatar Graph** — après l'upload des photos, pour servir les avatars via Graph plutôt que depuis `raw.githubusercontent.com` (moins dépendant de GitHub, meilleur caching Exchange).
- [ ] **Rotation de la function key `choixNiveau` prod** — la clé **locale** générée par `func start` a transité dans le chat Claude Code pendant le Test 6 (elle reste dans un environnement sécurisé, mais par précaution Paul veut rotationner la clé **prod** côté Azure dès que la fonction sera déployée).
- [ ] **Ajout de la permission Graph `Mail.Read`** sur l'app registration `OSEYS-ProspectionAgent` + consentement admin (cf. CLAUDE.md §8.1) — nécessaire pour que `davidInbox` fonctionne.
- [ ] **Renseignement de `PIPEDRIVE_TOKEN` et `ANTHROPIC_API_KEY`** dans les App Settings Azure (actuellement placeholders dans `local.settings.json`).
- [ ] **Création du pipeline Pipedrive "OSEYS Prospection"** + custom fields `agent_sender` / `consultant_nom` (cf. CLAUDE.md §8.2).
- [ ] **Activation de GitHub Pages** pour héberger `forms/qualification.html` publiquement (cf. CLAUDE.md §8.3) — actuellement `PUBLIC_FORMS_BASE_URL` pointe vers une URL qui retournera 404.

---

## 6. Prérequis Phase 3 (déploiement Azure)

### 6.1 Validation produit finale de Paul

Les 4 leviers UX discutés doivent faire l'objet d'une décision explicite avant le déploiement :

1. **Fusion onboarding + formulaire en 1 seul flow** plutôt que le double flow actuel (mail d'onboarding → clic bouton → mail accusé → formulaire séparé).
2. **Prévisualisation live avant lancement de la séquence** : le consultant voit les 4 messages J0/J3/J7/J14 générés par Claude pour son premier lead avant de valider le lancement sur tout le batch.
3. **Dashboard consultant léger** : vue web simple listant les leads en cours, leur statut (envoyé / ouvert / répondu / fermé), accessible depuis un lien dans les mails de David.
4. **Rapports hebdo proactifs de David** : mail automatique chaque lundi récapitulant la semaine écoulée (leads touchés, taux de réponse, prochaines relances) + suggestions d'ajustement de la séquence.

### 6.2 Décision go/no-go sur le déploiement

Après validation des 4 leviers UX et clôture des points §5, Paul donne le go pour :
- `func azure functionapp publish oseys-mail-sender --javascript` (déploie les 8 functions)
- Configuration des permissions Graph manquantes
- Smoke tests en prod
- Premier pilote avec Morgane ou Johnny (1 consultant à la fois recommandé avant d'ouvrir les deux en parallèle)

---

_Fin du rapport Phase 2. Rapport rédigé automatiquement par Claude Code à la demande de Paul Rudler, à partir des logs de session et des commits Git de la journée._
