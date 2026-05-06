# Phase 1 observability — KQL queries Anthropic burn

Queries Application Insights (workspace `pereneo-mail-sender`, appId `d8389680-123a-4f4f-b1d8-dbd95d3888f0`).

Les appels `callClaude()` instrumentés par `shared/anthropic.js` (Phase 1) émettent une trace structurée :
```
anthropic.call {"operation":"...", "model":"...", "input_tokens":N, "output_tokens":N, "cost_cents":N.NN}
```

## Q1 — Burn quotidien par opération + modèle (vue principale)

```kql
traces
| where timestamp > ago(14d)
| where message startswith "anthropic.call "
| extend payload = parse_json(substring(message, 15))
| extend operation = tostring(payload.operation),
         model     = tostring(payload.model),
         tokens_in = tolong(payload.input_tokens),
         tokens_out= tolong(payload.output_tokens),
         cost_cents= todouble(payload.cost_cents)
| summarize calls      = count(),
            tokens_in  = sum(tokens_in),
            tokens_out = sum(tokens_out),
            cost_cents = round(sum(cost_cents), 2)
          by bin(timestamp, 1d), operation, model
| order by timestamp desc, cost_cents desc
```

## Q2 — Cumul jour courant (à comparer à 1000 cents EUR cap pereneo-total)

```kql
traces
| where timestamp > startofday(now())
| where message startswith "anthropic.call "
| extend payload = parse_json(substring(message, 15))
| extend cost_cents = todouble(payload.cost_cents)
| summarize anthropic_today_cents = round(sum(cost_cents), 2),
            anthropic_today_calls = count()
```

## Q3 — Top 10 opérations les plus chères 24h

```kql
traces
| where timestamp > ago(24h)
| where message startswith "anthropic.call "
| extend payload = parse_json(substring(message, 15))
| extend operation = tostring(payload.operation),
         cost_cents= todouble(payload.cost_cents)
| summarize calls = count(),
            cost_cents = round(sum(cost_cents), 2)
          by operation
| order by cost_cents desc
| take 10
```

## Q4 — Détection burn anormal (> 100 calls/heure)

```kql
traces
| where timestamp > ago(2h)
| where message startswith "anthropic.call "
| summarize calls_per_hour = count() by bin(timestamp, 1h)
| where calls_per_hour > 100
```

## Q5 — Hardstop budget hits (BudgetExceededError)

```kql
exceptions
| where timestamp > ago(7d)
| where outerType == "BudgetExceededError" or innermostType == "BudgetExceededError"
| project timestamp, outerMessage, problemId, operation_Name
| order by timestamp desc
```

## Workbook portail (à créer manuellement)

1. Application Insights `pereneo-mail-sender` → Workbooks → New
2. Add → Query → coller Q1 → Run → Visualization "Bar chart" group by `operation`, value `cost_cents`
3. Add → Query → coller Q2 → Visualization "Tile" → seuil rouge à 800 cents (80% du budget Pereneo daily)
4. Add → Query → coller Q3 → Visualization "Grid"
5. Save as "Pereneo — Anthropic burn"

## Alerte Log Search

Voir `setup-alerts.sh` dans le même dossier. Crée une alerte qui se déclenche si Q2 dépasse 800 cents EUR (80% du cap 10€/jour).
