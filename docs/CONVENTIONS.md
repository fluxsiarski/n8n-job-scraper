# V3 Build Conventions — full-description upgrade (Stage 1)

These rules are MANDATORY for every rewritten node script. The scripts run inside
n8n's `n8n-nodes-puppeteer` (runCustomScript) or `Code` node sandbox.

## Sandbox constraints (violating these = broken node)
- Only `require('fs')` and `require('path')` are allowed (NODE_FUNCTION_ALLOW_BUILTIN=fs,path). Code node may also require('exceljs').
- `URLSearchParams` is NOT available in the node sandbox. Do not use it anywhere
  (not even inside page.evaluate — build query strings by hand for consistency).
- Puppeteer nodes: `$browser` is provided; script body is async; must end with
  `return [{ json: { ... } }]`.
- CRITICAL — protocolTimeout: a single `page.evaluate(...)` must NEVER run longer
  than ~60 seconds (Puppeteer kills it at 180s). Therefore: ONE evaluate call per
  detail fetch, and all sleeps/delays happen in the Node context BETWEEN evaluate
  calls — never `setTimeout` loops inside one big evaluate spanning many offers.
  (The existing short list-API loops inside one evaluate are fine — leave them.)

## Preserve all existing behavior (regression = failure)
- Keep: config loading from /tmp/scrape_config.json, paste-URL override parsing,
  list pagination, UA/viewport, pre-nav jitter, BLOCK-signal detection, the
  collect-file name and shape `{source, count, offers}`, page.close(), and the
  return-status shape (extend it, don't break it).
- The offer objects keep ALL current fields; new fields are ADDED.

## New offer fields
- `description`: plain text (HTML stripped), sections separated by `\n\n`, with
  UPPERCASE Polish section labels when the portal provides structured sections
  (e.g. `OPIS:`, `OBOWIĄZKI:`, `WYMAGANIA:`, `MILE WIDZIANE:`, `BENEFITY:`).
  Hard cap: 15000 chars (`.slice(0, 15000)`). `null` if unavailable.
- `skills_required` / `skills_nice`: arrays of strings — ONLY when the portal
  provides them structurally (JustJoin flight data, NoFluffJobs requirements).
  Omit the keys entirely otherwise.
- `detail_error`: short string when that offer's detail fetch failed (omit when OK).

## Description cache (makes re-runs fast)
- Path comes from `cfg.descCache` (Konfiguracja sets it to '/output/desc_cache.json').
  Fallback if missing: `const CACHE_PATH = cfg.descCache || '/output/desc_cache.json';`
- Key: `nurl(offer.url)` where nurl is EXACTLY:
  `const nurl = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase();`
  (must match Excel Writer's dedup key so everything joins 1:1).
- Format: `{ "<key>": { "t": <epoch ms>, "f": { "description": "...", ...other new fields } } }`
- Node behavior:
  1. Read cache once at start (try/catch → `{}` on any error).
  2. For each offer: on cache hit → `Object.assign(offer, hit.f)` and count it as
     cached; on miss → fetch detail, build the fields object, assign to offer,
     and store `{ t: Date.now(), f: fields }` — but ONLY cache entries whose
     description is a non-empty string (never cache failures).
  3. Write cache once at the end (try/catch, best-effort). Portal nodes run
     sequentially in the workflow, so read-modify-write is safe.

## Politeness / anti-block during detail phase
- Jittered delay between detail fetches (in Node context): JustJoin 800–2500 ms,
  RocketJobs 1500–3000 ms, NoFluffJobs 800–2000 ms, TalentDays 700–1700 ms,
  OLX 1500–3000 ms.
- Check every fetched HTML/text body against the existing BLOCK signals list.
  On block signal or HTTP 403/429: set `detailAborted = true`, STOP the detail
  phase immediately, but KEEP all list data and everything fetched so far.
- Per-offer failures (non-403/429): set `detail_error`, continue with next offer.
- Skip detail fetch for offers with no `url`.

## Detail fetches
- Always via `fetch()` INSIDE `page.evaluate` on the already-open portal page
  (same-origin — cookies ride along). Never `page.goto` per offer in Stage 1.
- HTML→text stripping happens inside the browser context using DOMParser:
  `new DOMParser().parseFromString(html, 'text/html').body.innerText` (or
  textContent), then normalize whitespace (`replace(/\n{3,}/g,'\n\n').trim()`)
  in either context.

## Return status (extend)
`return [{ json: { site, count, blocked, details_fetched, details_cached, detail_errors, detailAborted } }]`
(numbers; detailAborted boolean).

## Style
- Match the existing file's comment style (Polish/English mix is fine) and
  formatting. Keep the file self-contained. No TODOs left behind.
