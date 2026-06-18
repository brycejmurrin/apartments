# Cloudflare Worker probe — can a free server-side crawler reach the sites?

Before building a Worker that scrapes on a schedule, we need to know whether the
listing sites block **Cloudflare's IPs** the way they block GitHub Actions. This
probe answers that empirically: it fetches all five sources from Cloudflare's
edge and reports the status + whether real data came back.

## Deploy it (all on the phone, ~3 minutes, free)

1. Go to **dash.cloudflare.com** → sign up / log in (free, no card).
2. Left sidebar → **Workers & Pages** → **Create application** → **Create Worker**.
3. Give it a name (e.g. `sf-probe`) → **Deploy** (it deploys a hello-world).
4. Tap **Edit code**. Select all the starter code and delete it.
5. Open [`worker/probe.js`](probe.js) in this repo, tap **Raw**, copy everything,
   and paste it into the Cloudflare editor.
6. Tap **Deploy** (top right).
7. Tap the worker's URL — `https://sf-probe.<your-subdomain>.workers.dev` — to
   open it in your browser. It runs the probe and shows a JSON report.

## Reading the result

```json
{
  "summary": "2/7 sources returned usable data",
  "cloudflare_colo": "SJC",
  "results": [
    { "label": "craigslist.sapi", "status": 200, "bytes": 193507, "marker": "items=360" },
    { "label": "redfin.rentals",  "status": 403, "bytes": 919,    "marker": "" },
    ...
  ]
}
```

- **status 200 + a non-zero marker** (`items=360`, `homes=350`, `nextdata`,
  `placards=25`) → that source is reachable from Cloudflare; a free Worker
  cron-crawler could scrape it server-side, no phone needed.
- **status 403 / tiny byte count / `no-…` marker** → blocked at the IP layer;
  a Worker can't get it (same wall as GitHub Actions).

Copy the JSON back here and we'll decide: if enough sources are green, I'll turn
this into a scheduled Worker that scrapes and commits `docs/data/listings.json`
automatically — fully page-only, no Scriptable. If they're red, that confirms a
residential device (Scriptable / a home computer) is the only free option for
those sources.

## Note

This only reads public search endpoints, runs on demand, and stores nothing.
Keep usage light — it's a diagnostic.
