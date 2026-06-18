// SF Rentals — endpoint PROBE (diagnostic, read-only)
// ---------------------------------------------------------------------------
// Run this in Scriptable to see exactly what each listing endpoint returns
// from your phone's IP. It does NOT push anything to GitHub. It prints a
// report AND copies it to your clipboard so you can paste it back.
//
// Each line: <label>  <httpCode>  <bytes>  <marker>
//   httpCode 0  = network/transport error (see note)
//   marker      = a quick signal (json homes count, JSON-LD present, etc.)
// ---------------------------------------------------------------------------

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function H(extra) {
  return Object.assign(
    { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
    extra || {}
  );
}

async function get(url, extra) {
  const req = new Request(url);
  req.headers = H(extra);
  let text = "",
    err = null;
  try {
    text = await req.loadString();
  } catch (e) {
    err = e.message;
  }
  return { code: (req.response || {}).statusCode || 0, text, err };
}

async function prime(url) {
  await get(url);
}

const lines = [];
function log(label, r, marker) {
  const code = r.err ? `ERR(${r.err})` : r.code;
  lines.push(`${label.padEnd(22)} ${String(code).padEnd(16)} ${String((r.text || "").length).padEnd(7)} ${marker || ""}`);
}

async function main() {
  lines.push("SF Rentals probe @ " + new Date().toISOString());
  lines.push("label                  code             bytes   marker");
  lines.push("-".repeat(64));

  // --- Craigslist RSS ---
  await prime("https://sfbay.craigslist.org/");
  {
    const r = await get(
      "https://sfbay.craigslist.org/search/sfc/apa?min_bedrooms=2&max_bedrooms=2&availabilityMode=0&format=rss",
      { Accept: "application/rss+xml,application/xml,text/xml,*/*", Referer: "https://sfbay.craigslist.org/" }
    );
    const items = (r.text.match(/<item/g) || []).length;
    log("craigslist.rss", r, `items=${items}`);
  }

  // --- Craigslist sapi JSON ---
  {
    const r = await get(
      "https://sapi.craigslist.org/web/v8/postings/search/full?batch=1-0-360-0-0&cc=US&lang=en&searchPath=apa&min_bedrooms=2&max_bedrooms=2&availabilityMode=0",
      { Accept: "application/json,*/*", Referer: "https://sfbay.craigslist.org/", Origin: "https://sfbay.craigslist.org" }
    );
    let n = "?";
    try {
      const d = JSON.parse(r.text);
      n = ((d.data && d.data.items) || []).length;
    } catch (_) {}
    log("craigslist.sapi", r, `items=${n}`);
  }

  // --- Redfin autocomplete ---
  await prime("https://www.redfin.com/");
  {
    const r = await get(
      "https://www.redfin.com/stingray/do/location-autocomplete?location=San%20Francisco%2C%20CA&v=2&al=1",
      { Accept: "application/json,text/plain,*/*", Referer: "https://www.redfin.com/" }
    );
    log("redfin.autocomplete", r, r.text.indexOf("17151") >= 0 ? "has 17151" : "");
  }

  // --- Redfin rentals (hardcoded SF region 17151) ---
  {
    const q =
      "al=1&region_id=17151&region_type=6&num_homes=350&ord=redfin-recommended-asc&page_number=1&uipt=1,2,3,4,7,8&v=8&min_beds=2&max_beds=2";
    const r = await get("https://www.redfin.com/stingray/api/v1/search/rentals?" + q, {
      Accept: "application/json,text/plain,*/*",
      Referer: "https://www.redfin.com/",
    });
    let n = "?";
    try {
      const d = JSON.parse((r.text || "").replace(/^\{\}&&/, ""));
      const homes = d.homes || (d.payload && d.payload.homes) || [];
      n = homes.length;
    } catch (_) {}
    log("redfin.rentals", r, `homes=${n}`);
  }

  // --- Zillow ---
  await prime("https://www.zillow.com/");
  {
    const r = await get("https://www.zillow.com/san-francisco-ca/rentals/?beds=2-2", {
      Accept: "text/html,*/*",
      Referer: "https://www.zillow.com/",
    });
    const nd = r.text.indexOf('id="__NEXT_DATA__"') >= 0;
    const lr = (r.text.match(/"listResults"/g) || []).length;
    log("zillow.search", r, `nextdata=${nd} listResults=${lr}`);
  }

  // --- Trulia ---
  await prime("https://www.trulia.com/");
  {
    const r = await get("https://www.trulia.com/for_rent/San_Francisco,CA/2p_beds/", {
      Accept: "text/html,*/*",
      Referer: "https://www.trulia.com/",
    });
    const nd = r.text.indexOf('id="__NEXT_DATA__"') >= 0;
    log("trulia.search", r, `nextdata=${nd}`);
  }

  // --- Apartments.com ---
  await prime("https://www.apartments.com/");
  {
    const r = await get("https://www.apartments.com/san-francisco-ca/2-bedrooms/", {
      Accept: "text/html,*/*",
      Referer: "https://www.apartments.com/",
    });
    const jsonld = (r.text.match(/application\/ld\+json/g) || []).length;
    const placards = (r.text.match(/class="[^"]*placard/g) || []).length;
    const challenge = /captcha|are you a human|cf-challenge|Just a moment/i.test(r.text);
    log("apartments.search", r, `jsonld=${jsonld} placards=${placards} challenge=${challenge}`);
  }

  const report = lines.join("\n");
  console.log(report);
  Pasteboard.copy(report);

  const a = new Alert();
  a.title = "Probe done — copied to clipboard";
  a.message = report;
  a.addAction("OK");
  await a.present();
  Script.complete();
}

main();
