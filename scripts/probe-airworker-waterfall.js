'use strict';

/**
 * Probe AirWorker waterfall — test waterfall complète locale sur 10 leads
 * sweet spot Pérenne (Morgane + Johnny), avec :
 *   - resolveDomain via Playwright Google (IP résidentielle, pas Brave/api.gouv)
 *   - scrapeDomain mode 'exhaustive' (mentions légales, cgv, etc.)
 *   - Dropcontact gaté sur domaine résolu (économise crédits sur hopeless)
 *   - resolveEmail patterns + cross-check
 *
 * Mesure le taux de résolution réel post-fix S1 normalisation RNE +
 * Playwright local + scrape exhaustif. À comparer avec :
 *   - sonde Dropcontact 8 mai matin standalone : 2/52 (4%)
 *   - run prod 8 mai matin : 0/12 (0%)
 *
 * Pure code local : Storage Tables + Playwright + Dropcontact API. Aucun
 * appel à FA Azure ni Container App. Aucun appel API webSearch payante.
 */

// ─── Force backend Playwright pour cette run ───────────────────────────────
process.env.SITE_FINDER_WEBSEARCH_BACKENDS = 'playwright_google';
// Pas de cache négatif pour ce probe — on veut vraiment retenter.
process.env.LEADCONTACTS_NEGATIVE_RETRY_DAYS = '0';

const { selectCandidatesForConsultant } = require('../shared/leadSelector');
const { leadExhauster } = require('../shared/lead-exhauster');
const { scrapeDomain } = require('../shared/lead-exhauster/scraping');
const { DropcontactAdapter } = require('../shared/lead-exhauster/adapters/dropcontact');
const { probeEmail } = require('../shared/lead-exhauster/smtp-probe');
const { applyPattern, normalizeNamePart, normalizeDomain } = require('../shared/lead-exhauster/patterns');
const playwrightGoogle = require('../shared/site-finder/sources/webSearchBackends/playwrightGoogle');
const { isAggregator } = require('../shared/site-finder/aggregators');
const { resolveDomainCombo } = require('./airworker-domain-resolver');
const { extractBestEmail } = require('./airworker-email-extractor');
const { chromium } = require('playwright');
const { pMapLimit } = require('../shared/utils/p-map-limit');

// Browser context dédié à l'extraction emails (séparé de playwrightGoogle
// pour éviter de partager les cookies Google avec les sites entreprises).
let _extractorBrowser = null;
let _extractorContext = null;
async function getExtractorContext() {
  if (_extractorContext) return _extractorContext;
  _extractorBrowser = await chromium.launch({ headless: true });
  _extractorContext = await _extractorBrowser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'fr-FR',
  });
  return _extractorContext;
}
async function closeExtractor() {
  try { if (_extractorContext) await _extractorContext.close(); } catch { /* ignore */ }
  try { if (_extractorBrowser) await _extractorBrowser.close(); } catch { /* ignore */ }
  _extractorContext = null;
  _extractorBrowser = null;
}

// Patterns V1 ordonnés du plus probable au moins probable pour SMTP probe.
// On essaie les 4 premiers (les plus communs) avant de passer à Dropcontact.
// Évite le flood (8 patterns × N MX = beaucoup de probes).
const PATTERNS_FOR_SMTP_PROBE = [
  '{first}.{last}@{domain}',  // jean.dupont@acme.fr — pattern dominant FR
  '{first}@{domain}',         // jean@acme.fr — courant TPE
  '{f}.{last}@{domain}',      // j.dupont@acme.fr — courant
  '{first}-{last}@{domain}',  // jean-dupont@acme.fr — moins fréquent
];

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

// ─── Adapters AirWorker mode local ─────────────────────────────────────────

function makeExhaustiveScraper() {
  // Optimisations indolores AirWorker local :
  // - pageTimeoutMs 5000 (au lieu de 8000) : pages mentions-légales sont du
  //   HTML statique, 5s suffit pour les TPE FR. Jette les pages lentes.
  // - globalTimeoutMs 60000 (au lieu de 20000) : en mode local on n'a pas
  //   la contrainte FA Azure 230s. Permet scrape complet 15 pages exhaustif.
  return (input, opts) => scrapeDomain(input, {
    ...opts,
    mode: 'exhaustive',
    pageTimeoutMs: 5000,
    globalTimeoutMs: 60000,
  });
}

function makeNoOpDropcontact() {
  // Adapter Dropcontact "no-op" pour la cascade leadExhauster :
  // toujours retourne miss instantané. Décision Paul 8 mai PM : on n'appelle
  // Dropcontact que si la cascade interne (scrape mentions légales + patterns)
  // n'a pas suffi. La parallélisation S3 (qui appelle Dropcontact systématiquement)
  // est désactivée ici pour économiser les crédits.
  return {
    name: 'dropcontact',
    enabled: true,
    resolve: async () => ({
      email: null,
      confidence: 0,
      cost_cents: 0,
      providerRaw: { skipped: 'deferred_to_post_cascade' },
    }),
  };
}

async function resolveDomainViaPlaywright(siren, companyName, ville, dirigeantName) {
  // V6 (8 mai PM) : délègue à resolveDomainCombo qui combine 3 stratégies :
  // 1. heuristicUrlGuess (HEAD checks rapides sur slugs.fr/.com/.eu)
  // 2. Playwright Google avec queries variantes intelligentes (mot-clé court
  //    + ville, dirigeant + entreprise, etc. — pas juste raison sociale brute)
  // 3. Visite agrégateur pour extraire vrai site (V0 simplifié, à étendre)
  return await resolveDomainCombo({
    siren,
    companyName,
    ville,
    dirigeantName,
  });
}

// ─── Pipeline pour 1 lead ──────────────────────────────────────────────────

async function processLead(candidate, deps) {
  const t0 = Date.now();
  const dirigeantName = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();

  // Étape 1 : Playwright Google direct (bypass siteFinder qui pollue)
  let domain = null;
  let siteFinderSignals = [];
  try {
    const sf = await resolveDomainViaPlaywright(
      candidate.siren,
      candidate.companyName,
      candidate.ville,
      dirigeantName,
    );
    if (sf && sf.siteUrl) {
      // Sécurité finale : double-check pas un agrégateur
      if (isAggregator(sf.siteUrl)) {
        siteFinderSignals.push('sf.aggregator_rejected_at_pose');
      } else {
        domain = sf.siteUrl;
        siteFinderSignals.push(`sf.${sf.source}`, `sf.${sf.proofType || 'no_proof'}`);
        candidate.companyDomain = sf.siteUrl;
      }
    } else {
      siteFinderSignals.push('sf.no_result');
    }
  } catch (err) {
    siteFinderSignals.push(`sf.error:${(err.message || '').slice(0, 40)}`);
  }

  // Étape 1.5 (V7) : extraction emails Playwright avec rendu JS sur les
  // pages mentions-légales / contact / équipe. Sur sweet spot Pérenne, c'est
  // le levier #1 (probe 8 mai PM mesure 8/8 sites avec email extractible
  // vs 1/10 résolu via SMTP+Dropcontact). Si on trouve un email à confidence
  // suffisante, on COURT-CIRCUITE la cascade interne + SMTP + Dropcontact.
  let extractedEmail = null;
  if (domain && !isAggregator(domain) && candidate.firstName && candidate.lastName) {
    try {
      const ctx = await getExtractorContext();
      const ext = await extractBestEmail({
        siteUrl: domain,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        companyDomain: domain,
      }, { context: ctx });
      if (ext && ext.email && ext.confidence >= 0.60) {
        extractedEmail = ext;
      }
    } catch (err) {
      // ignore, on continue avec la cascade interne
    }
  }

  if (extractedEmail) {
    return {
      siren: candidate.siren,
      name: dirigeantName,
      company: candidate.companyName,
      ville: candidate.ville,
      domain,
      siteFinderSignals,
      status: 'ok',
      email: extractedEmail.email,
      confidence: extractedEmail.confidence,
      source: `playwright_extract_${extractedEmail.type}`,
      cost_cents: 0,
      signals: [...siteFinderSignals, `extract.${extractedEmail.type}`, `extract.confidence_${Math.round(extractedEmail.confidence * 100)}`],
      elapsedMs: Date.now() - t0,
    };
  }

  // Étape 2 : cascade interne (scrape mentions légales + patterns + DM)
  // Note : Dropcontact est désactivé via adapter no-op dans deps.adapters.
  let result = await leadExhauster(
    {
      siren: candidate.siren,
      beneficiaryId: 'probe-airworker',
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      companyName: candidate.companyName,
      companyDomain: domain || candidate.companyDomain,
      inseeRole: candidate.inseeRole,
      trancheEffectif: candidate.trancheEffectif,
      naf: candidate.codeNaf,
    },
    { adapters: deps.adapters },
  ).catch((err) => ({
    status: 'error',
    email: null,
    confidence: 0,
    source: 'none',
    signals: [`exhauster.throw:${(err.message || '').slice(0, 40)}`],
    elapsedMs: Date.now() - t0,
  }));

  // Étape 2.5 : SMTP probe sur patterns standards (avant Dropcontact)
  // Stratégie : si la cascade interne n'a pas résolu mais qu'on a un domaine
  // + dirigeant identifié, on tente une vérification SMTP soft sur les 4
  // patterns email les plus communs en France. SMTP probe = connect MX:25 +
  // EHLO + MAIL FROM + RCPT TO + QUIT, sans envoi DATA.
  //
  // Réduit la dépendance Dropcontact : si un pattern répond 250 OK, on a un
  // email validé sans appel Dropcontact (économie crédits + latence).
  let smtpProbed = 0;
  let smtpVerified = null;
  if (result.status !== 'ok'
      && domain && !isAggregator(domain)
      && candidate.firstName && candidate.lastName) {
    const normDomain = normalizeDomain(domain);
    if (normDomain) {
      for (const tpl of PATTERNS_FOR_SMTP_PROBE) {
        const candidateEmail = applyPattern(tpl, {
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          domain: normDomain,
        });
        if (!candidateEmail) continue;
        smtpProbed++;
        try {
          const sr = await probeEmail(candidateEmail, { timeoutMs: 10000 });
          if (sr.status === 'ok') {
            smtpVerified = { email: candidateEmail, code: sr.code, mxHost: sr.mxHost };
            break;
          }
          // Si server répond explicitement rejected/temporary, on note et
          // continue avec le pattern suivant. Si timeout/error, on essaye
          // toujours les autres patterns.
        } catch (err) {
          // ignore, try next
        }
      }
    }
  }

  if (smtpVerified) {
    result = {
      ...result,
      status: 'ok',
      email: smtpVerified.email,
      confidence: 0.85,  // confidence SMTP-verified : haute mais < nominative_verified
      source: 'smtp_probe',
      cost_cents: 0,
      signals: [...(result.signals || []), `smtp.probed_${smtpProbed}`, 'smtp.verified'],
    };
  } else if (smtpProbed > 0) {
    result.signals = [...(result.signals || []), `smtp.probed_${smtpProbed}`, 'smtp.no_match'];
  }

  // Étape 3 : Dropcontact UNIQUEMENT si cascade interne + SMTP probe n'ont
  // pas résolu ET qu'on a un domaine valide. Décision Paul 8 mai PM :
  // Dropcontact en dernier recours seulement, économise crédits.
  if (result.status !== 'ok' && domain && !isAggregator(domain)) {
    try {
      const dropResult = await deps.realDropcontact.resolve({
        siren: candidate.siren,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
        companyName: candidate.companyName,
        companyDomain: domain,
      });
      if (dropResult && dropResult.email && dropResult.confidence >= 0.50) {
        result = {
          ...result,
          status: 'ok',
          email: dropResult.email,
          confidence: dropResult.confidence,
          source: 'dropcontact',
          cost_cents: dropResult.cost_cents || 0,
          signals: [...(result.signals || []), `cascade.dropcontact.${dropResult.email ? 'hit' : 'miss'}`],
        };
      } else {
        result.signals = [...(result.signals || []), 'cascade.dropcontact.miss_post_scrape'];
      }
    } catch (err) {
      result.signals = [...(result.signals || []), `cascade.dropcontact.error:${(err.message || '').slice(0, 30)}`];
    }
  } else if (result.status === 'ok') {
    result.signals = [...(result.signals || []), 'cascade.dropcontact.skipped_internal_ok'];
  } else if (!domain) {
    result.signals = [...(result.signals || []), 'cascade.dropcontact.skipped_no_domain'];
  }

  return {
    siren: candidate.siren,
    name: dirigeantName,
    company: candidate.companyName,
    ville: candidate.ville,
    domain: domain || result.resolvedDomain,
    siteFinderSignals,
    status: result.status,
    email: result.email,
    confidence: result.confidence,
    source: result.source,
    cost_cents: result.cost_cents,
    signals: result.signals,
    elapsedMs: Date.now() - t0,
  };
}

// ─── Probe ─────────────────────────────────────────────────────────────────

async function probe(consultantKey) {
  const brief = BRIEFS[consultantKey];
  console.log(`\n========================================`);
  console.log(`  ${brief.nom} — ${brief.ville}`);
  console.log(`========================================`);

  console.log('Sélection candidates (selectCandidatesForConsultant)...');
  const selectorResult = await selectCandidatesForConsultant({
    brief,
    batchSize: 5,
    candidateMultiplier: 1,
    consultantId: brief.email,
    briefId: brief.email,
  });

  if (!selectorResult.candidates || selectorResult.candidates.length === 0) {
    console.log(`Pool vide : status=${selectorResult.status}`);
    return [];
  }

  const candidates = selectorResult.candidates
    .filter((c) => c.firstName && c.lastName && c.companyName && /^\d{9}$/.test(String(c.siren)))
    .slice(0, 5);

  console.log(`Pool : ${candidates.length} candidates avec input complet\n`);

  // Dropcontact réel pour appel manuel post-cascade (étape 3 de processLead).
  const realDropcontact = new DropcontactAdapter();
  const adapters = {
    // BYPASS CACHE LeadContacts : la 1ère probe a écrit des faux positifs
    // (prosmaison.fr/entreprise-XYZ) en cache. On force null pour ne PAS
    // les ré-utiliser. Le probe ré-exécute la waterfall complète à chaque
    // fois pour mesurer post-fix.
    readLeadContact: async () => null,
    // resolveDomain bypass api.gouv (IP Paul bannie 6 mai). Le domaine vient
    // du siteFinder Playwright pré-passé par processLead.
    resolveDomain: async (input) => ({
      domain: input.companyDomain || null,
      confidence: input.companyDomain ? 1.0 : 0,
      source: input.companyDomain ? 'input_via_playwright' : 'none',
      signals: input.companyDomain ? ['domain_from_input'] : ['no_domain'],
      elapsedMs: 0,
    }),
    scrapeDomain: makeExhaustiveScraper(),
    // Dropcontact NO-OP dans la cascade leadExhauster : la parallélisation S3
    // appelle dropcontact systématiquement. On la neutralise ici. Le vrai
    // appel Dropcontact se fait MANUELLEMENT post-cascade dans processLead
    // (étape 3), uniquement si l'interne n'a rien trouvé ET qu'on a un
    // domaine valide.
    dropcontact: makeNoOpDropcontact(),
    // Pour le probe : on ne pollue PAS LeadContacts avec les résultats du
    // probe (sinon on contamine les futures probes). En prod AirWorker
    // continuous, on activera l'écriture normale.
    upsertLeadContact: async () => true,
  };

  // v8 optim : 2 leads en parallèle (concurrency=2). Compromis sécurité
  // (limite ban Google : 2 requêtes simultanées d'une même IP, plus fiable
  // que 3+) vs gain temps (÷2 sur 5 leads, vs ÷3 trop risqué).
  const CONCURRENCY = 2;
  const results = await pMapLimit(candidates, CONCURRENCY, async (cand) => {
    console.log(`--- ${cand.firstName} ${cand.lastName} @ ${cand.companyName.slice(0, 35)}`);
    const r = await processLead(cand, { adapters, realDropcontact });
    console.log(`  domain=${r.domain || '(none)'} | status=${r.status} | email=${r.email || '(no)'} | conf=${r.confidence} | source=${r.source} | ${r.elapsedMs}ms`);
    if (r.signals && r.signals.length) {
      console.log(`  signals: ${r.signals.slice(0, 16).join(' | ')}`);
    }
    return r;
  });

  return results;
}

async function main() {
  console.log(`Probe AirWorker waterfall locale — Playwright + scrape exhaustif`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Backend webSearch : ${process.env.SITE_FINDER_WEBSEARCH_BACKENDS}`);

  const morgane = await probe('morgane').catch((err) => {
    console.error(`probe Morgane échoué: ${err.message}`);
    return [];
  });
  const johnny = await probe('johnny').catch((err) => {
    console.error(`probe Johnny échoué: ${err.message}`);
    return [];
  });

  const all = [...morgane, ...johnny];
  const ok = all.filter((r) => r.status === 'ok');
  const withDomain = all.filter((r) => r.domain);

  console.log(`\n========================================`);
  console.log(`  RÉSUMÉ GLOBAL`);
  console.log(`========================================`);
  console.log(`Total leads : ${all.length}`);
  console.log(`Domaine résolu : ${withDomain.length} (${pct(withDomain.length, all.length)})`);
  console.log(`Email résolu (status=ok) : ${ok.length} (${pct(ok.length, all.length)})`);
  console.log('');
  console.log('Détail email résolu :');
  ok.forEach((r) => {
    console.log(`  ${r.siren} ${r.name.padEnd(28)} | ${r.email} (${r.source}, conf=${r.confidence})`);
  });

  console.log('\nFermeture browsers Playwright...');
  await playwrightGoogle.closeBrowser();
  await closeExtractor();
  console.log('Fin probe.');
}

function pct(n, total) {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

main().catch(async (err) => {
  console.error(err);
  try { await playwrightGoogle.closeBrowser(); } catch {}
  process.exit(1);
});
