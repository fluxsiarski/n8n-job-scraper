// ====== OLX.pl Praca — n8n Puppeteer (Browserless) ======
// Adapted from the proven /tmp/old_scrapers/OLX.js:
//  - KEEP: card selectors, gradual scroll, page-until-empty pagination,
//    dedupe, cookie accept (#onetrust-accept-btn-handler).
//  - ADD (contract): cfg-driven URL (keyword+category+location+radius),
//    random pre-nav delay, randomized inter-page/scroll delays, block
//    detection, common offer shape, write to collect file, return status.
// DataDome is BEHAVIORAL — scroll gradually, delays are randomized, no retry hammering.

const fs = require('fs');
const path = require('path');

// --- 1. Config ---
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
// cfg = { keyword, category, location, radius, collectDir }

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Slugify for URL path segments: strip diacritics (incl. ł), lowercase,
// collapse non-alphanumerics to '-'. 'Wrocław' -> 'wroclaw', 'Łódź' -> 'lodz'.
function slugify(s, fallback) {
  const v = (s == null ? '' : String(s)).trim();
  if (!v) return fallback || '';
  return v
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Parse an OLX price string into { salary_from, salary_to, salary_currency }.
// Never invents data: returns {} when no numbers are present.
function parseSalary(raw) {
  const out = {};
  if (!raw) return out;
  const cleaned = String(raw).replace(/ /g, ' ');
  let currency;
  if (/zł|pln/i.test(cleaned)) currency = 'PLN';
  else if (/eur|€/i.test(cleaned)) currency = 'EUR';
  // remove spaces used as thousand separators ("4 000" -> "4000"), then grab numbers
  const nums = (cleaned.replace(/\s(?=\d)/g, '').match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => parseFloat(n.replace(',', '.')))
    .filter((n) => !isNaN(n));
  if (nums.length === 0) return out;
  out.salary_from = nums[0];
  if (nums.length > 1) out.salary_to = nums[1];
  if (currency) out.salary_currency = currency;
  return out;
}

const loc = slugify(cfg.location, 'wroclaw');
const radius = cfg.radius != null ? cfg.radius : 30;

// OLX filters live in the QUERY STRING, not the path. The internship/staż filter
// is search[filter_enum_agreement][0]=practice ; radius is search[dist]. City is a
// path segment. (Putting category/keyword in the PATH 404s or wipes the filter —
// that was the old bug that returned 0 results.)
// Paste-URL override: if you pasted a filtered OLX URL in Config, use it verbatim.
const _ov = cfg.urls && cfg.urls.olx && String(cfg.urls.olx).trim();
const BASE = _ov || `https://www.olx.pl/praca/${loc}/?search%5Bdist%5D=${radius}&search%5Bfilter_enum_agreement%5D%5B0%5D=practice`;

const MAX_PAGES = 10; // capped per contract
const CARD_SELECTOR = '[data-testid="l-card"], [data-cy="l-card"]';
const BLOCK_SIGNALS = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];

const offers = [];
const seenKeys = new Set();
let blocked = false;

const page = await $browser.newPage();

// --- 3. Safety: realistic desktop Chrome UA + viewport, random pre-nav delay ---
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.setViewport({ width: 1366, height: 900 });
await sleep(rand(2500, 6000)); // mandatory random delay before first navigation

try {
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = p === 1 ? BASE : `${BASE}&page=${p}`;

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 50000 });
    } catch (e) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e2) {
        break; // navigation failed twice — stop gently
      }
    }

    await sleep(rand(2000, 3500));

    // --- 4. Block detection (URL redirect / challenge text) ---
    const curUrl = page.url();
    let bodyText = '';
    try {
      bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    } catch (e) { bodyText = ''; }
    const haystack = (curUrl + ' ' + bodyText).toLowerCase();
    if (BLOCK_SIGNALS.some((s) => haystack.includes(s))) {
      blocked = true;
      console.log('OLX: block/challenge detected on page ' + p + ' — stopping.');
      break;
    }

    // Cookie accept (first page only)
    if (p === 1) {
      try { await page.click('#onetrust-accept-btn-handler'); await sleep(rand(700, 1300)); } catch (e) {}
    }

    // --- Gradual scroll (DataDome-friendly) with stable-count early exit ---
    let lastCount = -1, stable = 0;
    for (let s = 0; s < 12; s++) {
      const step = rand(500, 800);
      await page.evaluate((y) => window.scrollBy(0, y), step);
      await sleep(rand(250, 550));
      let cnt = 0;
      try {
        cnt = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
      } catch (e) { cnt = lastCount; }
      if (cnt === lastCount) {
        stable++;
        if (stable >= 3) break; // count stopped growing — done loading this page
      } else {
        stable = 0;
        lastCount = cnt;
      }
    }
    await sleep(rand(800, 1600));

    // --- Parse offers (proven selectors) ---
    const pageOffers = await page.evaluate((sel) => {
      const cards = Array.from(document.querySelectorAll(sel));
      return cards.map((card) => {
        const id = card.getAttribute('id');
        const titleEl = card.querySelector('h4, h6, h3, h2');
        const title = titleEl ? titleEl.innerText.trim() : null;
        if (!title) return null;

        const linkEl = card.querySelector('a[href*="/oferta/"]');
        let href = linkEl ? (linkEl.getAttribute('href') || '') : null;
        if (href && href.startsWith('/')) href = 'https://www.olx.pl' + href;

        const locEl = card.querySelector('[data-testid="location-date"]');
        const locRaw = locEl ? locEl.innerText.trim() : null;
        const city = locRaw ? locRaw.split(' - ')[0].trim() : null;
        const dateText = locRaw && locRaw.includes(' - ')
          ? locRaw.split(' - ').slice(1).join(' - ').trim()
          : null;

        const priceEl = card.querySelector('[data-testid="ad-price"]');
        const salaryRaw = priceEl ? priceEl.innerText.trim() : null;

        return { id, title, url: href, city, dateText, salaryRaw };
      }).filter((o) => o !== null);
    }, CARD_SELECTOR);

    // --- 4b. 0 offers -> end of pagination / genuine no-results ---
    // (Real blocks are caught by BLOCK_SIGNALS above. OLX loads fine headless, so
    //  0 cards just means no more results — do NOT treat it as a block.)
    if (pageOffers.length === 0) {
      console.log('OLX page ' + p + ': 0 offers — end of results.');
      break;
    }

    // --- 5. Map to common shape + dedupe ---
    let added = 0;
    for (const o of pageOffers) {
      const key = o.id || o.url || o.title;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);

      const sal = parseSalary(o.salaryRaw);
      const remote = /zdaln|remote/i.test((o.title || '') + ' ' + (o.city || ''));

      offers.push({
        source: 'olx',
        company: null,
        title: o.title,
        url: o.url || null,
        city: o.city || null,
        salary_from: sal.salary_from != null ? sal.salary_from : null,
        salary_to: sal.salary_to != null ? sal.salary_to : null,
        salary_currency: sal.salary_currency || null,
        contract_type: null,
        experience_level: null,
        published_at: o.dateText || null,
        remote: remote,
      });
      added++;
    }

    console.log('OLX page ' + p + ': ' + pageOffers.length + ' cards, ' + added + ' new (total ' + offers.length + ').');

    // same-page all-duplicates -> end
    if (added === 0 && p > 1) break;

    await sleep(rand(3500, 6500)); // randomized inter-page delay
  }
} catch (err) {
  console.log('OLX: unexpected error — ' + (err && err.message ? err.message : err));
}

// --- 6. Always write results (even when empty/blocked) ---
try { fs.mkdirSync(cfg.collectDir, { recursive: true }); } catch (e) {}
fs.writeFileSync(
  path.join(cfg.collectDir, 'olx.json'),
  JSON.stringify({ source: 'olx', count: offers.length, offers })
);

// --- 7. Close + return status ---
await page.close();
return [{ json: { site: 'olx', count: offers.length, blocked } }];