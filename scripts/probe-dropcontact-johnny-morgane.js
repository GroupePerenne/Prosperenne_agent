'use strict';

/**
 * Sonde ad-hoc 8 mai 2026 PM — Dropcontact standalone sur sweet spot Pérenne.
 *
 * Mandat Paul : "je ne peux pas croire que Dropcontact ne résolve rien".
 *
 * Hypothèse à vérifier : avec le fix S1 (extractFirstName + extractLastName)
 * de la branche feat/dropcontact-elargi, les inputs Dropcontact deviennent
 * propres pour la 1re fois. Mesurer le vrai taux de match Dropcontact sur
 * un échantillon élargi des critères réels Morgane + Johnny.
 *
 * Stratégie technique :
 *   - selectCandidatesForConsultant batchSize=30 par consultant (sweet spot)
 *   - Appel Dropcontact API en BATCH (1 seul polling au lieu de 30) pour
 *     boucler en ~3 minutes au lieu de ~45 minutes
 *   - Aggrégation par qualification (nominative/catch_all/role/miss)
 *
 * Discipline R-CRED : DROPCONTACT_API_KEY chargée via env, jamais affichée.
 */

const { selectCandidatesForConsultant } = require('../shared/leadSelector');

// Briefs réels lus depuis pereneomailsenderst.consultantOnboarding 8 mai PM.
// Format flat (tel qu'attendu par mapBriefToFilters) : secteurs en CSV, pas array.
const BRIEFS = {
  morgane: {
    nom: 'Morgane DE JESSEY',
    email: 'm.dejessey@oseys.fr',
    secteurs: 'plomberie,electricite,domotique,menuiserie,architecture,formation,maintenance,securite,nettoyage,services_particuliers',
    secteurs_autres: '',
    effectif: '10-20',
    zone: 'default',
    zone_rayon: 10,
    ville: '87 Avenue Pierre Grenier 92100 Boulogne-Billancourt',
  },
  johnny: {
    nom: 'Johnny SERRA',
    email: 'j.serra@oseys.fr',
    secteurs: 'plomberie,electricite,paysagisme,domotique,menuiserie,esn,architecture,nettoyage,immobilier',
    secteurs_autres: '',
    effectif: '10-20',
    zone: 'default',
    zone_rayon: 30,
    ville: '114 Rue de Verchère 38460 Chozeau',
  },
};

const DROPCONTACT_API_URL = process.env.DROPCONTACT_API_URL || 'https://api.dropcontact.io/batch';
const POLL_DELAYS_MS = [30_000, 30_000, 30_000, 30_000];
const POLL_TIMEOUT_MS = 180_000;

async function callDropcontactBatch(leads, apiKey) {
  if (!leads.length) return [];
  console.log(`  → Dropcontact batch : ${leads.length} leads, POST /batch...`);
  const submitRes = await fetch(DROPCONTACT_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Access-Token': apiKey,
    },
    body: JSON.stringify({
      data: leads.map((l) => ({
        first_name: l.firstName,
        last_name: l.lastName,
        company: l.companyName || '',
        website: l.companyDomain || '',
        siren: l.siren,
      })),
      language: 'fr',
      siren: true,
    }),
  });
  if (!submitRes.ok) {
    const txt = await submitRes.text();
    throw new Error(`POST /batch http_${submitRes.status}: ${txt.slice(0, 300)}`);
  }
  const submitBody = await submitRes.json();
  if (!submitBody || submitBody.success === false || !submitBody.request_id) {
    throw new Error(`POST /batch no_request_id: ${JSON.stringify(submitBody).slice(0, 300)}`);
  }
  const requestId = submitBody.request_id;
  console.log(`  → request_id=${requestId}, polling…`);

  const start = Date.now();
  let lastBody = null;
  for (const delay of POLL_DELAYS_MS) {
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error('poll timeout');
    await new Promise((r) => setTimeout(r, delay));
    const url = `${DROPCONTACT_API_URL.replace(/\/+$/, '')}/${encodeURIComponent(requestId)}`;
    const pollRes = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'X-Access-Token': apiKey },
    });
    if (!pollRes.ok) {
      const txt = await pollRes.text();
      throw new Error(`GET poll http_${pollRes.status}: ${txt.slice(0, 300)}`);
    }
    const body = await pollRes.json();
    lastBody = body;
    console.log(`  → poll t+${Math.round((Date.now() - start) / 1000)}s : success=${body.success}`);
    if (body.success === true && Array.isArray(body.data) && body.data.length > 0) {
      return body.data;
    }
  }
  throw new Error(`poll exhausted: ${JSON.stringify(lastBody).slice(0, 300)}`);
}

function classifyQualif(q) {
  if (!q) return 'miss';
  const s = String(q).toLowerCase();
  if (s.startsWith('nominative_verified')) return 'nominative_verified';
  if (s.startsWith('nominative')) return 'nominative';
  if (s.startsWith('catch-all') || s.startsWith('catch_all')) return 'catch_all';
  if (s.startsWith('role')) return 'role';
  return s;
}

async function probe(consultantKey, apiKey) {
  const brief = BRIEFS[consultantKey];
  console.log(`\n========================================`);
  console.log(`  ${brief.nom} — ${brief.ville}`);
  console.log(`  Sectors: ${brief.secteurs}`);
  console.log(`  Effectif: ${brief.effectif}, rayon: ${brief.zone_rayon}km`);
  console.log(`========================================`);

  const selectorResult = await selectCandidatesForConsultant({
    brief,
    batchSize: 30,
    candidateMultiplier: 1,
    consultantId: brief.email,
    briefId: brief.email,
  }).catch((err) => {
    console.error(`selectCandidates throw: ${err.message}`);
    return { status: 'error', candidates: [], meta: { reason: err.message } };
  });

  if (!selectorResult.candidates || selectorResult.candidates.length === 0) {
    console.log(`Pool vide : status=${selectorResult.status}, reason=${selectorResult.meta && (selectorResult.meta.reason || selectorResult.meta.errorCode)}`);
    return;
  }

  const candidates = selectorResult.candidates;
  const valid = candidates.filter((c) => c.firstName && c.lastName && c.companyName && /^\d{9}$/.test(String(c.siren)));
  const noFirst = candidates.filter((c) => !c.firstName).length;
  const noLast = candidates.filter((c) => !c.lastName).length;
  const noCompany = candidates.filter((c) => !c.companyName).length;
  const validCount = valid.length;

  console.log(`\nPool selectCandidates : ${candidates.length}`);
  console.log(`  - sans firstName : ${noFirst}`);
  console.log(`  - sans lastName  : ${noLast}`);
  console.log(`  - sans companyName: ${noCompany}`);
  console.log(`  - input complet (Dropcontact-ready) : ${validCount}`);

  if (validCount === 0) {
    console.log('Aucun candidate avec input Dropcontact complet, skip API call.');
    return { stats: {}, samples: [], poolSize: candidates.length, validCount: 0 };
  }

  // Aperçu inputs (vérifie que le fix S1 RNE produit du propre).
  console.log('\n  Aperçu 5 premiers inputs Dropcontact (post-fix S1):');
  valid.slice(0, 5).forEach((c) => {
    console.log(`    siren=${c.siren} firstName="${c.firstName}" lastName="${c.lastName}" company="${c.companyName.slice(0, 40)}"`);
  });

  // Appel Dropcontact en batch (1 seul polling).
  const data = await callDropcontactBatch(valid, apiKey);

  // Mapping résultats par siren.
  const stats = {
    nominative_verified: 0,
    nominative: 0,
    catch_all: 0,
    role: 0,
    miss: 0,
    other: 0,
  };
  const samples = [];

  for (let i = 0; i < valid.length; i++) {
    const cand = valid[i];
    const row = data.find((r) => String(r.siren) === String(cand.siren)) || data[i];
    const emails = Array.isArray(row && row.email) ? row.email : (row && row.email ? [row.email] : []);
    let bestEmail = null, bestQualif = null;
    for (const e of emails) {
      const q = typeof e === 'string' ? (row.qualification || '') : (e.qualification || row.qualification || '');
      const cls = classifyQualif(q);
      const rank = ['nominative_verified', 'nominative', 'catch_all', 'role'].indexOf(cls);
      const bestRank = bestQualif ? ['nominative_verified', 'nominative', 'catch_all', 'role'].indexOf(classifyQualif(bestQualif)) : 99;
      if (rank >= 0 && rank < bestRank) {
        bestEmail = typeof e === 'string' ? e : e.email;
        bestQualif = q;
      }
    }
    const cls = classifyQualif(bestQualif);
    if (stats[cls] !== undefined) stats[cls]++;
    else if (!bestEmail) stats.miss++;
    else stats.other++;
    samples.push({
      siren: cand.siren,
      name: `${cand.firstName} ${cand.lastName}`,
      company: cand.companyName.slice(0, 40),
      ville: cand.ville,
      email: bestEmail,
      qualif: cls,
      qualifRaw: bestQualif,
    });
  }

  console.log(`\nRésultats Dropcontact (${validCount} leads testés) :`);
  console.log(`  nominative_verified : ${stats.nominative_verified} (${pct(stats.nominative_verified, validCount)})`);
  console.log(`  nominative          : ${stats.nominative} (${pct(stats.nominative, validCount)})`);
  console.log(`  catch_all           : ${stats.catch_all} (${pct(stats.catch_all, validCount)})`);
  console.log(`  role                : ${stats.role} (${pct(stats.role, validCount)})`);
  console.log(`  miss                : ${stats.miss} (${pct(stats.miss, validCount)})`);
  if (stats.other > 0) console.log(`  other               : ${stats.other}`);
  const matchTotal = stats.nominative_verified + stats.nominative + stats.catch_all;
  console.log(`  ─ Total exploitable (nominative + catch_all) : ${matchTotal}/${validCount} (${pct(matchTotal, validCount)})`);

  console.log(`\n  20 premiers samples :`);
  samples.slice(0, 20).forEach((s) => {
    const tag = s.email ? `→ ${s.email} [${s.qualif}]` : '(miss)';
    console.log(`    ${s.siren} ${s.name.padEnd(28).slice(0, 28)} | ${s.company.padEnd(38).slice(0, 38)} | ${s.ville.padEnd(20).slice(0, 20)} ${tag}`);
  });

  return { stats, samples, poolSize: candidates.length, validCount };
}

function pct(n, total) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

async function main() {
  const apiKey = process.env.DROPCONTACT_API_KEY;
  if (!apiKey) {
    console.error('DROPCONTACT_API_KEY manquant. Charger via az + export.');
    process.exit(1);
  }

  console.log(`Sonde Dropcontact standalone — branche feat/dropcontact-elargi (avec fix S1 RNE)`);
  console.log(`Date: ${new Date().toISOString()}`);

  const morgane = await probe('morgane', apiKey).catch((err) => {
    console.error(`probe Morgane échoué: ${err.message}`);
    return null;
  });
  const johnny = await probe('johnny', apiKey).catch((err) => {
    console.error(`probe Johnny échoué: ${err.message}`);
    return null;
  });

  console.log(`\n========================================`);
  console.log(`  RÉSUMÉ GLOBAL`);
  console.log(`========================================`);
  if (morgane) {
    const matchM = (morgane.stats.nominative_verified || 0) + (morgane.stats.nominative || 0) + (morgane.stats.catch_all || 0);
    console.log(`Morgane : ${matchM}/${morgane.validCount} exploitable Dropcontact`);
  }
  if (johnny) {
    const matchJ = (johnny.stats.nominative_verified || 0) + (johnny.stats.nominative || 0) + (johnny.stats.catch_all || 0);
    console.log(`Johnny  : ${matchJ}/${johnny.validCount} exploitable Dropcontact`);
  }
  console.log(`\nFin sonde.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
