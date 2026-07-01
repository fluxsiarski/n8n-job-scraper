// ===== Indeed Poland scraper (sitekey: 'indeed') =====
// Aggregator with VERY HIGH block risk (Cloudflare + Turnstile/captcha, frequent 403).
// Strategy: be extremely gentle. Long random delays, 1-2 result pages MAX,
// detect any challenge/captcha/403 -> set blocked=true and STOP immediately (no retries).

const fs = require('fs');

// --- 1. Read shared config (IGNORE $json, always read the file) ---
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
// cfg = { keyword, category, location, radius, collectDir }

// --- small helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// --- 2. Build this site's URL ---
// Indeed uses a free-text `l` (location) param, NOT a city slug, so we URL-encode
// the location as-is ("Wrocław" -> "Wroc%C5%82aw"), plus free-text q + radius (km).
const keyword = cfg.keyword || cfg.category || '';
const location = cfg.location || '';
const radius = cfg.radius || 25;
const _ov = cfg.urls && cfg.urls.indeed && String(cfg.urls.indeed).trim();
const baseUrl = _ov ||
  ('https://pl.indeed.com/jobs?q=' +
  encodeURIComponent(keyword) +
  '&l=' +
  encodeURIComponent(location) +
  '&radius=' +
  encodeURIComponent(radius));

// challenge / block markers (contract list + site-specific Cloudflare/Turnstile)
const BLOCK_MARKERS = [
  'captcha',
  'Just a moment',
  'cf-chl',
  'datadome',
  'Access Denied',
  'Attention Required',
  'Cloudflare',
  'Verifying you are human',
  'Verify you are human',
  'unusual traffic',
];

// salary text parser (Polish formatting: "5 000 zł – 7 000 zł", "od 6000 zł", "do 8 000 PLN")
function parseSalary(text) {
  if (!text) return {};
  const t = text.replace(/[  ]/g, ' '); // normalize (narrow) no-break spaces
  if (!/(zł|pln)/i.test(t)) return {}; // only parse when a currency is present
  const tokens = t.match(/\d[\d .]*\d|\d+/g) || [];
  const nums = tokens
    .map((m) => parseInt(m.replace(/[ .]/g, ''), 10))
    .filter((n) => !isNaN(n) && n >= 100); // drop tiny counts (e.g. "1", "40 godz.")
  let from, to;
  if (nums.length >= 2) {
    from = nums[0];
    to = nums[1];
  } else if (nums.length === 1) {
    if (/\bdo\b/i.test(t) && !/\bod\b/i.test(t)) to = nums[0];
    else from = nums[0];
  }
  const out = {};
  if (from != null) out.salary_from = from;
  if (to != null) out.salary_to = to;
  if (from != null || to != null) out.salary_currency = 'PLN';
  return out;
}

// best-effort contract type (from metadata pills / card text; null when unknown)
function parseContractType(s) {
  if (!s) return null;
  if (/umowa o prac/i.test(s)) return 'umowa o pracę';
  if (/\bb2b\b|kontrakt b2b/i.test(s)) return 'B2B';
  if (/umowa zlecen/i.test(s)) return 'umowa zlecenie';
  if (/umowa o dzieł/i.test(s)) return 'umowa o dzieło';
  if (/kontrakt/i.test(s)) return 'kontrakt';
  if (/\bstaż\b|praktyk/i.test(s)) return 'staż';
  return null;
}

// best-effort experience / seniority (from title / card text; null when unknown)
function parseExperience(s) {
  if (!s) return null;
  if (/\bsenior\b|starszy/i.test(s)) return 'senior';
  if (/\blead\b|team lead|kierownik|menedżer|\bmanager\b/i.test(s)) return 'lead';
  if (/\bmid\b|\bregular\b/i.test(s)) return 'mid';
  if (/\bjunior\b|młodszy/i.test(s)) return 'junior';
  if (/\bintern\b|praktykant|\bstaż\b|praktyk/i.test(s)) return 'intern';
  return null;
}

let offers = [];
let blocked = false;
const seen = new Set();

const page = await $browser.newPage();

try {
  // --- 3. SAFETY setup ---
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  // mandatory random delay BEFORE first navigation (2500-6000 ms)
  await sleep(rand(2500, 6000));

  const MAX_PAGES = 2; // site is fragile: 1-2 result pages MAX

  for (let p = 0; p < MAX_PAGES; p++) {
    const pageUrl = baseUrl + '&start=' + p * 10;

    // long, gentle randomized delay between page loads (8-20s), not before the very first
    if (p > 0) await sleep(rand(8000, 20000));

    let response = null;
    try {
      response = await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (e) {
      // navigation failed/timeout -> treat as blocked, do NOT retry-hammer
      blocked = true;
      break;
    }

    // --- 4. BLOCK DETECTION ---
    const status = response ? response.status() : 0;
    if (status === 403 || status === 429 || status === 503) {
      blocked = true;
      break;
    }

    const finalUrl = page.url();
    if (/challenge|cf-chl|captcha|geo-blocked|blocked/i.test(finalUrl)) {
      blocked = true;
      break;
    }

    // let any lazy content settle a touch, then scan the DOM
    await sleep(rand(1500, 3500));
    await page
      .waitForSelector(
        '#mosaic-provider-jobcards, div.job_seen_beacon, a[data-jk]',
        { timeout: 15000 }
      )
      .catch(() => {});

    const pageInfo = await page.evaluate(() => ({
      title: document.title || '',
      text: document.body ? document.body.innerText : '',
    }));
    const haystack = (pageInfo.title + '\n' + pageInfo.text).toLowerCase();
    if (BLOCK_MARKERS.some((m) => haystack.includes(m.toLowerCase()))) {
      blocked = true;
      break;
    }

    // gentle randomized scroll to trigger lazy rendering, with stable-count early exit
    let prevCount = -1;
    let stable = 0;
    for (let s = 0; s < 4; s++) {
      const c = await page.evaluate(
        () =>
          document.querySelectorAll('div.job_seen_beacon, a[data-jk]').length
      );
      if (c === prevCount) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prevCount = c;
      await page.evaluate(() =>
        window.scrollBy(0, Math.round(document.body.scrollHeight * 0.6))
      );
      await sleep(rand(1500, 3500));
    }

    // --- 5. Parse job cards ---
    const raw = await page.evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(
          'div.job_seen_beacon, div.cardOutline, li div.cardOutline, [data-testid="slider_item"]'
        )
      );
      // fallback if the container class changed: anchor-based cards
      const nodes = cards.length
        ? cards
        : Array.from(document.querySelectorAll('a[data-jk]')).map(
            (a) => a.closest('li, div') || a
          );

      const pick = (el, sels) => {
        for (const s of sels) {
          const n = el.querySelector(s);
          if (n && n.innerText && n.innerText.trim()) return n.innerText.trim();
        }
        return null;
      };

      return nodes.map((card) => {
        const title = pick(card, [
          'h2 a span[title]',
          'h2 a span',
          'h2.jobTitle span',
          'a.jcs-JobTitle span',
          'h2 a',
        ]);
        const linkEl = card.querySelector(
          'h2 a, a.jcs-JobTitle, a[data-jk], a[href*="jk="]'
        );
        let jk = null;
        let href = null;
        if (linkEl) {
          jk = linkEl.getAttribute('data-jk');
          href = linkEl.getAttribute('href');
          if (!jk && href) {
            const m = href.match(/[?&]jk=([0-9a-fA-F]+)/);
            if (m) jk = m[1];
          }
        }
        if (!jk) {
          const dj = card.getAttribute && card.getAttribute('data-jk');
          if (dj) jk = dj;
        }
        const company = pick(card, [
          '[data-testid="company-name"]',
          'span.companyName',
          '.companyName',
        ]);
        const loc = pick(card, [
          '[data-testid="text-location"]',
          '.companyLocation',
          'div.company_location',
        ]);
        const salEl = card.querySelector(
          '[class*="salary"], [data-testid="attribute_snippet_testid"]'
        );
        const salaryText = salEl ? salEl.innerText : null;
        // metadata pills (job type / snippets) for best-effort contract type
        const metaEls = Array.from(
          card.querySelectorAll(
            '[data-testid="attribute_snippet_testid"], [class*="jobMetaDataGroup"] div, [class*="metadataContainer"] li'
          )
        );
        const metaText = metaEls
          .map((e) => (e.innerText || '').trim())
          .filter(Boolean)
          .join(' | ');
        // published date (best-effort: datetime attr, else visible text, else null)
        const dateEl = card.querySelector(
          'time[datetime], [data-testid="myJobsStateDate"], span.date, .date'
        );
        const publishedAt = dateEl
          ? dateEl.getAttribute('datetime') ||
            (dateEl.innerText || '').trim() ||
            null
          : null;
        const cardText = card.innerText || '';
        return {
          title,
          jk,
          href,
          company,
          loc,
          salaryText,
          metaText,
          publishedAt,
          cardText,
        };
      });
    });

    let added = 0;
    for (const r of raw) {
      if (!r.title && !r.jk) continue;

      // absolute url: prefer canonical jk-based viewjob link
      let url = null;
      if (r.jk) url = 'https://pl.indeed.com/viewjob?jk=' + r.jk;
      else if (r.href) {
        url = r.href.startsWith('http')
          ? r.href
          : 'https://pl.indeed.com' + r.href;
      }

      const dedupeKey = r.jk || url || r.title;
      if (dedupeKey && seen.has(dedupeKey)) continue;
      if (dedupeKey) seen.add(dedupeKey);

      // clean city: strip leading Polish postal code ("52-407 Wrocław" -> "Wrocław")
      let city = null;
      if (r.loc) city = r.loc.replace(/^\d{2}-\d{3}\s*/, '').trim() || null;

      // best-effort metadata (never invented: null when not found on the card)
      const metaSource = (r.metaText || '') + ' ' + (r.cardText || '');
      const expSource = (r.title || '') + ' ' + (r.cardText || '');
      const remote = /zdaln|praca zdalna|\bremote\b/i.test(
        (r.loc || '') + ' ' + (r.cardText || '')
      );

      // full contract shape, defaulting to null where the site gives us nothing
      const offer = {
        source: 'indeed',
        company: r.company || null,
        title: r.title || null,
        url: url || null,
        city: city,
        salary_from: null,
        salary_to: null,
        salary_currency: null,
        contract_type: parseContractType(metaSource),
        experience_level: parseExperience(expSource),
        published_at: r.publishedAt || null,
        remote: remote,
      };

      // salary (only when a currency was actually present)
      const sal = parseSalary(r.salaryText);
      if (sal.salary_from != null) offer.salary_from = sal.salary_from;
      if (sal.salary_to != null) offer.salary_to = sal.salary_to;
      if (sal.salary_currency) offer.salary_currency = sal.salary_currency;

      offers.push(offer);
      added++;
    }

    // legit "no results" page? -> not a block, just stop. Otherwise 0 offers = blocked.
    if (added === 0) {
      const noResults =
        /nie przyniosło żadnych wyników|nie znaleziono|0 ofert|brak ofert/i.test(
          pageInfo.text
        );
      if (offers.length === 0 && !noResults) {
        // 0 offers where some were expected -> treat as blocked
        blocked = true;
      }
      break; // nothing new on this page -> stop paginating either way
    }
  }
} catch (e) {
  // unexpected failure: do not hammer the site; record what we have
  // (blocked stays as-is; offers keeps whatever was parsed)
} finally {
  // --- 6. ALWAYS write results (even if empty or blocked) ---
  try {
    fs.mkdirSync(cfg.collectDir, { recursive: true });
  } catch (e) {}
  try {
    fs.writeFileSync(
      cfg.collectDir + '/indeed.json',
      JSON.stringify({ source: 'indeed', count: offers.length, offers })
    );
  } catch (e) {}
  // --- 7. close page ---
  try {
    await page.close();
  } catch (e) {}
}

return [{ json: { site: 'indeed', count: offers.length, blocked } }];