# n8n Job Board Scraper 🇵🇱

> A self-hosted, block-resistant automation that scrapes **8 Polish job boards** in one click — and, new in **v3**, captures each offer's **complete content** (full description, skills, dates). Results land in two places: a colour-coded Excel **application tracker** for me, and machine-readable **JSON exports** that feed a real **AI filtering step**. Excel for humans, JSON for the AI.

<p>
  <img alt="n8n" src="https://img.shields.io/badge/built%20with-n8n-EA4B71?logo=n8n&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white">
  <img alt="Puppeteer" src="https://img.shields.io/badge/Puppeteer-Browserless-40B5A4?logo=puppeteer&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
</p>

Checking eight job sites by hand every morning is slow and demoralising. So I built a one-click pipeline that visits them all using each site's own filters (internships / *staż* / *praktyki*). Version 2 only grabbed the surface data — title, company, salary, link. **Version 3 fetches the whole offer**, exports everything as JSON, and hands that JSON to Claude Code, which filters the offers against my career profile and writes a shortlist back into the tracker workbook. Everything runs **locally** — no cloud, no accounts, no data leaving my laptop.

---

## ✨ Features

- **8 portals, one run — 5 with full descriptions** — JustJoin.it · RocketJobs · NoFluffJobs · TalentDays · OLX (full offer content) plus theProtocol · Pracuj.pl · Indeed (list data only — see [Limitations](#️-limitations--responsible-use)).
- **Filter-based, not keyword-guessing** — uses each site's *own* internship/staż filter so nothing relevant is missed. Prefer full control? Paste your own filtered URL straight from the browser and the scraper reproduces it exactly.
- **Block-resistant by design** — sites are scraped **one at a time** with randomised, human-like delays; each uses the lightest viable strategy (hidden JSON API where one exists, a real headless browser where needed) and a **stop-on-block circuit breaker** so a soft block never escalates to a ban.
- **Full offers, gently fetched** — the new detail phase pulls each offer's complete content with a single same-origin `fetch()` inside the already-open browser page (anti-bot cookies ride along — never a new page load per offer), with jittered 0.7–3 s pauses between offers.
- **Description cache** — full descriptions are cached in `output/desc_cache.json` (pruned after 60 days), so re-runs skip both the fetch *and* the politeness delay. Fast for me, gentle on the portals.
- **JSON exports built for machines** — every run dumps the complete offer records (descriptions included) to `output/full/`, and each record carries a `url_key` — the same normalised-URL key used for dedup — so AI results join 1:1 back to tracker rows.
- **One master Excel, a new dated tab per run** — a 13-column tracker with a **Status dropdown** (`Do wysłania` / `Wysłane` / `Rozmowa zaplanowana` / `Oferta!` / `Odmowa` …), colour-coded rows, clickable offer links and a frozen header.
- **History-safe** — new tabs are *appended*; previous runs and your notes are never overwritten.
- **A real AI filtering step** — after each run, Claude Code reads the JSON export, filters offers against my career profile, dedupes against everything I've already applied to, and writes an **AI-filtered shortlist** sheet into the same workbook. See [🤖 AI filtering step](#-ai-filtering-step).

## 🖼️ Screenshots

**The workflow** — Config → 8 scrapers → Excel Writer, one browser at a time (the v3 detail phase lives inside the scraper nodes, so the graph is unchanged):

![Workflow](docs/screenshots/workflow.png)

**One config node controls everything** — edit the filters or paste a site URL:

![Config](docs/screenshots/config.png)

**The human-facing output** — a colour-coded Excel tracker with status dropdowns and clickable links (the AI reads the JSON export instead):

![Excel output](docs/screenshots/excel-output.png)

## 🏗️ How it works

```
        Manual / scheduled trigger
                 │
          ┌──────▼───────┐   ← edit ONE node to change what you search:
          │ Konfiguracja │     keyword · category · location · radius
          └──────┬───────┘     (also prunes the 60-day description cache)
                 │  writes /tmp/scrape_config.json
   ┌─────────────▼──────────────────────────────────────────┐
   │  8 scrapers, chained — one browser at a time (gentle)  │
   │  JustJoin → RocketJobs → NoFluff → TalentDays →        │
   │  Pracuj → theProtocol → OLX → Indeed                   │
   │  each: random delays · block-detection · common schema │
   │                                                        │
   │  NEW detail phase on 5 portals (JustJoin, RocketJobs,  │
   │  NoFluff, TalentDays, OLX): one same-origin fetch()    │
   │  per offer pulls the FULL content — description,       │
   │  skills, dates — with jittered pauses + a cache        │
   └─────────────┬──────────────────────────────────────────┘
                 │  each writes its offers to /tmp/scrape_run/*.json
          ┌──────▼───────┐ → output/oferty_master.xlsx           (dated tab — for humans)
          │ Excel Writer │ → output/full/oferty_full_<date>.json (full records — for the AI)
          └──────┬───────┘ → output/oferty_full_latest.json      (rolling copy of the above)
                 │
    ╌╌╌╌╌╌╌╌╌╌╌╌╌▼╌╌╌╌╌╌╌╌╌╌╌╌╌  (runs OUTSIDE n8n)
      Claude Code reads oferty_full_latest.json, filters the
      offers against my career profile, and writes a formatted
      "AI-filtered" sheet back into the same workbook
```

Each portal needs a different technique — this is where most of the engineering went:

| Portal | Access method (list) | Full description (v3) | Anti-bot handling |
|---|---|---|---|
| **JustJoin.it / RocketJobs** | Hidden `v2/user-panel/offers` JSON API, filtered server-side by city + employment type | `ld+json` JobPosting block on each SSR offer page | none needed (public API) |
| **NoFluffJobs** | JSON API called from within a real browser context | portal's own `GET /api/posting/{slug}` detail API | cookies via real browser |
| **TalentDays** | JSON-RPC `jobOffers/list` API with cursor pagination | portal's own `POST /api/rpc/jobOffers/get` detail API | — |
| **Pracuj.pl / theProtocol** | Real headless browser (Puppeteer): DOM parsing + URL pagination | — (list-only: heavy Cloudflare) | Cloudflare-aware; slow, human-like pacing |
| **OLX** | Real browser: card DOM + numbered pagination | `GET /api/v1/offers/{id}` — also backfills company, contract type, experience level & salary that OLX cards don't show | DataDome-aware: gradual scrolling, randomised waits |
| **Indeed** | Real browser (best-effort) | — (list-only: Cloudflare + CAPTCHA) | frequently blocks; handled gracefully |

> Design note: the safest scrape is the lightest one. Where a site exposes a clean JSON feed, the tool opens only a minimal browser page (to inherit real cookies), then calls that API directly — reserving heavy DOM scraping for the sites that genuinely require it. The same idea drives the v3 detail phase's gentle in-page fetches.

The detail phase is robust by contract: a per-offer failure just records a `detail_error` on that offer, an HTTP 403/429 or block signal stops the detail phase immediately (keeping everything gathered so far), per-offer fetch timeouts and a consecutive-failure abort keep a slow portal from hanging the run — and even if the whole detail phase fails, the run still produces v2-equivalent list output. The full engineering contract it was built against (cache key, one-evaluate-per-fetch rule, abort semantics) lives in [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

## 🧰 Tech stack

**n8n** (workflow orchestration) · **Puppeteer** via **Browserless** (headless Chrome) · **ExcelJS** (styled `.xlsx` with data-validation dropdowns & conditional formatting) · **Docker Compose** · **Node.js** — plus **Claude Code** as the downstream filtering agent.

## 🚀 Setup — step by step

**Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

```bash
# 1. Clone
git clone https://github.com/fluxsiarski/n8n-job-scraper.git
cd n8n-job-scraper

# 2. Start the stack + install the required modules (one command)
./scripts/setup.sh
```

<details>
<summary>…or do step 2 manually</summary>

```bash
docker compose up -d
# install the Puppeteer node + ExcelJS into n8n's custom-nodes folder:
docker exec "$(docker compose ps -q n8n)" sh -c \
  'mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm init -y >/dev/null 2>&1; npm install n8n-nodes-puppeteer exceljs'
docker compose restart n8n
```
</details>

3. Open **http://localhost:5678** and create your local owner account (stays on your machine).
4. **Import the workflow:** *Workflows → Import from File → `workflow/Job_Scraper_v3.json`*. (`workflow/Job_Scraper_v2.json` stays in the repo as the legacy list-only version.)
5. Open the **Konfiguracja** node → set your filters (or paste site URLs) → **Save**.
6. Click **Execute workflow**. After a few minutes you'll find your offers in **`output/oferty_master.xlsx`** (a fresh `DD.MM.YYYY HH-MM` tab) **and** the full records — descriptions included — in **`output/full/oferty_full_<date>.json`** / **`output/oferty_full_latest.json`**.

Stop the stack any time with `docker compose down`.

## ⚙️ Configuration

Everything lives in the single **Konfiguracja** node:

```js
// 1) Defaults (used when a URL below is empty)
const search = { keyword: 'staż', category: 'internship', location: 'Wrocław', radius: 30 };

// 2) Paste a filtered URL from the browser to take full control of a site
const urls = {
  justjoin:    'https://justjoin.it/job-offers/wroclaw?employment-types=internship',
  rocketjobs:  'https://rocketjobs.pl/oferty-pracy/wroclaw?typ-umowy=umowa-o-staz',
  talentdays:  'https://talentdays.pl/oferty-pracy-i-stazy/wroclaw?doswiadczenie=ZERO',
  olx: '', pracuj: '', theprotocol: '', indeed: ''   // '' = auto-build from defaults
};

// NEW in v3: where full descriptions are cached between runs
const cfg = { ...search, urls, collectDir, descCache: '/output/desc_cache.json' };
```

The node also prunes cache entries older than **60 days** on every run — and cache errors can never break a scrape (everything is wrapped in try/catch). The `src/` folder mirrors the code of each workflow node (Config, the 8 scrapers, the Excel writer) as readable, standalone files for review.

## 📤 Output

**1. The Excel tracker (for humans)** — unchanged from v2. One master workbook, one tab per run (`DD.MM.YYYY HH-MM`), 13 columns:

`ID · Data aplikacji · Firma · Stanowisko · Link · Źródło · Wynagrodzenie · Lokalizacja/forma · CV wysłane · Status · Data kontaktu · Duplikat? · Notatki`

- **Status** and **CV wysłane** are real Excel dropdowns; rows recolour automatically (green = offer, red = rejected, blue = applied, …).
- Links are clickable; the header is frozen; gridlines off for a clean look.
- Descriptions are deliberately **never** written to Excel — a cell caps out at 32,767 characters and the file would bloat fast. That's what the JSON is for.

**2. The JSON exports (for the AI)** — every run writes the complete offer records to `output/full/oferty_full_<YYYY-MM-DD_HH-MM>.json`, plus a rolling `output/oferty_full_latest.json` that always holds the newest run. A record looks like this (shortened):

```json
{
  "source": "nofluffjobs",
  "title": "Junior Data Analyst (staż)",
  "company": "Acme Sp. z o.o.",
  "city": "Wrocław",
  "remote": false,
  "salary_from": 4500,
  "salary_to": 6000,
  "salary_currency": "PLN",
  "url": "https://nofluffjobs.com/pl/job/junior-data-analyst-acme-wroclaw",
  "url_key": "https://nofluffjobs.com/pl/job/junior-data-analyst-acme-wroclaw",
  "skills_required": ["SQL", "Excel", "Python"],
  "description": "OPIS:\nAcme szuka stażysty do zespołu danych…\n\nWYMAGANIA:\n…"
}
```

- `description` is full plain text (HTML stripped), capped at 15,000 characters; where a portal provides structured sections (e.g. NoFluffJobs), they're joined with UPPERCASE Polish labels (`OPIS:`, `WYMAGANIA:`, …). It's `null` or missing when a portal couldn't provide it.
- `url_key` is the normalised-URL dedup key — the same one the Excel Writer uses — so AI results join 1:1 back to tracker rows.
- Extra fields appear where a portal provides them structurally: `skills_required`/`skills_nice` (JustJoin, NoFluffJobs), `valid_through` (RocketJobs), `apply_url` + `expires_at` (TalentDays). If a single offer's detail fetch failed, it carries a short `detail_error` instead of failing the run.

## 🤖 AI filtering step

This is the payoff of v3 — and it runs **outside n8n**, after the scrape:

1. I open **Claude Code** with two local files: a **career-profile** file (who I am, what I can do, which CV variants I have) and a reusable **filtering prompt**.
2. Claude reads `output/oferty_full_latest.json` and filters the offers against the profile: hard exclusion rules first, then a dedup against **every offer I've already applied to** anywhere in the workbook.
3. For each surviving offer it scores the fit and picks **which CV variant to send**.
4. Finally it writes a new, formatted **"AI-filtered"** sheet into the same `oferty_master.xlsx` — thanks to `url_key`, every AI row links straight back to its tracker row.

The profile file and the prompt contain personal data, so they are **not** in this repo — they stay local and private. But the setup is fully reproducible: write your own profile file and prompt, point Claude Code at `oferty_full_latest.json`, and you get the same shortlist workflow.

## ⚠️ Limitations & responsible use

- **Indeed** is behind Cloudflare + CAPTCHA and usually returns nothing from a headless browser — it's best-effort and the run simply skips it.
- **Pracuj.pl, theProtocol and Indeed are list-only** — fetching every offer page on these Cloudflare-heavy sites would get the scraper blocked, so their offers have no `description` in the JSON export.
- **OLX** loads fine, but its programmatic filter value is broad — paste your own filtered URL for precise results.
- Run it gently, from a normal residential connection, and respect each portal's Terms of Service. This is a personal productivity tool, not a bulk-harvesting service.

## 🗺️ Roadmap

- [x] Profile-matched **shortlist** tab generated by an LLM step (dedupe + skip already-applied) — done, see [🤖 AI filtering step](#-ai-filtering-step).
- [ ] Optional ingestion of job-alert emails for the hardest sites.
- [ ] Scheduled runs with a daily summary notification.

## 🔗 Related

Companion **Chrome extension** (same portals, browser-side) — see my [GitHub profile](https://github.com/fluxsiarski). This n8n project automates what that extension does manually.

## 📄 License

[MIT](LICENSE) © 2026 Wiktor Zieliński · built as a personal job-hunting automation.
