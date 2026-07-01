// ====== TALENTDAYS — jobOffers/list API; honors pasted browser URL for filters ======
// API: cursor must be '' first page, paginate via meta.nextCursor. Fields: position,
// employer.name, city.name, wages, slug, experience. TalentDays mixes jobs + staż, so we
// filter by experience (from ?doswiadczenie=…) if given, else by staż/praktyki/trainee title.
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const deaccent = (s) => (s || '').replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BLOCK = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];
const INTERN_RE = /(sta[zż]yst|sta[zż]\b|praktyk|intern|trainee)/i;

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
        _exp: o.experience || null
      };
    }).filter(o => {
      if (!o.url) return false;
      if (expFilter) return String(o._exp || '').toUpperCase() === expFilter; // e.g. only ZERO (entry-level)
      return INTERN_RE.test(o.title || '');
    }).map(o => { delete o._exp; return o; });
  }
} catch (e) {}
try { fs.writeFileSync(cfg.collectDir + '/talentdays.json', JSON.stringify({ source: 'talentdays', count: offers.length, offers })); } catch (e) {}
try { await page.close(); } catch (e) {}
return [{ json: { site: 'talentdays', count: offers.length, blocked } }];
