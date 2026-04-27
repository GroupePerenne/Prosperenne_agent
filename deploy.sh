#!/usr/bin/env bash
# deploy.sh — Procédure de déploiement standard Pereneo_agents
# Voir SECURITY_NOTES.md pour le contexte
set -euo pipefail

FA_NAME="${FA_NAME:-pereneo-mail-sender}"
echo "→ Deploy vers $FA_NAME (build remote Linux x64)"
func azure functionapp publish "$FA_NAME" --build remote --timeout 600
echo "→ Vérification routing"
curl -sI "https://${FA_NAME}.azurewebsites.net/api/avatarproxy" | head -1
