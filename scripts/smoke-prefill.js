#!/usr/bin/env node
/**
 * Smoke local du pré-remplissage formulaire — appelle GET /api/getConsultantBrief
 * avec un email connu et affiche le JSON retourné.
 *
 * Vérifie que :
 *   1. L'endpoint répond (200 si email connu, 404 sinon, 400 si email absent)
 *   2. Le JSON contient bien `responses` au format `consultantMemory` attendu
 *      par applyResponses() côté formulaire HTML
 *
 * Usage :
 *   # Contre la FA prod (heures creuses) — exige PEREN_EO_FUNCTION_KEY ou
 *   # CHOIXNIVEAU_FUNC_CODE (la même function key host fonctionne pour les
 *   # endpoints function-level si configurée en clé host)
 *   FUNCTION_HOST=https://pereneo-mail-sender.azurewebsites.net \
 *   FUNCTION_KEY=<key> \
 *   EMAIL=morgane.dejessey@oseys.fr \
 *     node scripts/smoke-prefill.js
 *
 *   # Contre un func start local (authLevel function bypassée si pas de host key)
 *   FUNCTION_HOST=http://localhost:7071 \
 *   EMAIL=morgane.dejessey@oseys.fr \
 *     node scripts/smoke-prefill.js
 *
 * Exit code : 0 si 200 + responses non vide, 1 sinon.
 */

'use strict';

async function main() {
  const host = process.env.FUNCTION_HOST || 'http://localhost:7071';
  const email = process.env.EMAIL || '';
  const key = process.env.FUNCTION_KEY || process.env.CHOIXNIVEAU_FUNC_CODE || '';

  if (!email) {
    console.error('[smoke-prefill] EMAIL env var required');
    process.exit(1);
  }

  const params = new URLSearchParams({ email });
  if (key) params.set('code', key);

  const url = `${host}/api/getConsultantBrief?${params.toString()}`;
  // On masque la function key dans le log (R-CRED §11.1)
  const safeUrl = key ? url.replace(key, '<FUNCTION_KEY>') : url;
  console.log(`[smoke-prefill] GET ${safeUrl}`);

  let res;
  try {
    res = await fetch(url, { method: 'GET', cache: 'no-store' });
  } catch (err) {
    console.error('[smoke-prefill] fetch failed:', err.message);
    process.exit(1);
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log(`[smoke-prefill] status=${res.status}`);
  console.log('[smoke-prefill] body:');
  console.log(JSON.stringify(body, null, 2));

  if (res.status !== 200) {
    console.error(`[smoke-prefill] non-200 status ${res.status}`);
    process.exit(1);
  }
  if (!body || !body.ok || !body.responses) {
    console.error('[smoke-prefill] responses absent or empty');
    process.exit(1);
  }

  // Vérification rapide du shape consultantMemory
  const r = body.responses;
  const expectedKeys = ['display_name', 'email', 'commercial_strategy'];
  const missing = expectedKeys.filter((k) => !(k in r));
  if (missing.length > 0) {
    console.warn(`[smoke-prefill] WARN clés attendues absentes : ${missing.join(', ')}`);
  } else {
    console.log('[smoke-prefill] shape consultantMemory OK');
  }
  process.exit(0);
}

main();
