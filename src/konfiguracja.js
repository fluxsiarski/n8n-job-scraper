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

const cfg = { ...search, urls, collectDir };
fs.writeFileSync('/tmp/scrape_config.json', JSON.stringify(cfg));
return [{ json: cfg }];
