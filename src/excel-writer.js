// ===== EXCEL WRITER — appends a new dated+hour tab (Tracker style) to the master =====
// No cross-tab dedup: EVERY offer from this run is saved (within-run dupes by URL removed).
// Claude Code later builds a profile-filtered / deduped shortlist tab.
const ExcelJS = require('exceljs');
const fs = require('fs');

const MASTER = '/output/oferty_master.xlsx';
const cfg = JSON.parse(fs.readFileSync('/tmp/scrape_config.json', 'utf-8'));

// --- 1. gather ALL offers from this run's collect files ---
let raw = [];
try {
  for (const f of fs.readdirSync(cfg.collectDir)) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(cfg.collectDir + '/' + f, 'utf-8'));
    if (Array.isArray(d.offers)) raw = raw.concat(d.offers.map(o => ({ ...o, _src: o.source || d.source })));
  }
} catch (e) {}

// within-run dedup by normalized URL only (NOT across tabs)
const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
const seenRun = new Set();
const offers = [];
for (const o of raw) { const u = nurl(o.url); if (!u || seenRun.has(u)) continue; seenRun.add(u); offers.push(o); }

// --- 2. Tracker schema + helpers ---
const COLS = ['ID', 'Data aplikacji', 'Firma', 'Stanowisko', 'Link do oferty', 'Źródło (portal)', 'Wynagrodzenie', 'Lokalizacja / forma', 'CV wysłane', 'Status', 'Data kontaktu / rozmowy', 'Duplikat?', 'Notatki'];
const L = (i) => String.fromCharCode(65 + i);
const SRC = { justjoin: 'JustJoin.it', rocketjobs: 'RocketJobs', nofluffjobs: 'NoFluffJobs', talentdays: 'TalentDays', pracuj: 'Pracuj.pl', theprotocol: 'theProtocol.it', olx: 'OLX', indeed: 'Indeed' };
const salaryStr = (o) => {
  if (o.salary_from != null || o.salary_to != null) {
    return [o.salary_from, o.salary_to].filter(x => x != null).join('–') + (o.salary_currency ? ' ' + o.salary_currency : '');
  }
  return o.salary || '';
};
const lokForma = (o) => {
  if (o.remote === true) return 'Zdalnie';
  const c = (o.city || '').toLowerCase();
  if (c.includes('wroc')) return 'Biuro - Wrocław';
  if (o.city) return 'Biuro - poza Wrocławiem';
  return 'Niejasne';
};

// --- 3. open master (Tracker-based; preserves history + formulas + colors) ---
const wb = new ExcelJS.Workbook();
if (fs.existsSync(MASTER)) await wb.xlsx.readFile(MASTER);

// --- 4. new dated+hour worksheet ---
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
let name = stamp; let k = 1;
while (wb.getWorksheet(name)) { name = `${stamp} (${++k})`; }
const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });

// header (navy fill, bold white)
COLS.forEach((c, i) => {
  const cell = ws.getCell(`${L(i)}1`);
  cell.value = c;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
  cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
  cell.alignment = { vertical: 'middle', wrapText: true };
});

// data rows
offers.forEach((o, ri) => {
  const rn = ri + 2;
  ws.getCell(`A${rn}`).value = ri + 1;
  ws.getCell(`C${rn}`).value = o.company || '';
  ws.getCell(`D${rn}`).value = o.title || '';
  const url = o.url || '';
  if (url) { const lc = ws.getCell(`E${rn}`); lc.value = { text: url, hyperlink: url }; lc.font = { color: { argb: 'FF0563C1' }, underline: true }; }
  ws.getCell(`F${rn}`).value = SRC[o._src || o.source] || o._src || o.source || '';
  ws.getCell(`G${rn}`).value = salaryStr(o);
  ws.getCell(`H${rn}`).value = lokForma(o);
  ws.getCell(`I${rn}`).value = 'Nie wysłane';
  ws.getCell(`J${rn}`).value = 'Do wysłania';
});

// widths (from Tracker)
[6, 14, 20, 24, 28, 16, 16, 18, 16, 16, 18, 18.43, 32].forEach((w, i) => ws.getColumn(i + 1).width = w);

// dropdowns
const lastRow = Math.max(offers.length + 1, 2);
const dv = (col, list) => { for (let r = 2; r <= lastRow; r++) ws.getCell(`${col}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list}"`] }; };
dv('H', 'Zdalnie,Hybrydowo,Biuro - Wrocław,Biuro - poza Wrocławiem,Niejasne');
dv('I', 'Techniczne,Fizyczne/usługowe,Marketingowe,Nie wysłane');
dv('J', 'Do wysłania,Wysłane,Brak odpowiedzi,Odpowiedź - kontakt,Rozmowa zaplanowana,Po rozmowie,Oferta!,Odmowa,Wycofałem się,Przeterminowane');

// conditional formatting (Tracker's color rules) — dxf fill uses bgColor
const mkRules = (col, arr) => arr.map(([val, fill, font]) => ({
  type: 'expression', formulae: [`$${col}2="${val}"`],
  style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: fill }, fgColor: { argb: fill } }, font: { color: { argb: font } } }
}));
ws.addConditionalFormatting({ ref: `J2:J${lastRow}`, rules: mkRules('J', [
  ['Do wysłania', 'FFE5E5E5', 'FF555555'], ['Wysłane', 'FFCFE0F5', 'FF1B4F7A'], ['Brak odpowiedzi', 'FFE5E5E5', 'FF555555'],
  ['Odpowiedź - kontakt', 'FFFCE9B0', 'FF7A5B00'], ['Rozmowa zaplanowana', 'FFFCE9B0', 'FF7A5B00'], ['Po rozmowie', 'FFFCE9B0', 'FF7A5B00'],
  ['Oferta!', 'FFC9E4C5', 'FF1E5631'], ['Odmowa', 'FFF8C7C7', 'FF8A1F1F'], ['Wycofałem się', 'FFE5E5E5', 'FF555555'], ['Przeterminowane', 'FFB0B0B0', 'FF555555']
]) });
ws.addConditionalFormatting({ ref: `I2:I${lastRow}`, rules: mkRules('I', [
  ['Techniczne', 'FFCFE0F5', 'FF1B4F7A'], ['Fizyczne/usługowe', 'FFC9E4C5', 'FF1E5631'], ['Marketingowe', 'FFFCE9B0', 'FF7A5B00'], ['Nie wysłane', 'FFF8C7C7', 'FF8A1F1F']
]) });

const buf = await wb.xlsx.writeBuffer();
fs.writeFileSync(MASTER, buf);
return [{ json: { tab: name, offers: offers.length, master: MASTER } }];
