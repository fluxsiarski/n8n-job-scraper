// ====== JUSTJOIN.IT — official JSON API; honors pasted browser URL for filters ======
// V3: after the list, fetch each offer page (same-origin fetch inside the open page),
// extract the FULL plain-text description from the single ld+json JobPosting block,
// plus (best-effort) requiredSkills/niceToHaveSkills from the RSC flight payload.
// URL-keyed desc cache makes re-runs fast; multilocation dupes dedupe via the cache.
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BLOCK = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';

// Filters: default from cfg.category; overridden by a pasted browser URL if present.
const city = cfg.location || 'Wrocław';
let empTypes = [(cfg.category && String(cfg.category).trim()) || 'internship'];
let expLevels = [];
const ov = cfg.urls && cfg.urls.justjoin && String(cfg.urls.justjoin).trim();
if (ov) {
  const q = ov.split('?')[1] || '';
  const p = {};
  q.split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  const et = p['employment-types'] || p['employment-type'];
  const el = p['experience-level'] || p['experience-levels'];
  if (et) empTypes = et.split(',');
  if (el) expLevels = el.split(',');
}

let offers = [];
let blocked = false;
let details_fetched = 0, details_cached = 0, detail_errors = 0, detailAborted = false;
const page = await $browser.newPage();
try {
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await sleep(rand(2500, 6000));
  await page.goto('https://justjoin.it/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(rand(1200, 2500));
  const bt = ((await page.evaluate(() => document.body ? document.body.innerText : '')) || '').toLowerCase();
  if (BLOCK.some(m => bt.includes(m))) {
    blocked = true;
  } else {
    const raw = await page.evaluate(async (city, empTypes, expLevels, UA) => {
      const all = []; const per = 100;
      for (let p = 1; p <= 10; p++) {
        let url = 'https://api.justjoin.it/v2/user-panel/offers?page=' + p + '&perPage=' + per + '&city=' + encodeURIComponent(city);
        empTypes.forEach(t => { if (t) url += '&employmentTypes[]=' + encodeURIComponent(t); });
        expLevels.forEach(t => { if (t) url += '&experienceLevels[]=' + encodeURIComponent(t); });
        let r;
        try { r = await fetch(url, { headers: { version: '2', 'User-Agent': UA, 'Accept': 'application/json' } }); }
        catch (e) { return { err: 'fetch ' + e.message, all }; }
        if (!r.ok) return { err: 'http ' + r.status, all };
        const j = await r.json();
        const data = j.data || (Array.isArray(j) ? j : []);
        if (!data.length) break;
        all.push(...data);
        const tp = (j.meta && (j.meta.totalPages || j.meta.total_pages));
        if ((tp && p >= tp) || data.length < per) break;
        await new Promise(res => setTimeout(res, 800 + Math.random() * 1200));
      }
      return { all };
    }, city, empTypes, expLevels, UA);

    // Return ALL offers the filter yields (no extra over-filtering — Claude filters later).
    offers = (raw.all || []).map(o => {
      const et = (o.employmentTypes && o.employmentTypes[0]) || {};
      return {
        source: 'justjoin', company: o.companyName || null, title: o.title || null,
        url: o.slug ? ('https://justjoin.it/job-offer/' + o.slug) : null,
        city: o.city || (o.multilocation && o.multilocation[0] && o.multilocation[0].city) || null,
        salary_from: (et.from !== undefined ? et.from : null), salary_to: (et.to !== undefined ? et.to : null),
        salary_currency: (et.currency !== undefined ? et.currency : null), contract_type: (et.type !== undefined ? et.type : null),
        experience_level: o.experienceLevel || null, published_at: o.publishedAt || null, remote: o.workplaceType === 'remote'
      };
    }).filter(o => o.url);
  }
} catch (e) {}

// ====== DETAIL PHASE (V3) — full description per offer from the SSR offer page ======
// No detail API exists (all 404, verified live). Each https://justjoin.it/job-offer/{slug}
// is server-rendered and holds ONE <script type="application/ld+json"> with the full
// plain-text description. One fetch = one page.evaluate; sleeps happen node-side.
if (!blocked && offers.length) {
  // Cache: read once (best-effort), key = nurl(url) — matches Excel Writer's dedup key.
  let cache = {};
  try { const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); if (c && typeof c === 'object') cache = c; } catch (e) {}

  try {
    for (const off of offers) {
      if (detailAborted) break;
      if (!off || !off.url) continue;
      const key = nurl(off.url);

      // Cache hit → reuse fields (also dedupes multilocation twins in the same run).
      const hit = cache[key];
      if (hit && hit.f && typeof hit.f.description === 'string' && hit.f.description) {
        Object.assign(off, hit.f);
        details_cached++;
        continue;
      }

      // Politeness: jittered delay in Node context BEFORE each network hit.
      await sleep(rand(800, 2500));

      let res = null;
      try {
        res = await page.evaluate(async (u, BLOCK) => {
          try {
            // Hard 30s cap so this evaluate can never approach protocolTimeout.
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 30000);
            let html;
            try {
              const r = await fetch(u, { signal: ctrl.signal, headers: { 'Accept': 'text/html' } });
              if (r.status === 403 || r.status === 429) return { block: 'http ' + r.status };
              if (!r.ok) return { err: 'http ' + r.status };
              // Read the body while the abort signal is still armed — an aborted
              // signal also rejects an in-progress text(), so the 30s cap covers
              // headers AND body (a trickling body can otherwise hang the evaluate).
              html = await r.text();
            } finally { clearTimeout(tid); }

            // Single ld+json JobPosting block → full plain-text description.
            const m = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>(.*?)<\/script>/s);
            if (!m) {
              // Challenge/interstitial pages carry no JobPosting ld+json; their markers
              // sit in <head>/title, so check the leading chunk only (avoids false hits
              // deep in a legit offer's 790 KB flight payload).
              const low = html.slice(0, 6000).toLowerCase();
              const mark = BLOCK.find(b => low.includes(b));
              if (mark) return { block: 'block-signal: ' + mark };
              return { err: 'ld+json not found' };
            }
            let ld = null;
            try { ld = JSON.parse(m[1]); } catch (e) { return { err: 'ld+json parse: ' + e.message }; }

            const fields = {};
            let desc = (ld && ld.description) ? String(ld.description) : '';
            if (desc) {
              // Already plain text, but run through DOMParser anyway: decodes entities,
              // strips any residual tags. textContent keeps the \n structure.
              try {
                const doc = new DOMParser().parseFromString(desc, 'text/html');
                desc = (doc && doc.body ? (doc.body.textContent || '') : desc);
              } catch (e) {}
              desc = desc.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 15000);
            }
            fields.description = desc || null;

            // Bonus (best-effort): skills with levels from the RSC flight payload —
            // the list API returns these as null. Omit keys on any failure.
            try {
              const grab = (re) => {
                const mm = html.match(re);
                if (!mm) return null;
                const arr = JSON.parse('[' + mm[1].replace(/\\"/g, '"') + ']');
                const out = arr.map(s => (s && s.name)
                  ? (s.name + ((s.level !== undefined && s.level !== null) ? ' (level ' + s.level + ')' : ''))
                  : null).filter(Boolean);
                return out.length ? out : null;
              };
              const reqS = grab(/\\"requiredSkills\\":\[([^\]]*)\]/);
              const niceS = grab(/\\"niceToHaveSkills\\":\[([^\]]*)\]/);
              if (reqS) fields.skills_required = reqS;
              if (niceS) fields.skills_nice = niceS;
            } catch (e) {}

            return { fields };
          } catch (e) {
            return { err: String((e && e.message) || e).slice(0, 120) };
          }
        }, off.url, BLOCK);
      } catch (e) {
        res = { err: 'evaluate: ' + String((e && e.message) || e).slice(0, 100) };
      }
      if (!res) res = { err: 'no result' };

      if (res.block) {
        // Block signal / 403 / 429 → stop the detail phase, keep everything so far.
        off.description = off.description || null;
        off.detail_error = String(res.block).slice(0, 120);
        detail_errors++;
        detailAborted = true;
        break;
      }
      if (res.err || !res.fields) {
        off.description = off.description || null;
        off.detail_error = String(res.err || 'no fields').slice(0, 120);
        detail_errors++;
        continue;
      }

      const f = res.fields;
      if (typeof f.description !== 'string' || !f.description) {
        off.description = null;
        off.detail_error = 'empty description';
        detail_errors++;
        continue;
      }
      Object.assign(off, f);
      details_fetched++;
      // Only cache successes (non-empty description) — never cache failures.
      cache[key] = { t: Date.now(), f };
    }
  } catch (e) {}

  // Write cache once at the end (best-effort; keeps partial progress after abort too).
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch (e) {}
}

try { fs.writeFileSync(cfg.collectDir + '/justjoin.json', JSON.stringify({ source: 'justjoin', count: offers.length, offers })); } catch (e) {}
try { await page.close(); } catch (e) {}
return [{ json: { site: 'justjoin', count: offers.length, blocked, details_fetched, details_cached, detail_errors, detailAborted } }];
