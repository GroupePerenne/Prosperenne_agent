'use strict';

/**
 * Probe extraction emails via Playwright (rendu JS) sur les 7 sites trouvés
 * en v6.1 du probe AirWorker. Mesure le potentiel d'extraction directe
 * d'email gérant depuis le HTML rendu (pages mentions-légales typiquement).
 *
 * Approche locale pure :
 *   - Playwright Chromium local (ton IP résidentielle)
 *   - Pas d'appel API externe
 *   - Parse DOM final post-render JS
 *   - Decloak Cloudflare email obfuscation
 *   - Parse mailto: + JSON-LD + data-cfemail
 *
 * Hypothèse : sur les sites où SMTP probe est inopérant (Hornetsecurity, etc.),
 * l'email du gérant est souvent EN DUR dans le HTML mentions-légales mais
 * notre scrape HTTP statique le rate (Cloudflare obfuscation, JS-only render).
 */

const { chromium } = require('playwright');

// 7 sites trouvés en probe v6.1 + 1 candidate Morgane Lead 1 (perene27.com)
const SITES = [
  { name: 'Etablissements LEVEZIER', site: 'https://perene27.com', dirigeant: 'Laurent LEVEZIER' },
  { name: 'SOCIETE DE POSE NORMANDE', site: 'https://societe-de-pose-normande.fr', dirigeant: 'Benjamin BASSET' },
  { name: 'NORMANDIE DERATISATION', site: 'https://normandie-deratisation.com', dirigeant: 'Bernard DORCHIES' },
  { name: 'ETABLISSEMENTS BROKA', site: 'https://broka.fr', dirigeant: 'Gerard BROKA' },
  { name: 'MOREL SA', site: 'https://morelsas01.fr', dirigeant: 'Thierry POMPANON' },
  { name: 'ACECAM', site: 'https://acecam.fr', dirigeant: 'Christian CROSAZ-BLANC' },
  { name: 'SARL LANCIA', site: 'https://plomberie-chauffage-lancia.fr', dirigeant: 'Christiane LANCIA' },
  { name: 'SETEAM', site: 'https://seteam-electricite.fr', dirigeant: 'Eric PERRET' },
];

const PAGES_TO_VISIT = ['/mentions-legales', '/mentions', '/legal', '/contact', '/'];
const PAGE_TIMEOUT_MS = 12000;

const EMAIL_REGEX = /[A-Za-z0-9]([A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9]([A-Za-z0-9.-]{0,62}[A-Za-z0-9])?\.[A-Za-z]{2,}/g;

function decodeCloudflareEmail(cfemail) {
  if (!cfemail || typeof cfemail !== 'string') return null;
  const hex = cfemail.replace(/\s/g, '');
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let email = '';
  for (let i = 2; i < hex.length; i += 2) {
    const charCode = parseInt(hex.slice(i, i + 2), 16) ^ key;
    email += String.fromCharCode(charCode);
  }
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return null;
  return email.toLowerCase();
}

async function extractEmailsFromPage(page) {
  // Récupère HTML rendu + JSON-LD + cfemails + mailtos
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

  // 1. mailto:
  for (const m of data.mailtos) {
    const cleaned = String(m).trim().toLowerCase();
    if (/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(cleaned)) {
      found.add(`mailto:${cleaned}`);
    }
  }

  // 2. Cloudflare decloak
  for (const cf of data.cfemails) {
    const decoded = decodeCloudflareEmail(cf);
    if (decoded) found.add(`cfemail:${decoded}`);
  }

  // 3. JSON-LD parser
  for (const json of data.jsonLds) {
    try {
      const obj = JSON.parse(json);
      const traverse = (o) => {
        if (!o) return;
        if (typeof o === 'string' && /[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+/.test(o)) {
          const m = o.match(/[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
          if (m) found.add(`jsonld:${m[0].toLowerCase()}`);
        }
        if (Array.isArray(o)) o.forEach(traverse);
        else if (typeof o === 'object') Object.values(o).forEach(traverse);
      };
      traverse(obj);
    } catch { /* invalid JSON-LD */ }
  }

  // 4. Regex sur HTML brut + innerText
  const blob = data.html + '\n' + data.innerText;
  const matches = blob.match(EMAIL_REGEX) || [];
  for (const m of matches) {
    const cleaned = m.toLowerCase();
    // Skip emails dans data-cfemail (déjà décodés)
    if (cleaned.length > 100) continue;
    // Skip emails de tracking / placeholders typiques
    if (/example\.com|sentry\.io|google|facebook|cloudflare/.test(cleaned)) continue;
    found.add(`regex:${cleaned}`);
  }

  return [...found];
}

async function probeSite(site, dirigeant, browser) {
  console.log(`\n=== ${site} (${dirigeant})`);
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'fr-FR',
  });

  const allEmails = new Set();
  for (const path of PAGES_TO_VISIT) {
    const url = site.replace(/\/$/, '') + path;
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      // Wait extra pour JS-only emails
      await page.waitForTimeout(1500);
      const emails = await extractEmailsFromPage(page);
      if (emails.length > 0) {
        console.log(`  ${path}: ${emails.length} emails`);
        emails.forEach((e) => {
          console.log(`    - ${e}`);
          allEmails.add(e);
        });
      } else {
        console.log(`  ${path}: 0 emails`);
      }
    } catch (err) {
      console.log(`  ${path}: ERROR ${err.message.slice(0, 60)}`);
    } finally {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  // Score proximité dirigeant
  const dirigeantTokens = dirigeant.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const matches = [...allEmails].filter((e) => {
    const local = e.split(':')[1].split('@')[0];
    return dirigeantTokens.some((t) => local.includes(t.replace(/[^a-z]/g, '')));
  });
  if (matches.length > 0) {
    console.log(`  → MATCH dirigeant : ${matches.join(', ')}`);
  }

  await ctx.close();
  return { site, dirigeant, totalEmails: allEmails.size, dirigeantMatches: matches };
}

async function main() {
  console.log('Probe extraction emails Playwright + decloak (rendu JS local)');
  console.log(`Date: ${new Date().toISOString()}`);

  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const s of SITES) {
    const r = await probeSite(s.site, s.dirigeant, browser);
    results.push(r);
  }
  await browser.close();

  console.log('\n=== RÉSUMÉ ===');
  let totalEmails = 0;
  let matchDirigeant = 0;
  for (const r of results) {
    totalEmails += r.totalEmails;
    if (r.dirigeantMatches.length > 0) matchDirigeant++;
    console.log(`${r.site.padEnd(50)} | ${r.totalEmails} emails | dirigeant match: ${r.dirigeantMatches.length > 0 ? 'OUI' : 'non'}`);
  }
  console.log(`\nTotal sites: ${results.length}, total emails extraits: ${totalEmails}, sites avec match dirigeant: ${matchDirigeant}/${results.length} (${Math.round(matchDirigeant / results.length * 100)}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
