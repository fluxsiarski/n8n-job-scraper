// ====== ROCKETJOBS.PL — official JSON API; honors pasted browser URL for filters ======
// V3: + detail phase — full description z JSON-LD (JobPosting) na stronie oferty.
// Brak detail API (404) — kazda strona /oferta-pracy/{slug} to SSR HTML (~1.2 MB)
// z jednym <script type="application/ld+json"> zawierajacym pelny opis jako HTML.
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(a + Math.random() * (b - a));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BLOCK = ['captcha', 'just a moment', 'cf-chl', 'datadome', 'access denied', 'attention required'];
// Klucz cache/dedup — MUSI byc identyczny z Excel Writerem:
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';

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
let detailsFetched = 0, detailsCached = 0, detailErrors = 0, detailAborted = false;
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

  // ====== DETAIL PHASE (V3) — pelne opisy z JSON-LD na stronach ofert ======
  if (!blocked && offers.length) {
    let cache = {};
    try { const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); if (c && typeof c === 'object') cache = c; } catch (e) { cache = {}; }
    try {
      let fetchedAny = false;  // sleep dopiero MIEDZY fetchami (cache-hity bez opoznien)
      for (const offer of offers) {
        if (!offer.url) continue;
        const key = nurl(offer.url);
        const hit = cache[key];
        if (hit && hit.f && typeof hit.f.description === 'string' && hit.f.description) {
          Object.assign(offer, hit.f);
          detailsCached++;
          continue;
        }
        if (fetchedAny) await sleep(rand(1500, 3000)); // strony ~1.2 MB — dluzsze opoznienia
        fetchedAny = true;

        let res = null;
        try {
          // JEDEN evaluate na oferte (protocolTimeout) — fetch + ekstrakcja w przegladarce
          res = await page.evaluate(async (offerUrl, BLOCK) => {
            try {
              const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
              const killer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
              let r;
              try { r = await fetch(offerUrl, { headers: { 'Accept': 'text/html' }, signal: ctrl ? ctrl.signal : undefined }); }
              finally { if (killer) clearTimeout(killer); }
              if (!r.ok) return { httpStatus: r.status };
              const html = await r.text();
              // dokladnie jeden ld+json JobPosting na stronie — ale iterujemy defensywnie
              const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
              let m, jp = null;
              while ((m = re.exec(html)) !== null) {
                try {
                  const obj = JSON.parse(m[1]);
                  const arr = Array.isArray(obj) ? obj : [obj];
                  const found = arr.find(x => x && x['@type'] === 'JobPosting');
                  if (found) { jp = found; break; }
                } catch (e) {}
              }
              if (!jp) {
                // brak JobPosting = to nie jest normalna strona oferty -> sprawdz sygnaly blokady
                // (na poprawnej stronie nie skanujemy — 'captcha' w bundlach JS to false-positive)
                const low = html.toLowerCase();
                if (BLOCK.some(s => low.includes(s))) return { blockSignal: true };
                return { err: 'ld+json JobPosting not found' };
              }
              let dhtml = String(jp.description || '');
              // naglowki sekcji -> WIELKIE LITERY z dwukropkiem; struktura blokow -> \n
              dhtml = dhtml
                .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (m0, t) => '\n\n' + t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().replace(/[:\s]+$/, '').toUpperCase() + ':\n')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<li[^>]*>/gi, '\n- ')
                .replace(/<\/(p|div|li|ul|ol|tr|table|section)>/gi, '\n');
              let txt = '';
              try {
                const doc = new DOMParser().parseFromString(dhtml, 'text/html');
                txt = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
              } catch (e) { txt = dhtml.replace(/<[^>]+>/g, ' '); }
              txt = txt.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
              return { desc: txt, validThrough: jp.validThrough || null };
            } catch (e) { return { err: 'fetch ' + String((e && e.message) || e) }; }
          }, offer.url, BLOCK);
        } catch (e) { res = { err: 'evaluate ' + String((e && e.message) || e).slice(0, 120) }; }

        if (!res) res = { err: 'empty result' };
        if (res.blockSignal || res.httpStatus === 403 || res.httpStatus === 429) {
          // sygnal blokady — natychmiast przerywamy faze detali, lista zostaje
          detailAborted = true;
          offer.detail_error = res.blockSignal ? 'block signal' : ('http ' + res.httpStatus);
          detailErrors++;
          break;
        }
        if (res.desc && typeof res.desc === 'string' && res.desc.trim()) {
          const f = { description: res.desc.slice(0, 15000) };
          if (res.validThrough) f.valid_through = res.validThrough;
          Object.assign(offer, f);
          cache[key] = { t: Date.now(), f }; // cache tylko udanych (niepusty opis)
          detailsFetched++;
        } else {
          // per-offer failure (non-403/429): detail_error + jedziemy dalej (konwencja)
          offer.description = null;
          offer.detail_error = String(res.err || (res.httpStatus ? 'http ' + res.httpStatus : 'empty description')).slice(0, 160);
          detailErrors++;
        }
      }
    } catch (e) {} // totalna awaria fazy detali nie moze zabic danych z listy
    try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch (e) {}
  }
} catch (e) {}
try { fs.writeFileSync(cfg.collectDir + '/rocketjobs.json', JSON.stringify({ source: 'rocketjobs', count: offers.length, offers })); } catch (e) {}
try { await page.close(); } catch (e) {}
return [{ json: { site: 'rocketjobs', count: offers.length, blocked, details_fetched: detailsFetched, details_cached: detailsCached, detail_errors: detailErrors, detailAborted } }];
