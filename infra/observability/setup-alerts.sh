#!/bin/bash
# Phase 1 observability — création des alertes Azure Monitor pour le burn Anthropic.
# Cible : alerter si la conso Anthropic du jour dépasse 80% du cap Pereneo daily (10€).
#
# Pré-requis :
#   - az login (Tenant 70f9e20f-964f-4925-8dc2-b72d62384629)
#   - permission Contributor sur RG oseys-prospection-rg
#
# Idempotent : --no-wait + check exists. Re-run safe.

set -euo pipefail

RG="oseys-prospection-rg"
APPINSIGHTS_NAME="pereneo-mail-sender"
ALERT_NAME="pereneo-anthropic-daily-burn-80pct"
ACTION_GROUP_NAME="pereneo-tech-alerts"
ALERT_EMAIL="${ALERT_EMAIL:-paul.rudler@oseys.fr}"

APPINSIGHTS_ID=$(az monitor app-insights component show -g "$RG" -a "$APPINSIGHTS_NAME" --query id -o tsv)
echo "AI resource: $APPINSIGHTS_ID"

# 1. Action Group (email Paul) — créé si absent
if ! az monitor action-group show -g "$RG" -n "$ACTION_GROUP_NAME" >/dev/null 2>&1; then
  echo "→ Creating action group $ACTION_GROUP_NAME"
  az monitor action-group create \
    -g "$RG" \
    -n "$ACTION_GROUP_NAME" \
    --short-name "PereneoTech" \
    --action email "paul-rudler" "$ALERT_EMAIL"
else
  echo "✓ Action group $ACTION_GROUP_NAME already exists"
fi

ACTION_GROUP_ID=$(az monitor action-group show -g "$RG" -n "$ACTION_GROUP_NAME" --query id -o tsv)

# 2. Scheduled Query Alert : Anthropic burn daily > 800 cents EUR
QUERY='traces
| where timestamp > startofday(now())
| where message startswith "anthropic.call "
| extend payload = parse_json(substring(message, 15))
| extend cost_cents = todouble(payload.cost_cents)
| summarize anthropic_today_cents = sum(cost_cents)
| where anthropic_today_cents > 800'

echo "→ Creating/updating scheduled query alert $ALERT_NAME"
az monitor scheduled-query create \
  -g "$RG" \
  -n "$ALERT_NAME" \
  --scopes "$APPINSIGHTS_ID" \
  --condition "count 'placeholder' > 0" \
  --condition-query placeholder="$QUERY" \
  --description "Pereneo Phase 1 — alert si Anthropic burn quotidien dépasse 80% du cap 10€ (=800 cents EUR)" \
  --evaluation-frequency "PT5M" \
  --window-size "PT5M" \
  --severity 2 \
  --action-groups "$ACTION_GROUP_ID" \
  --auto-mitigate true \
  || echo "  (alerte existe déjà, az retournera 409 — non bloquant)"

echo ""
echo "✓ Setup terminé."
echo "  Vérifier : az monitor scheduled-query show -g $RG -n $ALERT_NAME --query 'displayName,enabled'"
