// ====== PRACUJ.PL — Puppeteer (n8n runCustomScript) ======
// Cloudflare-fronted. Cards: [data-test="default-offer"] / [data-test="offer"].
// Inside: [data-test="offer-title"], [data-test="text-company-name"],
//         [data-test="text-region"], a[href*=",oferta,"]. Pagination: &pn=N.
// URL built from cfg: keyword -> ;kw, location -> ;wp slug, radius -> rd (km),
//                     category -> tc (default 7 = staż/praktyki).
const fs = require('fs');
const path = require('path');

// --- 1. CONFIG (read from file; ignore $json) ---
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const keyword = (cfg.keyword != null ? String(cfg.keyword) : '').trim();
const category = (cfg.category != null && String(cfg.category).trim() !== '')
  ? String(cfg.category).trim()
  : '7'; // default: staż/praktyki (tc=7), proven working value
const radius = cfg.radius || 30;
const collectDir = cfg.collectDir;

// --- 2. Build URL from cfg (diacritic-stripped lowercase city slug) ---
const slugifyCity = (s) => (s || 'Wrocław')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ł/g, 'l').replace(/Ł/g, 'l')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const loc = slugifyCity(cfg.location);

// Assemble path + query strictly from cfg (nothing hardcoded).
let pathSegs = 'praca';
if (loc) pathSegs += '/' + loc + ';wp';
// tc=7 = Pracuj's "Praktyki / staż" contract code. The category WORD ('internship')
// is not a valid tc value — passing it wipes the filter and returns all jobs.
const query = [`rd=${radius}`, 'tc=7'].join('&');
const _ov = cfg.urls && cfg.urls.pracuj && String(cfg.urls.pracuj).trim();
const BASE = _ov || `https://www.pracuj.pl/${pathSegs}?${query}`;

// --- helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// Best-effort salary parser (never invents; omits when unclear)
const parseSalary = (txt) => {
  const out = {};
  if (!txt) return out;
  const t = txt.replace(/ /g, ' ');
  const cur = /z[łl]|pln/i.test(t) ? 'PLN'
    : /€|eur/i.test(t) ? 'EUR'
    : /\$|usd/i.test(t) ? 'USD' : null;
  const nums = (t.match(/\d[\d\s.]*\d|\d/g) || [])
    .map(n => parseInt(n.replace(/[\s.]/g, ''), 10))
    .filter(n => !isNaN(n) && n >= 10);
  if (cur) out.salary_currency = cur;
  if (nums.length >= 1) out.salary_from = nums[0];
  if (nums.length >= 2) out.salary_to = nums[1];
  return out;
};

const MAX_PAGES = 10;
const allOffers = [];
const seenUrls = new Set();
let blocked = false;

const BLOCK_SIGNALS = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];

const page = await $browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
await page.setViewport({ width: 1366, height: 900 });

// --- request interception: block heavy assets (proven) ---
await page.setRequestInterception(true);
page.on('request', (req) => {
  const type = req.resourceType();
  if (['image', 'font', 'media'].includes(type)) req.abort();
  else req.continue();
});

// --- 3. SAFETY: random delay BEFORE first navigation (2500–6000ms) ---
await sleep(rand(2500, 6000));

try {
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = p === 1 ? BASE : `${BASE}&pn=${p}`;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 50000 });
    } catch (e) {
      // navigation timeout: stop gently, do not hammer
      break;
    }
    await sleep(rand(1500, 3000));

    // --- 4. BLOCK DETECTION (URL redirect to challenge + body text) ---
    const curUrl = page.url();
    const pageText = await page.evaluate(() => (document.body ? document.body.innerText : '') || '');
    const lowered = pageText.toLowerCase();
    const challengeInUrl = /challenge|cf-chl|captcha|__cf|datadome/i.test(curUrl);
    if (challengeInUrl || BLOCK_SIGNALS.some(s => lowered.includes(s))) {
      blocked = true;
      break; // STOP immediately, no retry
    }

    // Cookie accept popup (proven)
    try {
      await page.click('[data-test="button-submitCookie"]');
      await sleep(rand(300, 700));
    } catch (e) {}

    // Scroll loop: capped at 10 iterations with stable-count early exit
    let lastCount = -1, stable = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await sleep(rand(300, 800));
      const c = await page.evaluate(() =>
        document.querySelectorAll('[data-test="default-offer"], [data-test="offer"]').length);
      if (c === lastCount) { stable++; if (stable >= 2) break; }
      else { stable = 0; lastCount = c; }
    }
    await sleep(rand(600, 1200));

    // --- Parse offers (proven selectors) ---
    const pageOffers = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-test="default-offer"], [data-test="offer"]'));
      if (cards.length === 0) {
        // Fallback: raw offer links
        const links = Array.from(document.querySelectorAll('a[href*=",oferta,"]'));
        return links.map(a => ({
          title: a.querySelector('h2') ? a.querySelector('h2').innerText.trim()
            : (a.innerText ? a.innerText.trim().substring(0, 100) : null),
          company: null, city: null, url: a.href,
          salaryText: null, labels: [], published_at: null
        })).filter(o => o.title);
      }
      return cards.map(card => {
        const titleEl = card.querySelector('[data-test="offer-title"], h2 a, h2');
        const title = titleEl ? titleEl.innerText.trim() : null;
        const companyEl = card.querySelector('[data-test="text-company-name"]');
        const company = companyEl ? companyEl.innerText.trim() : null;
        const regionEl = card.querySelector('[data-test="text-region"]');
        const city = regionEl ? regionEl.innerText.trim() : null;
        const salaryEl = card.querySelector('[data-test="offer-salary"]');
        const salaryText = salaryEl ? salaryEl.innerText.trim() : null;
        const labelNodes = card.querySelectorAll('li, [data-test^="offer-additional-info"]');
        const labels = Array.from(labelNodes)
          .map(el => el.innerText.trim())
          .filter(t => t.length > 0 && t.length < 60);
        const linkEl = card.querySelector('a[data-test="link-offer"], a[href*=",oferta,"]');
        const offerUrl = linkEl ? linkEl.href : null;
        // published_at: best-effort ISO from a datetime attribute; omit otherwise (never invent)
        const timeEl = card.querySelector('time[datetime]');
        const published_at = timeEl ? (timeEl.getAttribute('datetime') || null) : null;
        return { title, company, city, url: offerUrl, salaryText, labels, published_at };
      }).filter(o => o.title);
    });

    // --- 5. Map to COMMON shape (omit unknowns; never invent) ---
    for (const o of pageOffers) {
      if (!o.url || seenUrls.has(o.url)) continue;
      seenUrls.add(o.url);

      const offer = { source: 'pracuj', title: o.title, url: o.url };
      if (o.company) offer.company = o.company;
      if (o.city) offer.city = o.city;

      const sal = parseSalary(o.salaryText);
      Object.assign(offer, sal);

      const joined = (o.labels || []).join(' | ').toLowerCase();
      // remote: only set when clearly signalled
      if (/zdaln/.test(joined)) offer.remote = true;
      else if (/stacjonarn/.test(joined)) offer.remote = false;
      // contract_type: only when a known keyword label is present
      const ct = (o.labels || []).find(l => /umowa|kontrakt|b2b|zlecen|o prac|dzie[łl]o/i.test(l));
      if (ct) offer.contract_type = ct;
      // experience_level: only when a known keyword label is present
      const el = (o.labels || []).find(l => /junior|mid|senior|praktykant|sta[żz]|asystent|specjalista|ekspert|mened|kierownik|dyrektor/i.test(l));
      if (el) offer.experience_level = el;
      // published_at: only when the site exposes a real date (never invent)
      if (o.published_at) offer.published_at = o.published_at;

      allOffers.push(offer);
    }

    // Expected-but-empty on first page => treat as blocked
    if (p === 1 && pageOffers.length === 0) {
      blocked = true;
      break;
    }

    // Pagination: stop if no next page or nothing found
    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector('[data-test="top-pagination-next-page"], [data-test="bottom-pagination-next-page"]');
      return !!(btn && !btn.disabled);
    });
    if (pageOffers.length === 0 || !hasNext) break;

    // randomized inter-page delay
    await sleep(rand(3000, 6000));
  }
} catch (e) {
  // swallow unexpected errors; still write results below
}

// --- 6. Always write results ---
try { fs.mkdirSync(collectDir, { recursive: true }); } catch (e) {}
fs.writeFileSync(
  path.join(collectDir, 'pracuj.json'),
  JSON.stringify({ source: 'pracuj', count: allOffers.length, offers: allOffers })
);

// --- 7. Close + return status ---
await page.close();
return [{ json: { site: 'pracuj', count: allOffers.length, blocked } }];