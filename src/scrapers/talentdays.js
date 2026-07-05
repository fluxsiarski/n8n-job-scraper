// ====== TALENTDAYS — jobOffers/list API; honors pasted browser URL for filters ======
// API: cursor must be '' first page, paginate via meta.nextCursor. Fields: position,
// employer.name, city.name, wages, slug, experience. TalentDays mixes jobs + staż, so we
// filter by experience (from ?doswiadczenie=…) if given, else by staż/praktyki/trainee title.
// V3: detail phase — POST /api/rpc/jobOffers/get per offer (slug carried as _slug) returns
// {json:{content: <full HTML description>}}; stripped via DOMParser, cached by nurl(url).
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const deaccent = (s) => (s || '').replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BLOCK = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];
const INTERN_RE = /(sta[zż]yst|sta[zż]\b|praktyk|intern|trainee)/i;

// --- V3: description cache (shared across portal nodes; key must match Excel Writer dedup) ---
const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) || {}; } catch (e) { cache = {}; }
let detailsFetched = 0, detailsCached = 0, detailErrors = 0, detailAborted = false;

let citySlug = deaccent(cfg.location) || 'wroclaw';
let expFilter = null;
const ov = cfg.urls && cfg.urls.talentdays && String(cfg.urls.talentdays).trim();
if (ov) {
  const segs = ov.split('?')[0].replace(/\/+$/, '').split('/');
  if (segs.length) citySlug = segs[segs.length - 1] || citySlug;
  const q = ov.split('?')[1] || '';
  const p = {};
  q.split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  if (p['doswiadczenie']) expFilter = String(p['doswiadczenie']).toUpperCase(); // e.g. ZERO
}

let offers = [];
let blocked = false;
const page = await $browser.newPage();
try {
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await sleep(rand(2500, 6000));
  await page.goto('https://talentdays.pl/oferty-pracy-i-stazy/' + citySlug, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(rand(1200, 2500));
  const bt = ((await page.evaluate(() => document.body ? document.body.innerText : '')) || '').toLowerCase();
  if (BLOCK.some(m => bt.includes(m))) {
    blocked = true;
  } else {
    const raw = await page.evaluate(async (citySlug, UA) => {
      const API = 'https://talentdays.pl/api/rpc/jobOffers/list';
      const all = []; let cursor = '';
      for (let i = 0; i < 15; i++) {
        let r;
        try {
          r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, credentials: 'include', body: JSON.stringify({ json: { perPage: 20, cursor: cursor, citySlugs: [citySlug] } }) });
        } catch (e) { return { err: 'fetch ' + e.message, all }; }
        if (!r.ok) return { err: 'http ' + r.status, all };
        const j = await r.json();
        const root = j.json || j.result || j;
        const data = root.data || root.items || [];
        if (!data.length) break;
        all.push(...data);
        const nc = (root.meta && root.meta.nextCursor) || null;
        if (!nc) break;
        cursor = nc;
        await new Promise(res => setTimeout(res, 700 + Math.random() * 1000));
      }
      return { all };
    }, citySlug, UA);

    offers = (raw.all || []).map(o => {
      const w = o.wages || {};
      return {
        source: 'talentdays', company: (o.employer && o.employer.name) || null, title: o.position || null,
        url: o.slug ? ('https://talentdays.pl/praca-i-staz/' + o.slug) : null,
        city: (o.city && o.city.name) || null,
        salary_from: (w.min !== undefined ? w.min : null), salary_to: (w.max !== undefined ? w.max : null),
        salary_currency: (w.currency !== undefined ? w.currency : null),
        contract_type: o.jobType || null, experience_level: o.experience || null, published_at: null,
        remote: Array.isArray(o.workplace) && o.workplace.includes('REMOTE'),
        _exp: o.experience || null,
        _slug: o.slug || null // temp — needed for jobOffers/get, removed before writing collect file
      };
    }).filter(o => {
      if (!o.url) return false;
      if (expFilter) return String(o._exp || '').toUpperCase() === expFilter; // e.g. only ZERO (entry-level)
      return INTERN_RE.test(o.title || '');
    }).map(o => { delete o._exp; return o; });

    // ====== V3 DETAIL PHASE — full description per offer via jobOffers/get ======
    // Cache hit → reuse; miss → one page.evaluate per fetch (same-origin, cookies ride along),
    // node-side jittered sleep between fetches, abort on 403/429/block-signal, tolerate per-offer errors.
    try {
      for (const o of offers) {
        if (detailAborted) break;
        if (!o.url) continue; // no url = no key, no fetch
        const key = nurl(o.url);
        const hit = cache[key];
        if (hit && hit.f && typeof hit.f.description === 'string' && hit.f.description) {
          Object.assign(o, hit.f);
          detailsCached++;
          continue;
        }
        // slug: prefer the carried _slug, else re-derive from url
        const slug = o._slug || (o.url.indexOf('/praca-i-staz/') >= 0 ? o.url.split('/praca-i-staz/')[1].replace(/\/+$/, '') : null);
        if (!slug) { o.detail_error = 'no slug'; detailErrors++; continue; }

        await sleep(rand(700, 1700)); // politeness jitter (Node context, between evaluate calls)

        let d = null;
        try {
          d = await page.evaluate(async (slug, UA, BLOCK) => {
            const ctl = new AbortController();
            const kill = setTimeout(() => ctl.abort(), 30000); // keep each evaluate well under protocolTimeout
            try {
              const r = await fetch('https://talentdays.pl/api/rpc/jobOffers/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
                credentials: 'include',
                body: JSON.stringify({ json: { type: 'public', slug: slug } }),
                signal: ctl.signal
              });
              if (r.status === 403 || r.status === 429) return { blocked: true, err: 'http ' + r.status };
              const txt = await r.text();
              let j = null;
              try { j = JSON.parse(txt); } catch (e) {
                const low = (txt || '').toLowerCase();
                if (BLOCK.some(m => low.includes(m))) return { blocked: true, err: 'block signal' };
                return { err: 'bad json (http ' + r.status + ')' };
              }
              if (!r.ok) return { err: 'http ' + r.status };
              // response may nest as j.json or j.result.data — probe defensively like the list code
              const root = (j && j.json) || (j && j.result && j.result.data) || (j && j.result) || j || {};
              const html = root.content || root.summary || '';
              let text = null;
              if (html) {
                // keep block structure as newlines before stripping tags
                const prep = String(html)
                  .replace(/<br\s*\/?>/gi, '\n')
                  .replace(/<li[^>]*>/gi, '- ')
                  .replace(/<\/(li|tr)>/gi, '\n')
                  .replace(/<\/(p|div|section|article|ul|ol|table|h[1-6])>/gi, '\n\n');
                const doc = new DOMParser().parseFromString(prep, 'text/html');
                text = ((doc.body && (doc.body.innerText || doc.body.textContent)) || '')
                  .replace(/ /g, ' ').replace(/\r/g, '')
                  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
              }
              const out = { description: text ? text.slice(0, 15000) : null };
              if (root.application && root.application.url) out.apply_url = root.application.url;
              if (root.expirationDate) out.expires_at = root.expirationDate;
              return { fields: out };
            } catch (e) {
              return { err: 'fetch ' + ((e && e.message) || String(e)) };
            } finally { clearTimeout(kill); }
          }, slug, UA, BLOCK);
        } catch (e) { d = { err: 'evaluate ' + e.message }; }

        if (d && d.blocked) {
          // block signal / 403 / 429 — stop the detail phase, keep everything gathered so far
          detailAborted = true;
          o.detail_error = d.err || 'blocked';
          break;
        }
        if (d && d.fields && typeof d.fields.description === 'string' && d.fields.description) {
          Object.assign(o, d.fields);
          detailsFetched++;
          cache[key] = { t: Date.now(), f: d.fields }; // only non-empty descriptions get cached
        } else {
          o.detail_error = (d && d.err) || 'no content';
          detailErrors++;
        }
      }
    } catch (e) {} // total detail-phase failure still yields V2-equivalent output (list data intact)
  }
} catch (e) {}
try { offers.forEach(o => { delete o._slug; if (!('description' in o)) o.description = null; }); } catch (e) {} // convention: description must be null if unavailable
try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch (e) {} // best-effort
try { fs.writeFileSync(cfg.collectDir + '/talentdays.json', JSON.stringify({ source: 'talentdays', count: offers.length, offers })); } catch (e) {}
try { await page.close(); } catch (e) {}
return [{ json: { site: 'talentdays', count: offers.length, blocked, details_fetched: detailsFetched, details_cached: detailsCached, detail_errors: detailErrors, detailAborted } }];
