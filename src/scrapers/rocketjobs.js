// ====== ROCKETJOBS.PL — official JSON API; honors pasted browser URL for filters ======
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BLOCK = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];

const city = cfg.location || 'Wrocław';
let empTypes = [(cfg.category && String(cfg.category).trim()) || 'internship'];
let expLevels = [];
const ov = cfg.urls && cfg.urls.rocketjobs && String(cfg.urls.rocketjobs).trim();
if (ov) {
  const q = ov.split('?')[1] || '';
  const p = {};
  q.split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  // RocketJobs browser filters: typ-umowy (contract) + doswiadczenie (experience)
  const tu = p['typ-umowy'];
  if (tu) { const m = { 'umowa-o-staz': 'internship', 'umowa-o-prace': 'permanent', 'b2b': 'b2b', 'umowa-zlecenie': 'mandate_contract' }; empTypes = [m[tu] || tu]; }
  const et = p['employment-types'] || p['employment-type']; if (et) empTypes = et.split(',');
  const dosw = p['doswiadczenie'] || p['experience-level']; if (dosw) expLevels = dosw.split(',');
}

let offers = [];
let blocked = false;
const page = await $browser.newPage();
try {
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await sleep(rand(2500, 6000));
  await page.goto('https://rocketjobs.pl/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(rand(1200, 2500));
  const bt = ((await page.evaluate(() => document.body ? document.body.innerText : '')) || '').toLowerCase();
  if (BLOCK.some(m => bt.includes(m))) {
    blocked = true;
  } else {
    const raw = await page.evaluate(async (city, empTypes, expLevels, UA) => {
      const all = []; const per = 100;
      for (let p = 1; p <= 10; p++) {
        let url = 'https://api.rocketjobs.pl/v2/user-panel/offers?page=' + p + '&perPage=' + per + '&city=' + encodeURIComponent(city);
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

    offers = (raw.all || []).map(o => {
      const et = (o.employmentTypes && o.employmentTypes[0]) || {};
      return {
        source: 'rocketjobs', company: o.companyName || null, title: o.title || null,
        url: o.slug ? ('https://rocketjobs.pl/oferta-pracy/' + o.slug) : null,
        city: o.city || (o.multilocation && o.multilocation[0] && o.multilocation[0].city) || null,
        salary_from: (et.from !== undefined ? et.from : null), salary_to: (et.to !== undefined ? et.to : null),
        salary_currency: (et.currency !== undefined ? et.currency : null), contract_type: (et.type !== undefined ? et.type : null),
        experience_level: o.experienceLevel || null, published_at: o.publishedAt || null, remote: o.workplaceType === 'remote'
      };
    }).filter(o => o.url);
  }
} catch (e) {}
try { fs.writeFileSync(cfg.collectDir + '/rocketjobs.json', JSON.stringify({ source: 'rocketjobs', count: offers.length, offers })); } catch (e) {}
try { await page.close(); } catch (e) {}
return [{ json: { site: 'rocketjobs', count: offers.length, blocked } }];
