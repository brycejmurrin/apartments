# apartments

A free, no-paid-services rental crawler for **2-bedroom apartments in San
Francisco** across Craigslist, Redfin, Zillow, Trulia and Apartments.com — with
a GitHub Pages dashboard to view results and launch a fresh crawl.

## How it works

GitHub Pages is static-only, so it can't run a crawler itself. The design works
around that:

```
GitHub Pages site  ──"Run crawler" (workflow_dispatch via GitHub API)──▶  GitHub Actions
       ▲                                                                        │
       │                                                                  runs python -m scraper.run
       └──────────── reads docs/data/listings.json ◀── commits results ──────────┘
```

- **`scraper/`** — Python crawler. One adapter per site, all normalized to a
  common `Listing` shape, merged and deduped by `scraper/pipeline.py`.
- **`.github/workflows/crawl.yml`** — runs the crawler every 6 hours and on
  demand, committing `docs/data/listings.json`.
- **`docs/`** — the static dashboard served by GitHub Pages: a filterable,
  sortable table plus a **Run crawler** button and a settings panel.

## ⚠️ The anti-bot reality (read this)

These sites are *not* equally scrapable, and no amount of free tooling changes
that:

| Source | Expected result from GitHub Actions (datacenter IP) |
|---|---|
| **Craigslist** | ✅ Usually works (RSS feed) |
| **Redfin** | ✅ Usually works (internal JSON API) |
| **Zillow** | ❌ Usually blocked (PerimeterX); needs a residential proxy |
| **Trulia** | ❌ Usually blocked (same stack as Zillow) |
| **Apartments.com** | ❌ Often blocked (Cloudflare) |

The three hard sites are implemented best-effort and **degrade gracefully** —
when blocked they log it, the run continues, and the source's previous listings
are kept and marked `stale` instead of vanishing. To actually get data from
them for free you'd run the crawler from a **residential IP** (e.g. your own
machine) rather than CI, or route `scraper/http.py` through a proxy. The same
`python -m scraper.run` works locally and from Actions.

This tool is for **personal** apartment hunting. Scraping these sites is against
their terms of service; keep request volume low and don't redistribute data.

## Run it locally

```bash
pip install -r requirements.txt
python -m scraper.run          # writes docs/data/listings.json
python -m http.server -d docs  # then open http://localhost:8000
```

Tune the search in `scraper/config.py`, or via env vars:
`CITY`, `STATE`, `MIN_BEDROOMS`, `MAX_BEDROOMS`, `MIN_PRICE`, `MAX_PRICE`.

## Set up the GitHub Pages dashboard

1. **Enable Pages**: repo **Settings → Pages → Build from a branch**, and pick
   this branch with the **`/docs`** folder. Your site appears at
   `https://<owner>.github.io/<repo>/`.
2. **Launch crawls from the page**: click **⚙ Settings** on the dashboard and
   paste a GitHub **fine-grained personal access token** scoped to this repo
   with **Actions: Read and write**. It's stored only in your browser's
   localStorage and sent only to `api.github.com`. The **▶ Run crawler** button
   then triggers the workflow and polls until it finishes.
   - No token? Use the **Open Actions tab** link and run the workflow manually —
     the schedule also refreshes data automatically every 6 hours.

## Adding a site

Create `scraper/adapters/<site>.py` exposing `name` and
`search(criteria) -> list[Listing]`, then add it to the list in
`scraper/adapters/__init__.py`. The pipeline, dashboard and dedupe handle the
rest.

## Tests

```bash
python -m pytest -q   # parsing logic, no network required
```
