'use strict';

/**
 * Exécute fn(item, idx) sur chaque item avec une concurrency max.
 * Retourne un array results dans le même ordre que items, chaque entrée
 * étant soit le résultat de fn, soit { error: Error } si fn a throw.
 *
 * Pas de dépendance npm — équivalent fonctionnel de p-limit / p-map en
 * interne pour rester sans poids et compatible Air Worker future.
 */
async function pMapLimit(items, concurrency, fn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const c = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: c }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { pMapLimit };
