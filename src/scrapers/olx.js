// ====== OLX.pl Praca — n8n Puppeteer (Browserless) — V3: full descriptions ======
// Adapted from the proven /tmp/old_scrapers/OLX.js:
//  - KEEP: card selectors, gradual scroll, page-until-empty pagination,
//    dedupe, cookie accept (#onetrust-accept-btn-handler).
//  - KEEP (contract): cfg-driven URL (keyword+category+location+radius),
//    random pre-nav delay, randomized inter-page/scroll delays, block
//    detection, common offer shape, write to collect file, return status.
//  - ADD (V3): detail phase after the list loop — for each uncached offer,
//    one page.evaluate -> fetch('https://www.olx.pl/api/v1/offers/{id}')
//    (same-origin, DataDome cookies ride along; verified live). Fills:
//    description (HTML stripped via DOMParser), company (user.name — was
//    always null before), contract_type / experience_level / salary from
//    params[] when null. Description cache keyed by nurl(url) in
//    cfg.descCache. Jittered 1500-3000ms between calls; abort-on-block;
//    per-offer error tolerance. Total detail failure still yields V2 output.
// DataDome is BEHAVIORAL — scroll gradually, delays are randomized, no retry hammering.

const fs = require('fs');
const path = require('path');

// --- 1. Config ---
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
// cfg = { keyword, category, location, radius, collectDir, descCache }

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
  const cleaned = String(raw).replace(/ /g, ' ');
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
        description: null,   // V3: filled by detail phase below
        _id: o.id || null,   // V3: numeric ad id for the detail API (temp, removed before write)
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

// --- 6. Detail phase (V3): descriptions via OLX JSON API ---
// GET https://www.olx.pl/api/v1/offers/{numeric-ad-id} -> {data:{description
// (full HTML), user.name (company), params[] (salary/agreement/type/experience)}}.
// Verified live. One page.evaluate per fetch (protocolTimeout-safe), all delays
// in Node context. Cache keyed by nurl(url) — matches Excel Writer's dedup key.
const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();

let details_fetched = 0, details_cached = 0, detail_errors = 0, detailAborted = false;

let descCache = {};
try {
  descCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  if (!descCache || typeof descCache !== 'object' || Array.isArray(descCache)) descCache = {};
} catch (e) { descCache = {}; }

const onOlx = /(^|\.)olx\.pl/i.test(page.url()) || page.url().includes('olx.pl');
if (!blocked && offers.length > 0 && onOlx) {
  try {
    let firstFetch = true;
    for (const offer of offers) {
      if (detailAborted) break;
      if (!offer.url) continue; // no url — no cache key, skip detail fetch

      // 6a. Cache hit -> reuse (only entries with a real description are cached)
      const key = nurl(offer.url);
      const hit = descCache[key];
      if (hit && hit.f && typeof hit.f.description === 'string' && hit.f.description) {
        Object.assign(offer, hit.f);
        details_cached++;
        continue;
      }

      // 6b. Need the numeric ad id from the list card
      const adId = (String(offer._id || '').match(/\d{6,}/) || [])[0];
      if (!adId) {
        offer.detail_error = 'no ad id on card';
        detail_errors++;
        continue;
      }

      // 6c. Jittered delay BETWEEN calls, in Node context (DataDome is behavioral)
      if (!firstFetch) await sleep(rand(1500, 3000));
      firstFetch = false;

      // 6d. One evaluate = one fetch (same-origin, cookies ride along)
      let det;
      try {
        det = await page.evaluate(async (apiUrl) => {
          const out = { ok: false, status: 0, description: null, company: null, params: [], snippet: '', error: null };
          try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 25000); // keep this evaluate well under 60s
            const r = await fetch(apiUrl, { headers: { Accept: 'application/json' }, credentials: 'include', signal: ctl.signal });
            clearTimeout(timer);
            out.status = r.status;
            const text = await r.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) {}
            if (!json || !json.data) {
              out.snippet = String(text || '').slice(0, 600); // for block-signal check node-side
              return out;
            }
            const d = json.data;
            if (d.description) {
              // Keep line breaks: <br>/<p>/<li> -> \n before DOMParser strips tags
              const html = String(d.description)
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|li|div|h[1-6]|ul|ol|tr)>/gi, '\n')
                .replace(/<li[^>]*>/gi, '- ');
              try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                out.description = doc.body ? (doc.body.textContent || '') : '';
              } catch (e) {
                out.description = html.replace(/<[^>]*>/g, ' ');
              }
            }
            out.company = d.user && d.user.name ? String(d.user.name).trim() : null;
            if (Array.isArray(d.params)) {
              out.params = d.params.map((p) => ({
                key: p && p.key ? String(p.key) : null,
                label: p && p.value && p.value.label != null ? String(p.value.label) : null,
                from: p && p.value && p.value.from != null ? p.value.from : null,
                to: p && p.value && p.value.to != null ? p.value.to : null,
                currency: p && p.value && p.value.currency ? String(p.value.currency) : null,
              }));
            }
            out.ok = true;
            return out;
          } catch (e) {
            out.error = e && e.message ? e.message : String(e);
            return out;
          }
        }, 'https://www.olx.pl/api/v1/offers/' + adId);
      } catch (e) {
        offer.detail_error = 'evaluate failed: ' + (e && e.message ? e.message : e);
        detail_errors++;
        continue;
      }

      // 6e. Block handling: 403/429 or challenge text -> STOP, keep everything so far
      const snippetLower = String((det && det.snippet) || '').toLowerCase();
      if (det && (det.status === 403 || det.status === 429 || BLOCK_SIGNALS.some((s) => snippetLower.includes(s)))) {
        detailAborted = true;
        console.log('OLX detail: block signal (HTTP ' + det.status + ') on ad ' + adId + ' — aborting detail phase, keeping list data.');
        break;
      }

      // 6f. Per-offer failure (non-block) -> tag & continue
      if (!det || !det.ok) {
        offer.detail_error = 'HTTP ' + (det ? det.status : '?') + (det && det.error ? ' / ' + det.error : '');
        detail_errors++;
        continue;
      }

      // 6g. Build the fields object (goes onto the offer AND into the cache)
      const fields = {};
      let desc = det.description != null ? String(det.description) : '';
      desc = desc.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 15000);
      fields.description = desc || null;

      if (det.company) fields.company = det.company; // FIXES the always-null company

      const byKey = {};
      for (const pp of (det.params || [])) { if (pp && pp.key && !(pp.key in byKey)) byKey[pp.key] = pp; }
      const agreement = byKey['agreement'] || byKey['type'];
      if (agreement && agreement.label) fields.contract_type = agreement.label;
      if (byKey['experience'] && byKey['experience'].label) fields.experience_level = byKey['experience'].label;
      // Salary from API only when the list card had none
      if (offer.salary_from == null && byKey['salary']) {
        const s = byKey['salary'];
        if (s.from != null) fields.salary_from = s.from;
        if (s.to != null) fields.salary_to = s.to;
        if (s.currency) fields.salary_currency = s.currency;
      }

      // Assign to offer — fill only fields that are currently null (never clobber list data)
      for (const k of Object.keys(fields)) {
        if (fields[k] != null && offer[k] == null) offer[k] = fields[k];
      }
      details_fetched++;

      // Cache ONLY entries with a non-empty description (never cache failures)
      if (typeof fields.description === 'string' && fields.description) {
        descCache[key] = { t: Date.now(), f: fields };
      }
    }
  } catch (err) {
    // Total detail-phase failure must still produce V2-equivalent output
    console.log('OLX detail: unexpected error — ' + (err && err.message ? err.message : err));
  }

  // 6h. Write cache once, best-effort
  try {
    try { fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true }); } catch (e) {}
    fs.writeFileSync(CACHE_PATH, JSON.stringify(descCache));
  } catch (e) {}

  console.log('OLX detail: fetched ' + details_fetched + ', cached ' + details_cached +
    ', errors ' + detail_errors + (detailAborted ? ', ABORTED on block' : '') + '.');
} else if (!blocked && offers.length > 0) {
  console.log('OLX detail: page is not on olx.pl (nav failed?) — skipping detail phase.');
}

// Drop the temp _id before writing (cache is keyed by url; collect shape stays clean)
for (const o of offers) delete o._id;

// --- 7. Always write results (even when empty/blocked) ---
try { fs.mkdirSync(cfg.collectDir, { recursive: true }); } catch (e) {}
fs.writeFileSync(
  path.join(cfg.collectDir, 'olx.json'),
  JSON.stringify({ source: 'olx', count: offers.length, offers })
);

// --- 8. Close + return status ---
await page.close();
return [{ json: { site: 'olx', count: offers.length, blocked, details_fetched, details_cached, detail_errors, detailAborted } }];
