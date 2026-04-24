'use strict';

/**
 * Couche A — fiche entreprise.
 *
 * Orchestration :
 *   1. Tente le cache (Azure Table) — hit <30j → on renvoie
 *   2. En parallèle : API Gouv (siren) + scraper site + googleSearch (stub V0)
 *   3. Extraction LLM Haiku 4.5 : concatène le texte brut, demande un JSON
 *      factuel {activity, specialties, mainClients, recentSignals}
 *   4. Enrichit avec les champs identité (API Gouv) + les signaux (googleSearch)
 *   5. Calcule confidence heuristique + écrit le cache
 *
 * Dégradation gracieuse :
 *   - Toutes les sources peuvent échouer sans bloquer
 *   - LLM timeout / erreur → on renvoie une fiche enrichie uniquement par
 *     les sources déterministes (API Gouv)
 *   - Si plus aucune donnée factuelle → `null` pour laisser le caller
 *     basculer en status='partial' / 'error'
 *
 * Budget :
 *   - Timeout global configurable (défaut 30s, conforme SPEC §4.3)
 *   - Cost estimé : 1 appel Haiku input ~4000 tokens, output ~400 → ~0.02€
 *
 * Tests :
 *   - En mode LLM_ADAPTER=mock, l'extraction LLM est stubée.
 *   - Les 3 sources sont injectables via opts.{apiGouvImpl, scraperImpl, searchImpl}.
 */

const { fetchCompanyFromApiGouv } = require('./sources/apiGouv');
const { scrapeCompanyWebsite } = require('./sources/websiteScraper');
const { searchRecentSignals } = require('./sources/googleSearch');
const {
  getCachedCompanyProfile,
  setCachedCompanyProfile,
} = require('./cache/companyProfilesCache');
const { callClaude, parseJson, MODEL_HAIKU } = require('../anthropic');

const DEFAULT_GLOBAL_TIMEOUT_MS = 30000;
const DEFAULT_LLM_TIMEOUT_MS = 15000;
const DEFAULT_LLM_MAX_TOKENS = 1200;
const DEFAULT_MAX_INPUT_CHARS = 24000; // Budget input Haiku

// ─── Interface publique ────────────────────────────────────────────────────

/**
 * Construit la fiche entreprise pour un SIREN.
 *
 * @param {object} input
 * @param {string} input.siren
 * @param {string} [input.companyName]     Fallback si API Gouv down
 * @param {string} [input.companyDomain]   Pour scraping site. Vide → skip scrape
 * @param {object} [opts]
 * @param {object} [opts.context]          Logger Azure (context.log)
 * @param {number} [opts.timeoutMs]        Budget global (défaut 30s)
 * @param {boolean} [opts.skipCache]       Forcer rebuild
 * @param {Function} [opts.apiGouvImpl]    Injection tests
 * @param {Function} [opts.scraperImpl]
 * @param {Function} [opts.searchImpl]
 * @param {Function} [opts.llmImpl]        (req) => { text }
 * @returns {Promise<{
 *   siren: string,
 *   activity: string|null,
 *   specialties: string[],
 *   mainClients: string[],
 *   recentSignals: Array,
 *   nomEntreprise: string|null,
 *   codeNaf: string|null,
 *   commune: string|null,
 *   estActive: boolean|null,
 *   sources: {apiGouv: boolean, website: boolean, search: boolean},
 *   confidence: number,
 *   elapsedMs: number,
 *   cached: boolean,
 *   costCents: number
 * }|null>}
 */
async function buildCompanyProfile(input, opts = {}) {
  const started = Date.now();
  const siren = String(input && input.siren ? input.siren : '').trim();
  if (!/^\d{9}$/.test(siren)) return null;

  const logger = makeLogger(opts.context);
  const globalTimeoutMs = opts.timeoutMs || DEFAULT_GLOBAL_TIMEOUT_MS;

  // 1. Cache lookup
  if (!opts.skipCache) {
    const cached = await getCachedCompanyProfile(siren).catch(() => null);
    if (cached && cached.profile) {
      logger.info('profiler.companyProfile.cache_hit', {
        siren,
        weekYear: cached.weekYear,
      });
      return {
        ...cached.profile,
        cached: true,
        elapsedMs: Date.now() - started,
      };
    }
  }

  logger.info('profiler.companyProfile.start', { siren });

  // 2. Sources en parallèle (bornées par le budget global)
  const apiGouvImpl = opts.apiGouvImpl || fetchCompanyFromApiGouv;
  const scraperImpl = opts.scraperImpl || scrapeCompanyWebsite;
  const searchImpl = opts.searchImpl || searchRecentSignals;

  const domain = (input.companyDomain || '').trim();
  const companyName = String(input.companyName || '').trim();

  const promises = [
    withBudget(apiGouvImpl(siren), globalTimeoutMs).catch(() => null),
    domain
      ? withBudget(scraperImpl(domain, { globalBudgetMs: 15000 }), globalTimeoutMs).catch(() => null)
      : Promise.resolve(null),
    companyName
      ? withBudget(searchImpl(companyName), globalTimeoutMs).catch(() => null)
      : Promise.resolve(null),
  ];

  const [apiGouv, scrape, search] = await Promise.all(promises);

  logger.info('profiler.companyProfile.sources_done', {
    siren,
    apiGouv: !!apiGouv,
    scrapedPages: scrape ? scrape.texts.length : 0,
    searchResults: search ? search.results.length : 0,
  });

  // 3. Extraction LLM sur le corpus textuel (site + signaux + activité déclarée)
  const textCorpus = buildCorpus({ apiGouv, scrape, search, companyName });
  const hasTextToExtract = textCorpus.length >= 200;

  let extracted = null;
  let costCents = 0;
  if (hasTextToExtract) {
    try {
      const llmRes = await withBudget(
        runExtraction({
          companyName: (apiGouv && apiGouv.nomEntreprise) || companyName,
          corpus: textCorpus,
          llmImpl: opts.llmImpl,
          logger,
        }),
        Math.min(globalTimeoutMs, DEFAULT_LLM_TIMEOUT_MS),
      );
      extracted = llmRes.extracted;
      costCents = llmRes.costCents;
    } catch (err) {
      logger.warn('profiler.companyProfile.llm_failed', {
        siren,
        err: err && err.message,
      });
    }
  }

  // 4. Construction du payload final
  const profile = buildPayload({ siren, apiGouv, scrape, search, extracted });

  // 5. Confidence heuristique
  profile.confidence = computeConfidence(profile);

  // 6. Si vraiment rien de factuel → null (laisse le caller basculer en partial)
  if (isEmpty(profile)) {
    logger.warn('profiler.companyProfile.empty', { siren });
    return null;
  }

  profile.elapsedMs = Date.now() - started;
  profile.costCents = costCents;
  profile.cached = false;

  // 7. Écriture cache (best effort)
  await setCachedCompanyProfile(siren, profile).catch(() => false);

  logger.info('profiler.companyProfile.done', {
    siren,
    confidence: profile.confidence,
    ms: profile.elapsedMs,
  });

  return profile;
}

// ─── Construction corpus LLM ───────────────────────────────────────────────

function buildCorpus({ apiGouv, scrape, search, companyName }) {
  const parts = [];

  if (apiGouv && apiGouv.activiteDeclaree) {
    parts.push(
      `[IDENTITÉ OFFICIELLE]
Nom : ${apiGouv.nomEntreprise || companyName || '?'}
Activité déclarée : ${apiGouv.activiteDeclaree}
${apiGouv.codeNaf ? `Code NAF : ${apiGouv.codeNaf}\n` : ''}${apiGouv.commune ? `Commune : ${apiGouv.commune}\n` : ''}`,
    );
  }

  if (scrape && Array.isArray(scrape.texts)) {
    for (const t of scrape.texts) {
      if (!t || !t.text) continue;
      parts.push(`[PAGE ${t.url}]\n${t.text}`);
    }
  }

  if (search && Array.isArray(search.results) && search.results.length > 0) {
    parts.push(
      `[SIGNAUX ACTUALITÉ]\n${search.results
        .map((r) => `- ${r.title} (${r.source || ''}) : ${r.snippet || ''}`)
        .join('\n')}`,
    );
  }

  let corpus = parts.join('\n\n');
  if (corpus.length > DEFAULT_MAX_INPUT_CHARS) {
    corpus = corpus.slice(0, DEFAULT_MAX_INPUT_CHARS);
  }
  return corpus;
}

// ─── Extraction LLM (Haiku) ────────────────────────────────────────────────

const SYSTEM_PROMPT_EXTRACTION = `Tu es un analyste B2B français. À partir du texte fourni (site entreprise, identité officielle, signaux publics), extrais des faits strictement présents dans le texte.

RÈGLES ABSOLUES :
- N'INVENTE RIEN. Si un axe n'est pas mentionné explicitement, retourne null ou tableau vide.
- Ne devine pas les clients, benchmarks, chiffres.
- Réponds UNIQUEMENT en JSON valide, sans texte autour, sans fences.

Schéma de sortie :
{
  "activity": string | null,
  "specialties": string[],
  "mainClients": string[],
  "recentSignals": [
    {"type": "hiring" | "fundraising" | "press" | "product_launch" | "other",
     "description": string,
     "sourceUrl": string | null,
     "date": string | null}
  ]
}`;

async function runExtraction({ companyName, corpus, llmImpl, logger }) {
  const userPrompt = `ENTREPRISE CIBLE : ${companyName || '(nom non connu)'}

TEXTE À ANALYSER :
"""
${corpus}
"""

Extrais en JSON strict selon le schéma.`;

  const impl = llmImpl || callClaude;
  const res = await impl({
    system: SYSTEM_PROMPT_EXTRACTION,
    messages: [{ role: 'user', content: userPrompt }],
    model: MODEL_HAIKU,
    maxTokens: DEFAULT_LLM_MAX_TOKENS,
    temperature: 0,
  });

  let extracted;
  try {
    extracted = parseJson(res.text);
  } catch (err) {
    logger.warn('profiler.companyProfile.llm_parse_error', {
      err: err && err.message,
      sample: String(res.text || '').slice(0, 120),
    });
    return { extracted: null, costCents: 0 };
  }

  // Sanitize minimaliste : forcer les types attendus
  const sanitized = {
    activity: typeof extracted.activity === 'string' && extracted.activity.trim()
      ? extracted.activity.trim()
      : null,
    specialties: Array.isArray(extracted.specialties)
      ? extracted.specialties.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    mainClients: Array.isArray(extracted.mainClients)
      ? extracted.mainClients.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
      : [],
    recentSignals: Array.isArray(extracted.recentSignals)
      ? extracted.recentSignals
          .filter((s) => s && typeof s === 'object' && typeof s.description === 'string')
          .map((s) => ({
            type: normalizeSignalType(s.type),
            description: String(s.description).trim(),
            sourceUrl: typeof s.sourceUrl === 'string' && s.sourceUrl.trim() ? s.sourceUrl.trim() : null,
            date: typeof s.date === 'string' && s.date.trim() ? s.date.trim() : null,
          }))
      : [],
  };

  // Cost approximatif Haiku 4.5 : input ~0.0008€/1k tokens, output ~0.004€/1k tokens
  // On estime en chars (4 chars ≈ 1 token).
  const inputTokens = Math.ceil((SYSTEM_PROMPT_EXTRACTION.length + userPrompt.length) / 4);
  const outputTokens = Math.ceil((res.text || '').length / 4);
  const costCents = Math.round(
    (inputTokens * 0.08 + outputTokens * 0.4) / 1000,
  );
  return { extracted: sanitized, costCents };
}

function normalizeSignalType(t) {
  const allowed = ['hiring', 'fundraising', 'press', 'product_launch'];
  if (typeof t === 'string' && allowed.includes(t)) return t;
  return 'other';
}

// ─── Construction payload final ────────────────────────────────────────────

function buildPayload({ siren, apiGouv, scrape, search, extracted }) {
  const nomEntreprise = (apiGouv && apiGouv.nomEntreprise) || null;
  const payload = {
    siren,
    nomEntreprise,
    activity: (extracted && extracted.activity) || (apiGouv && apiGouv.activiteDeclaree) || null,
    specialties: (extracted && extracted.specialties) || [],
    mainClients: (extracted && extracted.mainClients) || [],
    recentSignals: (extracted && extracted.recentSignals) || [],
    codeNaf: (apiGouv && apiGouv.codeNaf) || null,
    commune: (apiGouv && apiGouv.commune) || null,
    trancheEffectif: (apiGouv && apiGouv.trancheEffectif) || null,
    estActive: apiGouv ? apiGouv.estActive : null,
    sources: {
      apiGouv: !!apiGouv,
      website: !!(scrape && scrape.texts && scrape.texts.length > 0),
      search: !!(search && search.results && search.results.length > 0),
    },
    version: 'v0',
  };
  return payload;
}

// ─── Confidence heuristique ────────────────────────────────────────────────
// Simple et explicable : on somme des poids. Pas de ML, pas de fit :
// le but est de donner un signal grossier au caller pour décider si on
// active l'adaptation DISC ou si on reste neutre.

function computeConfidence(profile) {
  let score = 0;
  if (profile.sources.apiGouv && profile.activity) score += 0.35;
  if (profile.sources.website) score += 0.3;
  if (profile.specialties.length > 0) score += 0.1;
  if (profile.mainClients.length > 0) score += 0.1;
  if (profile.recentSignals.length > 0) score += 0.15;
  return Math.min(1, Number(score.toFixed(2)));
}

function isEmpty(profile) {
  return (
    !profile.activity &&
    profile.specialties.length === 0 &&
    profile.mainClients.length === 0 &&
    profile.recentSignals.length === 0 &&
    !profile.nomEntreprise
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function withBudget(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise);
  let handle;
  const timer = new Promise((_, reject) => {
    handle = setTimeout(() => {
      const e = new Error(`companyProfile budget exceeded after ${ms}ms`);
      e.name = 'AbortError';
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timer]).finally(() => clearTimeout(handle));
}

function makeLogger(context) {
  const info = (context && (context.info || (context.log && context.log.info))) || (context && context.log);
  const warn = (context && (context.warn || (context.log && context.log.warn))) || info;
  return {
    info: (msg, payload) => {
      if (typeof info === 'function') {
        try { info(msg, payload); } catch { /* noop */ }
      }
    },
    warn: (msg, payload) => {
      if (typeof warn === 'function') {
        try { warn(msg, payload); } catch { /* noop */ }
      }
    },
  };
}

module.exports = {
  buildCompanyProfile,
  // Exports pour tests unitaires
  _buildCorpus: buildCorpus,
  _computeConfidence: computeConfidence,
  _isEmpty: isEmpty,
  _normalizeSignalType: normalizeSignalType,
};
