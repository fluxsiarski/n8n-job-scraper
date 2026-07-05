// ===== NoFluffJobs scraper (n8n-nodes-puppeteer, runCustomScript) =====
// Strategy: load the criteria page in a real browser (cookies + edge check),
// then hit the site's own JSON API from inside the page. Fall back to the
// embedded Angular TransferState JSON, then to DOM links. Gentle by design.
// V3: after the list, fetch full descriptions via the official detail API
// GET https://nofluffjobs.com/api/posting/{slug} (verified live, ~19KB JSON),
// with an on-disk description cache so re-runs stay fast.

const fs = require('fs');

// ---------- 1. config ----------
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
// cfg = { keyword, category, location, radius, collectDir, descCache }

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const jitter = (min, max) => sleep(rand(min, max));

// strip diacritics (incl. L-stroke), lowercase, spaces -> '-'
const stripDiacritics = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[Łł]/g, 'l') // L-stroke -> l (does not decompose)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-');

const SITE = 'nofluffjobs';

// Shared block-signal needles (used for the warm-up page AND detail responses).
const BLOCK_NEEDLES = [
  'captcha',
  'just a moment',
  'cf-chl',
  'datadome',
  'access denied',
  'attention required',
];

// Cache key normalizer — MUST match Excel Writer's dedup key exactly.
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();

// ---------- build search from cfg (nothing hardcoded but the domain) ----------
const citySlug = stripDiacritics(cfg.location || 'Wroclaw'); // e.g. 'wroclaw'
const keyword = (cfg.keyword == null ? '' : String(cfg.keyword)).trim();
const category = stripDiacritics(cfg.category || '');
const radius =
  cfg.radius === 0 || cfg.radius ? String(cfg.radius).trim() : '';

// NoFluffJobs is an IT-only board: an "internship" == seniority "trainee".
// Warm-up URL criteria pairs (Angular tolerates extra keys like distance).
const urlPairs = [];
if (citySlug) urlPairs.push(['city', citySlug]);
if (radius) urlPairs.push(['distance', radius]);
if (category) urlPairs.push(['category', category]);
urlPairs.push(['seniority', 'trainee']);

// Criteria pairs sent to the JSON API (known-good keys only, no distance).
const apiPairs = urlPairs.filter((pair) => pair[0] !== 'distance');

const criteria = urlPairs
  .map((pair) => `${pair[0]}%3D${encodeURIComponent(pair[1])}`)
  .join(',');

// keyword lives in the URL path segment when present
const kwPath = keyword
  ? '/' + encodeURIComponent(keyword.toLowerCase().replace(/\s+/g, '-'))
  : '';

const pageUrl = `https://nofluffjobs.com/pl/praca-it${kwPath}?criteria=${criteria}`;

// Raw search string form used by the JSON API: free-text keyword + key=value.
const rawSearch = [keyword]
  .concat(apiPairs.map((pair) => `${pair[0]}=${pair[1]}`))
  .filter(Boolean)
  .join(' ');

const outFile = `${cfg.collectDir}/${SITE}.json`;

// ---------- description cache (read once at start) ----------
const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';
let descCache = {};
try {
  const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    descCache = parsed;
  }
} catch (e) {
  descCache = {}; // missing/corrupt cache is fine — start fresh
}
let cacheDirty = false;

let offers = [];
let blocked = false;

// detail-phase counters (returned in the node status)
let detailsFetched = 0;
let detailsCached = 0;
let detailErrors = 0;
let detailAborted = false;

const writeOut = () => {
  try {
    fs.writeFileSync(
      outFile,
      JSON.stringify({ source: SITE, count: offers.length, offers })
    );
  } catch (e) {
    /* best-effort: nothing else we can do here */
  }
};

// epoch(ms or s) or ISO string -> ISO string
const toIso = (v) => {
  if (!v) return undefined;
  let n = typeof v === 'number' ? v : Date.parse(v);
  if (!n || isNaN(n)) return undefined;
  if (n < 1e12) n = n * 1000; // seconds -> ms
  try {
    return new Date(n).toISOString();
  } catch (e) {
    return undefined;
  }
};

// Build an absolute nofluffjobs.com job URL from whatever slug/url we get.
const toAbsUrl = (slug) => {
  if (!slug) return undefined;
  const s = String(slug).trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '/') return 'https://nofluffjobs.com' + s;
  return 'https://nofluffjobs.com/pl/job/' + s;
};

// Recover the detail-API slug from a stored offer url.
// Slug = posting's `url` field (lowercase, diacritic-free) — NEVER the `id`
// field, which may contain diacritics like 'Wrocław'.
const slugOf = (u) => {
  const m = String(u || '').match(/\/job\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
};

// Find an array of posting-like objects anywhere in a JSON blob.
const findPostings = (root) => {
  if (!root || typeof root !== 'object') return null;
  if (Array.isArray(root.postings)) return root.postings;
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      if (
        cur.length &&
        cur.every(
          (el) =>
            el &&
            typeof el === 'object' &&
            'title' in el &&
            ('name' in el || 'url' in el)
        )
      ) {
        return cur;
      }
      cur.forEach((el) => queue.push(el));
    } else {
      if (Array.isArray(cur.postings)) return cur.postings;
      Object.keys(cur).forEach((k) => queue.push(cur[k]));
    }
  }
  return null;
};

// Map one NoFluffJobs posting -> the common offer shape (omit unknowns).
const mapPosting = (p) => {
  if (!p || typeof p !== 'object') return null;
  const o = { source: SITE };

  if (p.title) o.title = String(p.title).trim();
  if (p.name) o.company = String(p.name).trim();

  // location / remote
  const loc = p.location || {};
  let remote = loc.fullyRemote === true;
  const places = Array.isArray(loc.places) ? loc.places : [];
  const cityPlace = places.find((pl) => pl && pl.city);
  if (cityPlace) o.city = String(cityPlace.city).trim();
  else if (remote) o.city = 'Remote';
  o.remote = remote;

  // salary (may be object or first element of an array)
  let sal = p.salary;
  if (Array.isArray(sal)) sal = sal[0];
  sal = sal || {};
  if (typeof sal.from === 'number') o.salary_from = sal.from;
  if (typeof sal.to === 'number') o.salary_to = sal.to;
  if (sal.currency) o.salary_currency = sal.currency;
  if (sal.type) o.contract_type = String(sal.type); // b2b / permanent / mandate

  // seniority -> experience_level
  const sen = p.seniority;
  if (Array.isArray(sen) && sen.length) o.experience_level = sen.join(', ');
  else if (typeof sen === 'string' && sen) o.experience_level = sen;

  const pub = toIso(p.posted || p.renewed || p.published);
  if (pub) o.published_at = pub;

  const url = toAbsUrl(p.url || p.slug || p.postingUrl);
  if (url) o.url = url;

  return o.title || o.url ? o : null;
};

const page = await $browser.newPage();

try {
  // ---------- 3. SAFETY: identity + warm-up ----------
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
  });

  // random delay before the very first navigation
  await jitter(2500, 6000);

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // give Angular time to bootstrap and fire its own XHRs; also lets cookies set
  await jitter(3000, 5000);
  try {
    await page.waitForSelector('a[href*="/job/"], nfj-postings-list', {
      timeout: 12000,
    });
  } catch (e) {
    /* fine: API path does not need rendered cards */
  }

  // ---------- 4. BLOCK DETECTION ----------
  const curUrl = page.url();
  let bodyText = '';
  try {
    bodyText = await page.evaluate(() =>
      document.body ? document.body.innerText : ''
    );
  } catch (e) {}
  const lower = (bodyText || '').toLowerCase();
  if (
    /\/(challenge|cdn-cgi\/challenge)/i.test(curUrl) ||
    BLOCK_NEEDLES.some((n) => lower.includes(n))
  ) {
    blocked = true;
  }

  // ---------- 5. PARSE OFFERS ----------
  if (!blocked) {
    let gotValidResponse = false;
    let apiBlockSignal = false;
    const pageSize = 100;
    const maxPages = 10;

    // In-browser API call. Tries two known body formats.
    const apiFetch = (bodyMode, pageTo, size) =>
      page.evaluate(
        async (rawSearch, bodyMode, pageTo, size) => {
          const url =
            'https://nofluffjobs.com/api/search/posting' +
            `?pageTo=${pageTo}&pageSize=${size}` +
            '&salaryCurrency=PLN&salaryPeriod=Month&region=pl&language=pl-PL';
          let body;
          if (bodyMode === 'raw') {
            body = JSON.stringify({ rawSearch });
          } else {
            const crit = {};
            rawSearch
              .split(' ')
              .filter(Boolean)
              .forEach((pair) => {
                const idx = pair.indexOf('=');
                if (idx < 0) return;
                const k = pair.slice(0, idx);
                const v = pair.slice(idx + 1);
                (crit[k] = crit[k] || []).push(v);
              });
            body = JSON.stringify({ criteriaSearch: crit, rawJobs: [], url: '' });
          }
          try {
            const res = await fetch(url, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              },
              body,
            });
            let json = null;
            try {
              json = await res.json();
            } catch (e) {}
            return { ok: res.ok, status: res.status, json };
          } catch (e) {
            return { ok: false, status: 0, json: null, error: String(e) };
          }
        },
        rawSearch,
        bodyMode,
        pageTo,
        size
      );

    const collect = (json) => {
      const arr = Array.isArray(json && json.postings)
        ? json.postings
        : findPostings(json) || [];
      arr.forEach((p) => {
        const m = mapPosting(p);
        if (m) offers.push(m);
      });
      return arr.length;
    };

    // Detect a working body format on page 1.
    let workingMode = null;
    let firstJson = null;
    for (const mode of ['raw', 'criteria']) {
      const r = await apiFetch(mode, 1, pageSize);
      if (r && (r.status === 403 || r.status === 429)) apiBlockSignal = true;
      if (
        r &&
        r.json &&
        (Array.isArray(r.json.postings) || findPostings(r.json))
      ) {
        workingMode = mode;
        firstJson = r.json;
        gotValidResponse = true;
        break;
      }
      await jitter(1200, 2600);
    }

    if (workingMode) {
      const firstCount = collect(firstJson);
      const totalPages = Number(firstJson.totalPages) || 1;
      // Trainee+city results are tiny; only paginate if a full page came back.
      if (firstCount >= pageSize && totalPages > 1) {
        for (let pg = 2; pg <= Math.min(totalPages, maxPages); pg++) {
          await jitter(1500, 3500); // randomized delay between pages
          const r = await apiFetch(workingMode, pg, pageSize);
          if (!r || !r.json) break;
          if (r.status === 403 || r.status === 429) {
            apiBlockSignal = true;
            break;
          }
          if (!collect(r.json)) break;
        }
      }
    }

    // Fallback A: embedded Angular TransferState / JSON-LD
    if (offers.length === 0) {
      let embedded = [];
      try {
        embedded = await page.evaluate(() => {
          const out = [];
          document
            .querySelectorAll(
              'script[type="application/json"], script[type="application/ld+json"]'
            )
            .forEach((s) => {
              const t = (s.textContent || '').trim();
              if (t.length > 20) out.push(t);
            });
          return out;
        });
      } catch (e) {}
      for (const raw of embedded) {
        try {
          const j = JSON.parse(raw);
          const arr = findPostings(j);
          if (arr && arr.length) {
            gotValidResponse = true;
            arr.forEach((p) => {
              const m = mapPosting(p);
              if (m) offers.push(m);
            });
            if (offers.length) break;
          }
        } catch (e) {}
      }
    }

    // Fallback B: rendered DOM anchors -> best effort (needs live tuning)
    if (offers.length === 0) {
      let domOffers = [];
      try {
        domOffers = await page.evaluate(() => {
          const res = [];
          const seen = new Set();
          document.querySelectorAll('a[href*="/job/"]').forEach((a) => {
            const href = a.getAttribute('href') || '';
            if (!href || seen.has(href)) return;
            seen.add(href);
            const h = a.querySelector('h3, [data-cy*="title"]');
            const title = ((h && h.innerText) || a.innerText || '').trim();
            res.push({ href, title });
          });
          return res;
        });
      } catch (e) {}
      domOffers.forEach((d) => {
        const url = toAbsUrl(d.href);
        if (!url) return;
        const o = { source: SITE, url };
        if (d.title) o.title = d.title;
        offers.push(o);
      });
    }

    // De-duplicate by url (fallback key: title|company)
    const seenKey = new Set();
    offers = offers.filter((o) => {
      const key = o.url || `${o.title || ''}|${o.company || ''}`;
      if (seenKey.has(key)) return false;
      seenKey.add(key);
      return true;
    });

    // If we never got a valid structure AND have zero offers, something is off
    // (edge check / soft block). Do NOT retry -- flag and move on.
    if (offers.length === 0 && (!gotValidResponse || apiBlockSignal)) {
      blocked = true;
    }
  }
} catch (e) {
  // Unexpected error: keep whatever we have; still write the file below.
}

// ---------- 6. DETAIL PHASE (V3): full descriptions via /api/posting/{slug} ----------
// One short page.evaluate per offer (single fetch inside — never a long loop,
// protocolTimeout safety), jittered sleeps in the Node context between calls.
// A total failure here must still leave the V2 list output intact.
try {
  if (!blocked && offers.length) {
    // Fetch + parse + compose ONE posting's detail inside the browser context.
    // Returns { ok, status, fields, text } — `text` is a short body snippet
    // used Node-side for block-signal checks.
    const fetchDetail = (slug) =>
      page.evaluate(async (slug) => {
        const out = { ok: false, status: 0, fields: null, text: '' };
        try {
          const res = await fetch(
            'https://nofluffjobs.com/api/posting/' + encodeURIComponent(slug),
            {
              credentials: 'include',
              headers: { Accept: 'application/json' },
            }
          );
          out.status = res.status;
          let raw = '';
          try {
            raw = await res.text();
          } catch (e) {}
          out.text = (raw || '').slice(0, 2000);
          if (!res.ok) return out;

          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (e) {
            return out;
          }
          if (!j || typeof j !== 'object') return out;

          // HTML -> plain text (DOMParser), keeping block-level line breaks.
          const strip = (html) => {
            if (html == null) return '';
            let s = String(html);
            if (!/[<&]/.test(s)) return s.trim();
            s = s
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/(p|li|div|h[1-6]|tr|ul|ol|section)>/gi, '\n');
            try {
              const doc = new DOMParser().parseFromString(s, 'text/html');
              const b = doc.body;
              return ((b && (b.innerText || b.textContent)) || '').trim();
            } catch (e) {
              return s.replace(/<[^>]*>/g, ' ').trim();
            }
          };
          const clean = (t) =>
            strip(t)
              .replace(/\r/g, '')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          // Coerce to array; some blobs wrap lists as { items: [...] }.
          const arrOf = (v) =>
            Array.isArray(v) ? v : v && Array.isArray(v.items) ? v.items : [];
          // Array of strings / {value} / {name} / {code} -> clean strings.
          const listVals = (v) =>
            arrOf(v)
              .map((el) => {
                if (el == null) return '';
                if (typeof el === 'string') return strip(el);
                if (typeof el === 'object') {
                  const raw =
                    el.value != null
                      ? el.value
                      : el.name != null
                      ? el.name
                      : el.code != null
                      ? el.code
                      : '';
                  return strip(raw);
                }
                return '';
              })
              .map((s) => s.trim())
              .filter(Boolean);

          const det = (j.details && typeof j.details === 'object' && j.details) || {};
          const req =
            (j.requirements && typeof j.requirements === 'object' && j.requirements) || {};
          const specs = (j.specs && typeof j.specs === 'object' && j.specs) || {};
          const ben =
            (j.benefits && typeof j.benefits === 'object' && j.benefits) || {};

          const musts = listVals(req.musts);
          const nices = listVals(req.nices);

          const sections = [];

          const descTxt = clean(det.description || j.description);
          if (descTxt) sections.push('OPIS:\n' + descTxt);

          const reqParts = [];
          const reqDesc = clean(req.description);
          if (reqDesc) reqParts.push(reqDesc);
          if (musts.length)
            reqParts.push(musts.map((s) => '- ' + s).join('\n'));
          const langs = listVals(req.languages);
          if (langs.length) reqParts.push('Języki: ' + langs.join(', '));
          if (reqParts.length)
            sections.push('WYMAGANIA:\n' + reqParts.join('\n'));

          if (nices.length)
            sections.push(
              'MILE WIDZIANE:\n' + nices.map((s) => '- ' + s).join('\n')
            );

          const tasks = listVals(specs.dailyTasks).length
            ? listVals(specs.dailyTasks)
            : listVals(specs.responsibilities);
          if (tasks.length)
            sections.push('OBOWIĄZKI:\n' + tasks.map((s) => '- ' + s).join('\n'));

          const benItems = []
            .concat(listVals(ben.benefits))
            .concat(listVals(ben.equipment))
            .concat(listVals(ben.officePerks));
          if (benItems.length)
            sections.push('BENEFITY:\n' + benItems.map((s) => '- ' + s).join('\n'));

          const description = sections
            .join('\n\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 15000);

          const fields = { description: description || null };
          if (musts.length) fields.skills_required = musts;
          if (nices.length) fields.skills_nice = nices;
          out.fields = fields;
          out.ok = true;
        } catch (e) {
          out.text = String((e && e.message) || e);
        }
        return out;
      }, slug);

    let consecHardFails = 0; // e.g. page died -> stop wasting time

    for (const offer of offers) {
      if (detailAborted) break;
      if (!offer || !offer.url) continue; // no url -> nothing to fetch

      const key = nurl(offer.url);
      const hit = descCache[key];
      if (
        hit &&
        hit.f &&
        typeof hit.f.description === 'string' &&
        hit.f.description
      ) {
        Object.assign(offer, hit.f); // cache hit — no network, no sleep
        detailsCached++;
        continue;
      }

      const slug = slugOf(offer.url);
      if (!slug) {
        offer.detail_error = 'no slug in url';
        detailErrors++;
        continue;
      }

      // politeness: jittered delay before every real fetch (NFJ: 800-2000 ms)
      await jitter(800, 2000);

      let r = null;
      try {
        r = await fetchDetail(slug);
      } catch (e) {
        r = { ok: false, status: 0, fields: null, text: String((e && e.message) || e) };
      }

      // Block signals: HTTP 403/429 or needle in the body -> abort the phase,
      // but KEEP the list data and every description fetched so far.
      const lowBody = String((r && r.text) || '').toLowerCase();
      if (
        (r && (r.status === 403 || r.status === 429)) ||
        BLOCK_NEEDLES.some((n) => lowBody.includes(n))
      ) {
        detailAborted = true;
        offer.detail_error = 'blocked (status ' + ((r && r.status) || 0) + ')';
        detailErrors++;
        break;
      }

      if (r && r.ok && r.fields) {
        consecHardFails = 0;
        Object.assign(offer, r.fields);
        detailsFetched++;
        // Only cache real, non-empty descriptions — never cache failures.
        if (typeof r.fields.description === 'string' && r.fields.description) {
          descCache[key] = { t: Date.now(), f: r.fields };
          cacheDirty = true;
        }
      } else {
        offer.detail_error =
          'detail fetch failed (status ' + ((r && r.status) || 0) + ')';
        detailErrors++;
        // status 0 = fetch/evaluate itself died (network, closed page, ...):
        // three in a row means the page is gone — abort instead of looping.
        if (!r || r.status === 0) {
          consecHardFails++;
          if (consecHardFails >= 3) detailAborted = true;
        } else {
          consecHardFails = 0;
        }
      }
    }
  }
} catch (e) {
  // Detail phase must never take down the run: fall back to V2-equivalent
  // output (list data, no descriptions) and report via detailAborted.
  detailAborted = true;
}

// Guarantee the field exists on every offer (null = unavailable).
try {
  offers.forEach((o) => {
    if (o && typeof o === 'object' && !('description' in o)) o.description = null;
  });
} catch (e) {}

// persist the description cache (best-effort, once, at the end)
if (cacheDirty) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(descCache));
  } catch (e) {}
}

// ---------- 7. write results (always) ----------
writeOut();

// ---------- 8. cleanup + return ----------
try {
  await page.close();
} catch (e) {}

return [
  {
    json: {
      site: SITE,
      count: offers.length,
      blocked,
      details_fetched: detailsFetched,
      details_cached: detailsCached,
      detail_errors: detailErrors,
      detailAborted,
    },
  },
];
