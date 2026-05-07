#!/usr/bin/env node
/**
 * Smoke test LeadBase — validation de bout en bout de l'accès à la base de
 * prospection Azure Tables (12,8M entreprises SIRENE+INPI croisés, maintenue
 * par Constantin).
 *
 * Objectifs :
 *   1. Vérifier la connectivité depuis le repo Pereneo_agents
 *   2. Mesurer la latence réelle pour dimensionner le compteur live du formulaire
 *   3. Valider la cohérence des données (format colonnes, dirigeants JSON, GPS)
 *   4. Simuler un cas d'usage complet : "150 ESN à Paris entre 10 et 49 salariés"
 *
 * Usage :
 *   node scripts/leadbase-smoke.js
 *
 * Pré-requis :
 *   - npm install @azure/data-tables
 *   - AzureWebJobsStorage dans local.settings.json (déjà présent)
 *
 * Exit codes :
 *   0 = tous les tests passent
 *   1 = erreur de config / connexion
 *   2 = test 1 (count) échoue
 *   3 = test 2 (filtrage complexe) échoue
 *   4 = test 3 (lookup SIREN) échoue
 */

const { TableClient } = require('@azure/data-tables');
const fs = require('fs');
const path = require('path');

// ─── Chargement de la connection string depuis local.settings.json ─────────
function loadConnectionString() {
  const configPath = path.resolve(__dirname, '..', 'local.settings.json');
  if (!fs.existsSync(configPath)) {
    console.error(`❌ local.settings.json introuvable à ${configPath}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const connStr = config.Values && config.Values.AzureWebJobsStorage;
  if (!connStr) {
    console.error('❌ AzureWebJobsStorage absent de local.settings.json');
    process.exit(1);
  }
  return connStr;
}

// ─── Helpers formatage ──────────────────────────────────────────────────────
function fmtMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatEntity(e) {
  const dirigeants = (() => {
    try {
      const parsed = JSON.parse(e.dirigeants || '[]');
      if (!Array.isArray(parsed) || parsed.length === 0) return '-';
      const first = parsed[0];
      return `${first.prenoms || ''} ${first.nom || ''}`.trim() || '-';
    } catch {
      return '-';
    }
  })();
  return {
    siren: e.siren || e.rowKey || '-',
    nom: truncate(e.nom, 35),
    naf: e.codeNaf || '-',
    ville: truncate(e.ville, 20),
    tranche: e.trancheEffectif || '-',
    dirigeant: truncate(dirigeants, 25),
    gps: (e.latitude && e.longitude) ? '✓' : '-',
  };
}

function printSample(entities, max = 3) {
  if (entities.length === 0) {
    console.log('   (aucun résultat)');
    return;
  }
  const rows = entities.slice(0, max).map(formatEntity);
  const col = (label, w) => label.padEnd(w);
  console.log(`   ${col('SIREN', 11)} ${col('Nom', 36)} ${col('NAF', 7)} ${col('Ville', 21)} ${col('Tranche', 8)} ${col('Dirigeant', 26)} GPS`);
  rows.forEach(r => {
    console.log(`   ${col(r.siren, 11)} ${col(r.nom, 36)} ${col(r.naf, 7)} ${col(r.ville, 21)} ${col(r.tranche, 8)} ${col(r.dirigeant, 26)} ${r.gps}`);
  });
}

// ─── Test 1 : count des entreprises dans Paris (75) ────────────────────────
async function test1_countParis(client) {
  console.log('─'.repeat(80));
  console.log('TEST 1 — Count entreprises département 75 (Paris)');
  console.log('─'.repeat(80));
  const start = Date.now();
  let count = 0;
  const sample = [];
  try {
    // I-2 OK: smoke v1 — filtre schema_version pour cohérence consommateurs prod.
    const iterator = client.listEntities({
      queryOptions: {
        filter: "PartitionKey eq '75' and schema_version eq '1.0'",
        select: ['siren', 'nom', 'codeNaf', 'ville', 'trancheEffectif', 'schema_version'],
      },
    });
    for await (const entity of iterator) {
      count++;
      if (sample.length < 3) sample.push(entity);
      // Bornage de sécurité : on ne lit pas des millions pour un count
      if (count >= 50000) {
        console.log(`   ⚠️  Bornage à 50k pour éviter de spammer la base`);
        break;
      }
    }
  } catch (err) {
    console.error(`   ❌ Erreur : ${err.message}`);
    return { ok: false, count: 0, duration: Date.now() - start };
  }
  const duration = Date.now() - start;
  console.log(`   Résultat   : ${count.toLocaleString('fr-FR')} entreprises`);
  console.log(`   Durée      : ${fmtMs(duration)}`);
  console.log(`   Latence/ligne : ${(duration / Math.max(count, 1)).toFixed(2)} ms/ligne`);
  console.log(`   Échantillon :`);
  printSample(sample);
  return { ok: count > 0, count, duration };
}

// ─── Test 2 : filtrage ESN Paris 10-49 salariés ────────────────────────────
async function test2_filterEsnParis(client) {
  console.log('');
  console.log('─'.repeat(80));
  console.log('TEST 2 — Filtre ESN (NAF 62.02A) à Paris, effectif 10-49 salariés');
  console.log('         Simule : "Morgane veut 150 ESN parisiennes à prospecter"');
  console.log('─'.repeat(80));
  const start = Date.now();
  let count = 0;
  const sample = [];
  let withGps = 0;
  let withDirigeant = 0;
  try {
    // Note : Azure Tables ne supporte pas "in" sur un champ → on filtre
    // sur codeNaf exact et on croise avec trancheEffectif 11 (10-19) ou 12 (20-49)
    // I-2 OK: smoke v1 ESN Paris.
    const iterator = client.listEntities({
      queryOptions: {
        filter:
          "schema_version eq '1.0' "
          + "and PartitionKey eq '75' and codeNaf eq '62.02A' "
          + "and (trancheEffectif eq '11' or trancheEffectif eq '12')",
      },
    });
    for await (const entity of iterator) {
      count++;
      if (sample.length < 3) sample.push(entity);
      if (entity.latitude && entity.longitude) withGps++;
      try {
        const dirs = JSON.parse(entity.dirigeants || '[]');
        if (Array.isArray(dirs) && dirs.length > 0) withDirigeant++;
      } catch { /* ignore */ }
      if (count >= 1000) {
        console.log(`   ⚠️  Bornage à 1000 résultats`);
        break;
      }
    }
  } catch (err) {
    console.error(`   ❌ Erreur : ${err.message}`);
    return { ok: false, count: 0, duration: Date.now() - start };
  }
  const duration = Date.now() - start;
  console.log(`   Résultat   : ${count} ESN parisiennes 10-49 salariés`);
  console.log(`   Durée      : ${fmtMs(duration)}`);
  console.log(`   Avec GPS   : ${withGps}/${count} (${count ? Math.round(100*withGps/count) : 0}%)`);
  console.log(`   Avec dirigeant INPI : ${withDirigeant}/${count} (${count ? Math.round(100*withDirigeant/count) : 0}%)`);
  console.log(`   Échantillon :`);
  printSample(sample);
  return { ok: count > 0, count, duration };
}

// ─── Test 3 : lookup par SIREN ─────────────────────────────────────────────
async function test3_lookupSiren(client) {
  console.log('');
  console.log('─'.repeat(80));
  console.log('TEST 3 — Lookup par SIREN (recherche inverse sans département)');
  console.log('─'.repeat(80));
  const cas = [
    { siren: '852115740', label: 'OSEYS RESEAU SAS (entreprise de Paul)' },
    { siren: '443061841', label: 'GOOGLE FRANCE (exemple du doc Constantin)' },
  ];
  let okGlobal = true;
  for (const c of cas) {
    const start = Date.now();
    let found = null;
    try {
      // I-2 OK: lookup par siren v1.
      const iterator = client.listEntities({
        queryOptions: { filter: `siren eq '${c.siren}' and schema_version eq '1.0'` },
      });
      for await (const entity of iterator) {
        found = entity;
        break;
      }
    } catch (err) {
      console.error(`   ❌ Erreur lookup ${c.siren} : ${err.message}`);
      okGlobal = false;
      continue;
    }
    const duration = Date.now() - start;
    console.log(`   ${c.label}`);
    console.log(`   SIREN ${c.siren} : ${found ? '✅ trouvée' : '❌ introuvable'} en ${fmtMs(duration)}`);
    if (found) {
      const f = formatEntity(found);
      console.log(`   → ${f.nom} | ${f.naf} | ${f.ville} | tranche ${f.tranche} | dirigeant: ${f.dirigeant}`);
    } else {
      okGlobal = false;
    }
    console.log('');
  }
  return { ok: okGlobal };
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('═'.repeat(80));
  console.log('  SMOKE TEST LEADBASE — Pereneo_agents');
  console.log('═'.repeat(80));
  console.log('');

  const connStr = loadConnectionString();
  console.log(`✅ Connection string chargée (AccountName=${connStr.match(/AccountName=([^;]+)/)?.[1]})`);

  const client = TableClient.fromConnectionString(connStr, 'LeadBase');
  console.log(`✅ TableClient instancié sur la table "LeadBase"`);
  console.log('');

  const r1 = await test1_countParis(client);
  if (!r1.ok) {
    console.error('\n❌ TEST 1 a échoué — on arrête ici. Vérifier que la table LeadBase existe et est peuplée.');
    process.exit(2);
  }

  const r2 = await test2_filterEsnParis(client);
  if (!r2.ok) {
    console.error('\n⚠️  TEST 2 n\'a retourné aucun résultat. Possible : pas d\'ESN à Paris dans la tranche, ou le code NAF 62.02A est mal formaté dans la base.');
    // On n'exit pas — le lookup SIREN peut quand même passer
  }

  const r3 = await test3_lookupSiren(client);

  console.log('');
  console.log('═'.repeat(80));
  console.log('  BILAN');
  console.log('═'.repeat(80));
  console.log(`  Test 1 (count Paris)        : ${r1.ok ? '✅' : '❌'} — ${r1.count.toLocaleString('fr-FR')} entreprises en ${fmtMs(r1.duration)}`);
  console.log(`  Test 2 (filtre ESN Paris)   : ${r2.ok ? '✅' : '⚠️ '} — ${r2.count} ESN en ${fmtMs(r2.duration)}`);
  console.log(`  Test 3 (lookup SIREN)       : ${r3.ok ? '✅' : '❌'}`);
  console.log('');

  if (r1.ok && r2.ok && r3.ok) {
    console.log('✅ Base LeadBase opérationnelle. Prête à brancher le compteur + preview.');
    process.exit(0);
  } else {
    console.log('⚠️  Certains tests ont échoué. Voir les détails ci-dessus.');
    process.exit(r3.ok ? 3 : 4);
  }
}

main().catch(err => {
  console.error('');
  console.error('❌ Erreur non capturée :');
  console.error(err);
  process.exit(1);
});
