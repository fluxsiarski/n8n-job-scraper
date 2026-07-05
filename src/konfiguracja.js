// ============================================================================
// KONFIGURACJA — JEDYNE miejsce, które edytujesz.
// ============================================================================
const fs = require('fs');

// --- 1) DOMYŚLNE filtry (używane, gdy dany URL w sekcji 2 jest pusty '') ---
const search = {
  keyword:  'staż',
  category: 'internship',
  location: 'Wrocław',
  radius:   30              // km
};

// --- 2) WŁASNE URL-e Z FILTRAMI (wklej adres ze strony po ustawieniu filtrów) ---
// Wejdź na portal, ustaw filtry ręcznie, skopiuj adres z paska i wklej tutaj.
// Puste '' = zbuduj URL automatycznie z sekcji 1. Tak masz pełną kontrolę.
const urls = {
  justjoin:    'https://justjoin.it/job-offers/wroclaw?employment-types=internship',
  rocketjobs:  'https://rocketjobs.pl/oferty-pracy/wroclaw?typ-umowy=umowa-o-staz',
  talentdays:  'https://talentdays.pl/oferty-pracy-i-stazy/wroclaw?doswiadczenie=ZERO',
  olx:         '',
  pracuj:      '',
  theprotocol: '',
  indeed:      ''
};
// ---------------------------------------------------------------------------

const collectDir = '/tmp/scrape_run';
try { fs.rmSync(collectDir, { recursive: true, force: true }); } catch (e) {}
fs.mkdirSync(collectDir, { recursive: true });

const cfg = { ...search, urls, collectDir, descCache: '/output/desc_cache.json' };
fs.writeFileSync('/tmp/scrape_config.json', JSON.stringify(cfg));

// --- Utrzymanie cache opisów: usuń wpisy starsze niż 60 dni ---
// Błędy cache NIGDY nie mogą przerwać przebiegu — wszystko w try/catch.
try {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cfg.descCache, 'utf8')); } catch (e) { cache = {}; }
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  for (const key of Object.keys(cache)) {
    if (!cache[key] || !cache[key].t || cache[key].t < cutoff) delete cache[key];
  }
  fs.writeFileSync(cfg.descCache, JSON.stringify(cache));
} catch (e) {
  // Ostatnia deska ratunku: zapisz pusty cache, żeby kolejne node'y zawsze
  // znalazły plik. Jeśli i to się nie uda — trudno, jedziemy dalej.
  try { fs.writeFileSync(cfg.descCache, '{}'); } catch (e2) {}
}

return [{ json: cfg }];
