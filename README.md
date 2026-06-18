# apartments

A free, no-paid-services rental crawler for **2-bedroom apartments in San
Francisco** across Craigslist, Redfin, Zillow, Trulia and Apartments.com, with a
static GitHub Pages dashboard to browse the results.

## Two ways to use it

**1. Scrape from your iPhone (recommended, no computer).** Run the crawler on
your phone with the free Scriptable app — it fetches from your phone's
residential IP (so the sites don't block it) and pushes results to the repo. The
GitHub Pages dashboard then shows them; tap **↻ Refresh** (or a home-screen
widget) to update. See [`scriptable/README.md`](scriptable/README.md).

**2. Scrape all five sites on a computer (power option).** Run the crawler on any
home machine (residential IP) to pull Craigslist/Redfin/Zillow/Trulia/Apartments.com
into `docs/data/listings.json`. See "Local crawler" below.

Either way, the dashboard is a plain static page that reads
`docs/data/listings.json` — no API keys, no server, no live browser fetch.

## How the local crawler works

No GitHub Actions, no servers. You run the crawler on **your own machine**, it
commits `docs/data/listings.json`, and GitHub Pages serves the static dashboard
straight from the branch:

```
your machine:  make crawl  ──▶  python -m scraper.run  ──▶  docs/data/listings.json  ──▶  git push
                                                                                            │
GitHub Pages (Deploy from a branch: main /docs)  ──reads docs/data/listings.json──◀─────────┘
```

- **`scraper/`** — the crawler. One adapter per site, all normalized to a common
  `Listing` shape, merged and deduped by `scraper/pipeline.py`. The HTTP layer
  (`scraper/http.py`) uses `curl_cffi` Chrome impersonation + cookie priming.
- **`docs/`** — the static dashboard served by GitHub Pages: a filterable,
  sortable table with a Refresh button.
- **`scripts/crawl.sh`** / **`Makefile`** — `make crawl` runs the crawler and
  pushes the results so the live page updates.

## ⚠️ Why it runs locally (read this)

**Listing sites block datacenter/cloud IPs.** We tested crawling from GitHub
Actions with plain requests, better parsers, and full Chrome TLS impersonation —
all five sources returned `403` every time, because anti-bot vendors blanket-block
shared cloud IP ranges (GitHub, AWS, etc.) at the IP-reputation layer, before the
request is even evaluated. No free client-side trick changes that.

From a **residential IP** (your home connection), the impersonation + cookie
priming in `scraper/http.py` gives a real chance:

| Source | From cloud/CI IP | From your residential IP |
|---|---|---|
| **Craigslist** | ❌ 403 | ✅ Usually works (RSS feed) |
| **Redfin** | ❌ 403 | ✅ Usually works (internal JSON API) |
| **Zillow** | ❌ 403 | ⚠️ Often works; PerimeterX may still challenge |
| **Trulia** | ❌ 403 | ⚠️ Often works; PerimeterX may still challenge |
| **Apartments.com** | ❌ 403 | ⚠️ Often works (Cloudflare) |

Every adapter degrades gracefully: when one source is blocked it logs it, the run
continues, and that source's previous listings are kept and marked `stale`
instead of vanishing.

This tool is for **personal** apartment hunting. Scraping these sites is against
their terms of service; keep request volume low and don't redistribute data.

## Quick start

```bash
make install          # pip install -r requirements.txt
make crawl            # run the crawler (from home!) and push results
make serve            # preview the dashboard at http://localhost:8000
make test             # run the unit tests (parsing logic, no network)
```

`make crawl` only commits/pushes when the listings actually changed. To update
the live site on a schedule, add a cron entry on your machine, e.g. hourly:

```cron
0 * * * * cd /path/to/apartments && /usr/bin/make crawl >> /tmp/crawl.log 2>&1
```

Tune the search in `scraper/config.py`, or via env vars: `CITY`, `STATE`,
`MIN_BEDROOMS`, `MAX_BEDROOMS`, `MIN_PRICE`, `MAX_PRICE`.

## Enable the GitHub Pages dashboard (one-time)

In the repo: **Settings → Pages → Build and deployment → Source: _Deploy from a
branch_**, then choose branch **`main`** and folder **`/docs`**. Save. Your site
appears at `https://<owner>.github.io/<repo>/`. After that, every `make crawl`
push updates the page automatically — no Actions involved.

## Adding a site

Create `scraper/adapters/<site>.py` exposing `name` and
`search(criteria) -> list[Listing]`, then add it to the list in
`scraper/adapters/__init__.py`. The pipeline, dashboard and dedupe handle the
rest.
