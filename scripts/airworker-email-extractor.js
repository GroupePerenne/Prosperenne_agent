'use strict';

/**
 * AirWorker Email Extractor — extraction d'emails depuis le HTML rendu d'un
 * site entreprise via Playwright (Chromium headless local).
 *
 * Sur sweet spot Pérenne BTP TPE 10-20 sal, SMTP probe et Dropcontact sont
 * largement inopérants (Hornetsecurity rejette tout, IONOS catch-all
 * indiscriminable, Dropcontact n'a pas la donnée). En revanche, les emails
 * sont **physiquement présents** dans le HTML des pages mentions-légales /
 * contact / équipe — sous formes diverses (mailto:, cfemail Cloudflare,
 * JSON-LD Schema.org, regex texte). Notre scrape HTTP statique rate ces
 * emails car (a) certains sites les chargent via JS, (b) Cloudflare obfuscate.
 *
 * Probe 8 mai PM mesure : 8/8 sites avec au moins 1 email extractible
 * vs 1/10 résolu via SMTP+Dropcontact. → +70-80% taux email résolu.
 *
 * Sources d'extraction (toutes locales, pas d'appel API) :
 *   1. Liens mailto: dans le DOM
 *   2. Cloudflare email obfuscation (data-cfemail XOR decoding)
 *   3. JSON-LD Schema.org (Person, Organization)
 *   4. Regex sur HTML brut + innerText
 *
 * Scoring confiance par type :
 *   - 0.85 : nominatif match dirigeant (prenom.nom@, prenom@, p.nom@)
 *   - 0.75 : Gmail/Orange/Free perso trouvé sur site (TPE l'utilise comme pro)
 *   - 0.70 : nominatif autre nom (membre famille/équipe)
 *   - 0.65 : semi-personnel (secretariat@, assistante@)
 *   - 0.60 : générique (contact@, info@, accueil@) — lu par dirigeant TPE
 *   - 0.00 : junk (noreply@, webmaster@, postmaster@) → reject
 */

const PAGES_TO_VISIT = [
  '/mentions-legales',
  '/mentions',
  '/legal',
  '/contact',
  '/contactez-nous',
  '/equipe',
  '/notre-equipe',
  '/a-propos',
  '/qui-sommes-nous',
  '/',
];
const PAGE_TIMEOUT_MS = 8_000;       // v8 optim : 12s → 8s
const POST_RENDER_WAIT_MS = 800;     // v8 optim : 1500ms → 800ms
// Confidence threshold pour early stop : si on trouve un email à ≥ ce score
// dès la 1re page, on annule les autres pages et on retourne.
const EARLY_STOP_CONFIDENCE = 0.85;

const EMAIL_REGEX = /[A-Za-z0-9]([A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?\.[A-Za-z]{2,}/g;

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'orange.fr', 'wanadoo.fr', 'sfr.fr', 'free.fr', 'laposte.net', 'neuf.fr',
  'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'live.fr',
  'yahoo.fr', 'yahoo.com',
  'protonmail.com', 'proton.me',
]);

const JUNK_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'webmaster', 'postmaster', 'abuse', 'admin', 'root', 'hostmaster',
  'mailer-daemon', 'support-noreply', 'sentry',
]);

// V8.1 (8 mai 2026 PM) — emails placeholder/exemple détectés en HTML scrapé
// (cas Valery VAILLOUD → jean.dupont@gmail.com sur dept 01). Beaucoup de
// thèmes WordPress/builders contiennent des emails d'exemple en mockup.
// Liste fermée des patterns CONNUS, à étendre si nouveau cas.
const PLACEHOLDER_EMAILS = new Set([
  'jean.dupont@gmail.com',
  'jeandupont@gmail.com',
  'jean-dupont@gmail.com',
  'john.doe@gmail.com',
  'johndoe@gmail.com',
  'john.doe@example.com',
  'john@example.com',
  'jane.doe@example.com',
  'test@test.com',
  'test@gmail.com',
  'email@example.com',
  'votre.email@exemple.fr',
  'votre@email.com',
  'name@example.com',
  'user@example.com',
  'demo@demo.com',
  'sample@sample.com',
]);

// V8.1 — les freemails (Gmail/Orange/etc.) ne sont acceptés QUE si le
// local-part match approximativement le dirigeant. Sinon c'est probable
// un placeholder ou un email tiers du site (ex: webmaster perso, fournisseur).
function freemailMatchesDirigeant(local, firstNorm, lastNorm) {
  if (!firstNorm && !lastNorm) return false;
  const localNorm = local.replace(/[^a-z]/g, '');
  if (!localNorm) return false;
  // Match exact ou contains avec longueur min 4 chars (évite 'jl' qui matche 'jean.dupont')
  if (firstNorm && firstNorm.length >= 4 && localNorm.includes(firstNorm)) return true;
  if (lastNorm && lastNorm.length >= 4 && localNorm.includes(lastNorm)) return true;
  if (firstNorm && lastNorm && (localNorm === firstNorm + lastNorm || localNorm === lastNorm + firstNorm)) return true;
  return false;
}

const GENERIC_LOCAL_PARTS = new Set([
  'contact', 'info', 'infos', 'hello', 'bonjour', 'mail',
  'accueil', 'sav', 'commercial', 'sales', 'vente', 'ventes',
]);

const SEMI_PERSONAL_LOCAL_PARTS = new Set([
  'secretariat', 'secretaire', 'assistante', 'assistant',
  'direction', 'pdg', 'gerant', 'gerance',
]);

function decodeCloudflareEmail(cfemail) {
  if (!cfemail || typeof cfemail !== 'string') return null;
  const hex = cfemail.replace(/\s/g, '');
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(key)) return null;
  let email = '';
  for (let i = 2; i < hex.length; i += 2) {
    const charCode = parseInt(hex.slice(i, i + 2), 16) ^ key;
    if (!Number.isFinite(charCode)) return null;
    email += String.fromCharCode(charCode);
  }
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return null;
  return email.toLowerCase();
}

function normalizeNamePart(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

/**
 * Score un email candidate par rapport au dirigeant attendu et au type.
 * Retourne { confidence, type, reason } ou null si rejet.
 */
function scoreEmail(email, dirigeantFirstName, dirigeantLastName, companyDomain) {
  if (!email || typeof email !== 'string') return null;
  const lower = email.toLowerCase();
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lower)) return null;
  const [local, domain] = lower.split('@');
  if (!local || !domain) return null;

  // V8.1 — Placeholder email (jean.dupont@gmail.com, john.doe@, etc.) → reject
  if (PLACEHOLDER_EMAILS.has(lower)) return null;

  // Junk → reject
  for (const j of JUNK_LOCAL_PARTS) {
    if (local === j || local.startsWith(`${j}.`)) return null;
  }

  const firstNorm = normalizeNamePart(dirigeantFirstName);
  const lastNorm = normalizeNamePart(dirigeantLastName);
  const localNorm = local.replace(/[^a-z]/g, '');

  // 1. Match nominatif strict (prenom.nom, prenom-nom, prenomnom, prenom, p.nom)
  if (firstNorm && lastNorm) {
    const fullPattern = firstNorm + lastNorm;
    const initialPattern = firstNorm.charAt(0) + lastNorm;
    if (localNorm === fullPattern || localNorm === lastNorm + firstNorm) {
      return { confidence: 0.85, type: 'nominatif_match', reason: 'first+last match' };
    }
    if (localNorm === firstNorm) {
      return { confidence: 0.80, type: 'nominatif_first', reason: 'firstname only' };
    }
    if (localNorm === initialPattern) {
      return { confidence: 0.80, type: 'nominatif_initial', reason: 'initial+lastname' };
    }
    if (localNorm === lastNorm) {
      return { confidence: 0.78, type: 'nominatif_last', reason: 'lastname only' };
    }
  }

  // 2. Email perso freemail trouvé sur le site (TPE FR utilise gmail/orange comme pro).
  // V8.1 — accepter UNIQUEMENT si le local-part match le dirigeant (≥4 chars
  // commun). Sinon c'est un placeholder ou email tiers (ex: jean.dupont@gmail.com
  // sur le site de Valery VAILLOUD = bullshit). Faux positifs détectés en prod 8 mai PM.
  if (FREEMAIL_DOMAINS.has(domain)) {
    if (freemailMatchesDirigeant(local, firstNorm, lastNorm)) {
      return { confidence: 0.75, type: 'freemail_perso', reason: `freemail ${domain} match dirigeant` };
    }
    // Freemail sans match dirigeant → potentiel placeholder, on rejette
    return null;
  }

  // 3. Nominatif partiel sur le bon domaine (ex: f.broka quand dirigeant Gerard)
  // Hypothèse : membre famille / équipe, dirigeant adjacent.
  if (companyDomain && domain === companyDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]) {
    // Pattern type "x.nom@" ou "prenom@" sans match dirigeant exact
    if (/^[a-z]{1,2}\.[a-z]{2,}$/.test(local) || /^[a-z]{2,}\.[a-z]{1,2}$/.test(local)) {
      return { confidence: 0.70, type: 'nominatif_other', reason: 'pattern nominatif autre' };
    }
    if (/^[a-z]{2,15}$/.test(local) && !GENERIC_LOCAL_PARTS.has(local) && !SEMI_PERSONAL_LOCAL_PARTS.has(local)) {
      return { confidence: 0.68, type: 'nominatif_first_other', reason: 'prénom autre membre' };
    }
  }

  // 4. Semi-personnel (secrétariat, direction, etc.)
  for (const sp of SEMI_PERSONAL_LOCAL_PARTS) {
    if (local === sp || local.startsWith(`${sp}.`)) {
      return { confidence: 0.65, type: 'semi_personal', reason: `semi-personnel ${sp}` };
    }
  }

  // 5. Générique TPE (contact, info...) sur le domaine de l'entreprise
  if (companyDomain) {
    const cdNorm = companyDomain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (domain === cdNorm) {
      for (const g of GENERIC_LOCAL_PARTS) {
        if (local === g || local.startsWith(`${g}_`) || local.startsWith(`${g}-`) || local.startsWith(`${g}.`)) {
          return { confidence: 0.60, type: 'generic_company', reason: `générique ${g} sur domaine entreprise` };
        }
      }
      // Email arbitraire sur le bon domaine = probable mais sans info supplémentaire
      return { confidence: 0.55, type: 'company_domain_other', reason: 'email arbitraire sur domaine entreprise' };
    }
  }

  // Hors scope : email sur un domaine tiers non freemail (probable spam ou tiers)
  return { confidence: 0.30, type: 'other_domain', reason: `hors domaine entreprise (${domain})` };
}

async function extractEmailsFromPage(page) {
  const data = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const cfemails = Array.from(document.querySelectorAll('[data-cfemail]'))
      .map((el) => el.getAttribute('data-cfemail'));
    const mailtos = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
      .map((el) => el.getAttribute('href').slice(7).split('?')[0]);
    const jsonLds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((el) => el.textContent);
    const innerText = document.body ? document.body.innerText.slice(0, 50000) : '';
    return { html, cfemails, mailtos, jsonLds, innerText };
  });

  const found = new Set();

  for (const m of data.mailtos) {
    const cleaned = String(m).trim().toLowerCase();
    if (/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
      found.add(cleaned);
    }
  }

  for (const cf of data.cfemails) {
    const decoded = decodeCloudflareEmail(cf);
    if (decoded) found.add(decoded);
  }

  for (const json of data.jsonLds) {
    try {
      const obj = JSON.parse(json);
      const traverse = (o) => {
        if (!o) return;
        if (typeof o === 'string') {
          const m = o.match(EMAIL_REGEX);
          if (m) for (const e of m) found.add(e.toLowerCase());
        } else if (Array.isArray(o)) {
          o.forEach(traverse);
        } else if (typeof o === 'object') {
          Object.values(o).forEach(traverse);
        }
      };
      traverse(obj);
    } catch { /* ignore invalid JSON-LD */ }
  }

  const blob = data.html + '\n' + data.innerText;
  const matches = blob.match(EMAIL_REGEX) || [];
  for (const m of matches) {
    const cleaned = m.toLowerCase();
    if (cleaned.length > 100) continue;
    if (/example\.com|sentry\.io|sentry-next\.|cloudflare/.test(cleaned)) continue;
    found.add(cleaned);
  }

  return [...found];
}

/**
 * Visite un site avec Playwright (rendu JS) et extrait le meilleur email
 * pour le dirigeant donné.
 *
 * @param {Object} input
 * @param {string} input.siteUrl
 * @param {string} [input.firstName]
 * @param {string} [input.lastName]
 * @param {string} [input.companyDomain]    Pour scoring email sur domain
 * @param {Object} [opts]
 * @param {Object} [opts.context]            Playwright BrowserContext (réutilisé)
 * @param {string[]} [opts.paths]            Override paths à visiter
 * @returns {Promise<{email, confidence, type, reason, allFound[], pagesVisited[]}>}
 */
async function extractBestEmail(input, opts = {}) {
  const { siteUrl, firstName, lastName, companyDomain } = input;
  if (!siteUrl) return { email: null, confidence: 0, allFound: [], pagesVisited: [] };

  const { context } = opts;
  if (!context) {
    throw new Error('extractBestEmail: opts.context (Playwright context) required');
  }

  const paths = opts.paths || PAGES_TO_VISIT;
  const baseUrl = siteUrl.replace(/\/+$/, '');
  const allEmails = new Set();
  const pagesVisited = [];
  const pagesFailed = [];

  // v8 optim : visite des pages en PARALLÈLE (au lieu de séquentiel).
  // Latence = max(pages lentes) au lieu de somme. Gain ÷5 à ÷10 sur sites
  // multi-pages.
  //
  // Early stop : si on trouve un email à confidence ≥ 0.85 (nominatif match
  // dirigeant) sur N'IMPORTE quelle page, on stoppe via AbortController et
  // on retourne sans attendre les autres pages.
  const earlyStop = { found: false, email: null, score: null };
  const abortController = new AbortController();

  async function visitPage(path) {
    if (abortController.signal.aborted) return;
    const url = baseUrl + path;
    let page;
    try {
      page = await context.newPage();
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT_MS,
      });
      if (abortController.signal.aborted) return;
      await page.waitForTimeout(POST_RENDER_WAIT_MS);
      if (abortController.signal.aborted) return;
      const emails = await extractEmailsFromPage(page);
      pagesVisited.push({ path, emails: emails.length });
      for (const e of emails) {
        allEmails.add(e);
        // Early stop : si on a un email nominatif match dirigeant, on le note
        // et on signale aux autres pages d'arrêter.
        if (!earlyStop.found && firstName && lastName) {
          const s = scoreEmail(e, firstName, lastName, companyDomain || baseUrl);
          if (s && s.confidence >= EARLY_STOP_CONFIDENCE) {
            earlyStop.found = true;
            earlyStop.email = e;
            earlyStop.score = s;
            abortController.abort();
          }
        }
      }
    } catch (err) {
      pagesFailed.push({ path, error: (err.message || '').slice(0, 60) });
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
    }
  }

  // Promise.allSettled : visite TOUTES les pages en parallèle. Si l'une
  // déclenche earlyStop, les autres reçoivent abortController.signal.aborted
  // et sortent rapidement.
  await Promise.allSettled(paths.map((p) => visitPage(p)));

  // Scoring : trier par confidence desc
  const scored = [];
  for (const email of allEmails) {
    const s = scoreEmail(email, firstName, lastName, companyDomain || baseUrl);
    if (s) scored.push({ email, ...s });
  }
  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0] || null;
  return {
    email: best ? best.email : null,
    confidence: best ? best.confidence : 0,
    type: best ? best.type : 'none',
    reason: best ? best.reason : 'no email found',
    allFound: scored,
    pagesVisited,
    pagesFailed,
  };
}

module.exports = {
  extractBestEmail,
  extractEmailsFromPage,
  scoreEmail,
  decodeCloudflareEmail,
  _constants: {
    PAGES_TO_VISIT,
    PAGE_TIMEOUT_MS,
    JUNK_LOCAL_PARTS,
    GENERIC_LOCAL_PARTS,
    SEMI_PERSONAL_LOCAL_PARTS,
    FREEMAIL_DOMAINS,
  },
};
