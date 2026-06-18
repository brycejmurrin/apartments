// Cloudflare Worker — listing-site reachability probe
// ---------------------------------------------------------------------------
// Deploy this free (workers.dev) and open its URL in any browser. It fetches
// each listing source FROM CLOUDFLARE'S IPs and reports the HTTP status, byte
// count and a quick data marker, so we know empirically whether a free
// server-side (datacenter-IP) crawler could work — or whether those sites
// block Cloudflare the same way they block GitHub Actions.
//
// Deploy: see worker/README.md (Cloudflare dashboard → Create Worker → paste).
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function headers(extra) {
  return Object.assign(
    {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    extra || {}
  );
}

async function probe(label, url, extra, marker) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: headers(extra), redirect: "follow" });
    const text = await r.text();
    let mark = "";
    try {
      mark = marker ? marker(text) : "";
    } catch (e) {
      mark = "marker-err";
    }
    return {
      label,
      status: r.status,
      bytes: text.length,
      ms: Date.now() - t0,
      server: r.headers.get("server") || "",
      marker: mark,
    };
  } catch (e) {
    return { label, status: 0, error: String(e), ms: Date.now() - t0 };
  }
}

export default {
  async fetch(request) {
    const clHost = "https://sfbay.craigslist.org";

    const tasks = [
      probe(
        "craigslist.sapi",
        "https://sapi.craigslist.org/web/v8/postings/search/full?batch=1-0-360-0-0&cc=US&lang=en&searchPath=apa&availabilityMode=0",
        { Accept: "application/json, text/plain, */*", Referer: clHost + "/", Origin: clHost },
        (t) => {
          const d = JSON.parse(t);
          return "items=" + ((d.data && d.data.items) || []).length;
        }
      ),
      probe(
        "craigslist.rss",
        clHost + "/search/sfc/apa?availabilityMode=0&format=rss",
        { Accept: "application/rss+xml,application/xml,text/xml,*/*", Referer: clHost + "/" },
        (t) => "items=" + (t.match(/<item/g) || []).length
      ),
      probe(
        "redfin.autocomplete",
        "https://www.redfin.com/stingray/do/location-autocomplete?location=San%20Francisco%2C%20CA&v=2&al=1",
        { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" },
        (t) => (t.indexOf("17151") >= 0 ? "has 17151" : "no-region")
      ),
      probe(
        "redfin.rentals",
        "https://www.redfin.com/stingray/api/v1/search/rentals?al=1&region_id=17151&region_type=6&num_homes=350&ord=redfin-recommended-asc&page_number=1&uipt=1,2,3,4,7,8&v=8",
        { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" },
        (t) => {
          const d = JSON.parse(t.replace(/^\{\}&&/, ""));
          return "homes=" + ((d.homes || (d.payload && d.payload.homes) || []).length);
        }
      ),
      probe(
        "zillow",
        "https://www.zillow.com/san-francisco-ca/rentals/",
        { Referer: "https://www.zillow.com/" },
        (t) =>
          (t.indexOf("__NEXT_DATA__") >= 0 ? "nextdata " : "no-nextdata ") +
          "listResults=" +
          (t.match(/"listResults"/g) || []).length
      ),
      probe(
        "trulia",
        "https://www.trulia.com/for_rent/San_Francisco,CA/",
        { Referer: "https://www.trulia.com/" },
        (t) => (t.indexOf("__NEXT_DATA__") >= 0 ? "nextdata" : "no-nextdata")
      ),
      probe(
        "apartments",
        "https://www.apartments.com/san-francisco-ca/",
        { Referer: "https://www.apartments.com/" },
        (t) =>
          "jsonld=" +
          (t.match(/application\/ld\+json/g) || []).length +
          " placards=" +
          (t.match(/class="[^"]*placard/g) || []).length
      ),
    ];

    const results = await Promise.all(tasks);
    const ok = results.filter((r) => r.status === 200 && !/=0\b|no-/.test(r.marker || "")).length;

    const body = JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        cloudflare_colo: (request.cf && request.cf.colo) || null,
        summary: `${ok}/${results.length} sources returned usable data`,
        note:
          "status 403 / tiny bytes = blocked. A server-side crawler is viable " +
          "only for sources showing 200 + a non-zero marker here.",
        results,
      },
      null,
      2
    );

    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  },
};
