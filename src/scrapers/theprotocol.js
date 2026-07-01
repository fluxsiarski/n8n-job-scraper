// theprotocol.it scraper — n8n Puppeteer (runCustomScript) node
// Grupa Pracuj IT-only board. HIGH block risk: Cloudflare MANAGED CHALLENGE
// (cf-mitigated: challenge). A real browser MAY pass; gentle behavior only.

const fs = require('fs');

// ---- 1. Read config ---------------------------------------------------------
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
// cfg = { keyword, category, location, radius, collectDir }

// ---- helpers ----------------------------------------------------------------
const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// diacritic-stripped, lowercase slug ('Wrocław' -> 'wroclaw')
// note: combining marks (U+0300–U+036F) are stripped after NFD; 'ł' does NOT
// decompose under NFD, so map it explicitly.
const deaccent = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .trim()
    .toLowerCase();

// turn any text into a url-safe lowercase slug
const slugify = (s) =>
  deaccent(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// parse a Polish salary string into from/to/currency (NEVER invents values)
function parseSalary(raw) {
  const res = {};
  if (!raw) return res;
  const s = String(raw).replace(/[\s   ]/g, ' ');
  if (/zł|pln/i.test(s)) res.salary_currency = 'PLN';
  else if (/€|eur/i.test(s)) res.salary_currency = 'EUR';
  else if (/\$|usd/i.test(s)) res.salary_currency = 'USD';
  const nums = (s.match(/\d[\d ]*\d|\d/g) || [])
    .map((x) => parseInt(x.replace(/ /g, ''), 10))
    .filter((n) => !isNaN(n));
  if (nums.length >= 2) {
    res.salary_from = nums[0];
    res.salary_to = nums[1];
  } else if (nums.length === 1) {
    res.salary_from = nums[0];
  }
  return res;
}

// ---- 2. Build URL (all search params come from cfg — nothing hardcoded) -----
// theProtocol.it path filters: '<slug>;kw' (keyword) and '<city>;wp'
// (workplace). Category (specialization) + radius + pagination go in the query
// string; unknown query keys are ignored by the site, so this cannot 404.
const loc = deaccent(cfg.location || 'Wrocław') || 'wroclaw';

// Internships/traineeships use theProtocol's CONTRACT-TYPE filter segment
// 'umowa-o-staz-praktyki;c' (recon-verified). Location via ';wp'. Without this the
// site returns ALL offers (previously produced 253 unfiltered results).
const filterParts = ['umowa-o-staz-praktyki;c', loc + ';wp'];
const _ov = cfg.urls && cfg.urls.theprotocol && String(cfg.urls.theprotocol).trim();
const BASE = _ov || ('https://theprotocol.it/filtry/' + filterParts.join('/'));

const pageUrl = (n) => (n > 1) ? BASE + (BASE.includes('?') ? '&' : '?') + 'pageNumber=' + n : BASE;

const MAX_PAGES = 5; // gentle cap (contract allows <= 10)
const CHALLENGE_MARKERS = [
  'captcha',
  'just a moment',
  'cf-chl',
  'datadome',
  'access denied',
  'attention required',
];

// scroll the listing to trigger lazy-loaded cards, with stable-count early exit
async function autoScroll(pg) {
  try {
    await pg.evaluate(async () => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const count = () =>
        document.querySelectorAll(
          '[data-test="list-item-offer"], a[href*="/szczegoly/"]'
        ).length;
      let last = -1;
      let stable = 0;
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, document.body.scrollHeight);
        await nap(600 + Math.random() * 1100); // randomized scroll delay
        const c = count();
        if (c === last) {
          stable++;
          if (stable >= 2) break;
        } else {
          stable = 0;
          last = c;
        }
      }
    });
  } catch (e) {}
}

// extract raw offer data from the current listing DOM
async function extractRaw(pg) {
  return pg.evaluate(() => {
    const abs = (h) => {
      try {
        return h ? new URL(h, 'https://theprotocol.it').href : null;
      } catch (e) {
        return null;
      }
    };
    const pick = (card, keys) => {
      for (const k of keys) {
        const n = card.querySelector('[data-test="' + k + '"]');
        if (n && n.textContent.trim()) return n.textContent.trim();
      }
      return null;
    };
    const pickLike = (card, sub) => {
      const nodes = card.querySelectorAll('[data-test]');
      for (const n of nodes) {
        const dt = (n.getAttribute('data-test') || '').toLowerCase();
        if (dt.includes(sub) && n.textContent.trim()) return n.textContent.trim();
      }
      return null;
    };

    // determine offer cards (prefer explicit card, fall back to detail anchors)
    let cards = Array.from(
      document.querySelectorAll('[data-test="list-item-offer"]')
    );
    if (!cards.length) {
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/szczegoly/"]')
      );
      const seen = new Set();
      cards = [];
      for (const a of anchors) {
        const c =
          a.closest('li') ||
          a.closest('article') ||
          a.closest('[data-test]') ||
          a.parentElement ||
          a;
        if (!seen.has(c)) {
          seen.add(c);
          cards.push(c);
        }
      }
    }

    const out = [];
    for (const card of cards) {
      const link =
        card.matches && card.matches('a[href*="/szczegoly/"]')
          ? card
          : card.querySelector('a[href*="/szczegoly/"]');
      const href = link ? abs(link.getAttribute('href')) : null;
      if (!href) continue;

      let title =
        pick(card, ['text-jobTitle', 'offer-title', 'text-offerTitle']) ||
        pickLike(card, 'jobtitle') ||
        pickLike(card, 'title');
      if (!title && link) {
        title =
          (link.getAttribute('aria-label') || '').trim() ||
          (link.getAttribute('title') || '').trim() ||
          null;
      }
      if (!title) {
        const h = card.querySelector('h1,h2,h3');
        if (h && h.textContent.trim()) title = h.textContent.trim();
      }

      const company =
        pick(card, ['text-employerName', 'text-companyName']) ||
        pickLike(card, 'employer') ||
        pickLike(card, 'companyname');

      const cityRaw =
        pick(card, ['text-workplaces', 'text-workplace', 'text-regions']) ||
        pickLike(card, 'workplace') ||
        pickLike(card, 'region') ||
        pickLike(card, 'location');

      const salaryRaw =
        pick(card, ['text-salaryOnListing', 'text-salary']) ||
        pickLike(card, 'salary');

      const levelRaw =
        pickLike(card, 'positionlevel') || pickLike(card, 'level');
      const workModeRaw =
        pickLike(card, 'workmode') || pickLike(card, 'worktype');
      const contractRaw =
        pickLike(card, 'typeofcontract') ||
        pickLike(card, 'contracttype') ||
        pickLike(card, 'contract');

      let dateRaw = null;
      const timeEl = card.querySelector('time[datetime], time');
      if (timeEl) {
        dateRaw =
          (timeEl.getAttribute('datetime') || '').trim() ||
          timeEl.textContent.trim() ||
          null;
      }
      if (!dateRaw) {
        dateRaw =
          pickLike(card, 'publicationdate') ||
          pickLike(card, 'publish') ||
          pickLike(card, 'date');
      }

      out.push({
        href: href,
        title: title || null,
        company: company || null,
        cityRaw: cityRaw || null,
        salaryRaw: salaryRaw || null,
        levelRaw: levelRaw || null,
        workModeRaw: workModeRaw || null,
        contractRaw: contractRaw || null,
        dateRaw: dateRaw || null,
      });
    }
    return out;
  });
}

// build the COMMON-shape offer (drops empty fields; never invents data)
function buildOffer(r) {
  const o = { source: 'theprotocol' };
  if (r.company) o.company = r.company;
  if (r.title) o.title = r.title;
  o.url = r.href; // absolute link (required)
  if (r.cityRaw) {
    o.city = r.cityRaw.split(/[,\n]/)[0].trim() || r.cityRaw.trim();
  }
  const sal = parseSalary(r.salaryRaw);
  if (sal.salary_from != null) o.salary_from = sal.salary_from;
  if (sal.salary_to != null) o.salary_to = sal.salary_to;
  if (sal.salary_currency) o.salary_currency = sal.salary_currency;
  if (r.contractRaw) o.contract_type = r.contractRaw;
  if (r.levelRaw) o.experience_level = r.levelRaw;
  if (r.dateRaw) {
    const d = new Date(r.dateRaw);
    o.published_at = isNaN(d.getTime()) ? r.dateRaw : d.toISOString();
  }
  const wm = ((r.workModeRaw || '') + ' ' + (r.cityRaw || '')).toLowerCase();
  if (/zdaln|remote/.test(wm)) o.remote = true; // only when clearly stated
  return o;
}

// ---- 3. Page setup + SAFETY / 4-5. Crawl pages ------------------------------
let blocked = false;
const offers = [];
const seenUrls = new Set();
let page = null;

try {
  page = await $browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
    });
  } catch (e) {}

  // random human-like delay BEFORE first navigation
  await sleep(rnd(2500, 6000));

  for (let p = 1; p <= MAX_PAGES; p++) {
    let resp = null;
    try {
      resp = await page.goto(pageUrl(p), {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
    } catch (e) {
      // navigation timeout — fall through to block/content checks below
    }

    // --- BLOCK DETECTION (mandatory) ---
    let headers = {};
    try {
      headers = resp ? resp.headers() : {};
    } catch (e) {}
    const cfMit = headers['cf-mitigated'] || headers['Cf-Mitigated'] || '';
    const curUrl = page.url();
    let bodyText = '';
    try {
      bodyText = await page.evaluate(() =>
        document.body ? document.body.innerText : ''
      );
    } catch (e) {}
    const low = (bodyText || '').toLowerCase();
    const challenged =
      String(cfMit).toLowerCase().includes('challenge') ||
      /challenge|cdn-cgi\/challenge/i.test(curUrl) ||
      CHALLENGE_MARKERS.some((m) => low.includes(m));
    if (challenged) {
      blocked = true;
      break; // STOP immediately — no retry hammering
    }

    // load lazy cards, then extract
    await autoScroll(page);
    let raw = [];
    try {
      raw = await extractRaw(page);
    } catch (e) {
      raw = [];
    }

    let newCount = 0;
    for (const r of raw) {
      if (!r.href || seenUrls.has(r.href)) continue;
      seenUrls.add(r.href);
      offers.push(buildOffer(r));
      newCount++;
    }

    // early exit when a page adds nothing new (or pagination collapsed)
    if (newCount === 0) break;

    // gentle randomized delay before next page
    if (p < MAX_PAGES) await sleep(rnd(3000, 7000));
  }

  // 0 offers where some were expected => treat as blocked (per contract)
  if (!blocked && offers.length === 0) blocked = true;
} catch (e) {
  // unexpected failure — still write results below; mark blocked if we got none
  if (offers.length === 0) blocked = true;
}

// ---- 6. Write results (ALWAYS, even if empty/blocked) -----------------------
try {
  fs.writeFileSync(
    cfg.collectDir + '/theprotocol.json',
    JSON.stringify({ source: 'theprotocol', count: offers.length, offers })
  );
} catch (e) {}

// ---- 7. Return --------------------------------------------------------------
try {
  if (page) await page.close();
} catch (e) {}

return [{ json: { site: 'theprotocol', count: offers.length, blocked: blocked } }];