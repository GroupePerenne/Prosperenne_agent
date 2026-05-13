'use strict';
/**
 * Dépollution complète LeadContacts post-incident 8-11 mai.
 * Cible : toutes les entries avec confidence < 0.5 ET Timestamp >= 2026-05-08T18:00:00Z.
 * Ces entries proviennent du bug webSearch (Brave 402 + Playwright Google jamais appelé)
 * → marquages négatifs erronés qui bloquent retraitement (TTL 7j).
 *
 * Sécurités :
 *   - Filtre Timestamp inférieur strict : ne touche AUCUN négatif antérieur au 8 mai 18h
 *     (vrais négatifs légitimes des smoke pré-fix conservés).
 *   - Filtre confidence < 0.5 : ne touche aucun résolu, ni cached ambigu.
 *   - Delete par PartitionKey+RowKey explicite.
 *   - Concurrency 20 — assez vite, sans saturer Azure Storage.
 *   - Report progression toutes les 200 deletes.
 */
const { TableClient } = require('@azure/data-tables');

(async () => {
  const conn = process.env.AzureWebJobsStorage;
  if (!conn) { console.error('AzureWebJobsStorage env manquant'); process.exit(1); }
  const tc = TableClient.fromConnectionString(conn, 'LeadContacts');

  const cutoff = '2026-05-08T18:00:00.000Z';
  const filter = `confidence lt 0.5 and Timestamp ge datetime'${cutoff}'`;
  console.log(`[depollute] start — filter: ${filter}`);
  const t0 = Date.now();

  // 1. Collecte
  const targets = [];
  // I-2 OK: script ad hoc one-shot cleanup LeadContacts (cache), pas LeadBase
  // Couche 1. Filtre OData strict confidence + cutoff Timestamp pour ne toucher
  // que les entries de l'incident webSearch 8-11 mai.
  for await (const ent of tc.listEntities({ queryOptions: { filter } })) {
    targets.push({ pk: ent.partitionKey, rk: ent.rowKey });
    if (targets.length % 1000 === 0) console.log(`[depollute] collected ${targets.length}…`);
  }
  console.log(`[depollute] collected total : ${targets.length} entries en ${Date.now()-t0}ms`);

  if (targets.length === 0) { console.log('[depollute] rien à supprimer'); process.exit(0); }

  // 2. Delete en parallèle, concurrency 20
  let done = 0, errors = 0;
  const CONCURRENCY = 20;
  async function worker() {
    while (targets.length > 0) {
      const t = targets.pop();
      try {
        await tc.deleteEntity(t.pk, t.rk);
        done++;
      } catch (err) {
        if (err.statusCode !== 404) errors++;
      }
      if (done % 200 === 0) console.log(`[depollute] deleted ${done}, ${targets.length} restants, ${errors} errors`);
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`[depollute] done : ${done} deleted, ${errors} errors, ${Date.now()-t0}ms`);
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
