// SF 2-Bedroom Rentals — Scriptable scraper
// ---------------------------------------------------------------------------
// Runs on your iPhone (Scriptable app). Uses the phone's residential IP +
// native HTTP to fetch listing sites, then pushes results to your GitHub repo
// via the API so the GitHub Pages dashboard shows them.
//
// Tap to run from the app, a home-screen widget, or an iOS Shortcut.
// See scriptable/README.md for one-time setup.
// ---------------------------------------------------------------------------

const OWNER = "brycejmurrin";
const REPO = "apartments";
const BRANCH = "main";
const FILE_PATH = "docs/data/listings.json";

const CRITERIA = {
  city: "San Francisco",
  state: "CA",
  minBeds: 2,
  maxBeds: 2,
  clSite: "sfbay", // Craigslist site
  clArea: "sfc",   // Craigslist area (San Francisco city)
};

// Full browser-like headers. extra = overrides/additions.
function headers(extra) {
  return Object.assign(
    {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
    },
    extra || {}
  );
}

// Scriptable shares cookies across Request() calls within the same script run
// (WebKit cookie store). Prime a domain by loading its homepage so the session
// cookie is set before hitting the real API endpoint.
async function prime(url) {
  try {
    const r = new Request(url);
    r.headers = headers();
    await r.loadString();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .trim();
}
function parsePrice(text) {
  const m = (text || "").match(/\$\s*([\d,]+)/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ""), 10);
  return v >= 200 && v <= 100000 ? v : null;
}
function parseBeds(text) {
  const m = (text || "").match(/(\d+(?:\.\d+)?)\s*br/i);
  return m ? parseFloat(m[1]) : null;
}
function parseSqft(text) {
  const m = (text || "").match(/(\d[\d,]*)\s*ft2/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}
function parseHood(text) {
  const m = (text || "").trim().match(/\(([^()]+)\)\s*$/);
  return m ? m[1].trim() : null;
}
function idFromUrl(url) {
  const parts = url.replace(/\/+$/, "").split("/");
  return (parts[parts.length - 1] || url).replace(/\.html$/, "");
}
function listing(o) {
  return {
    source: o.source,
    source_id: String(o.source_id),
    url: o.url,
    title: o.title || "",
    price: o.price ?? null,
    beds: o.beds ?? null,
    baths: o.baths ?? null,
    sqft: o.sqft ?? null,
    address: o.address ?? null,
    neighborhood: o.neighborhood ?? null,
    lat: o.lat ?? null,
    lng: o.lng ?? null,
    posted_at: o.posted_at ?? null,
    scraped_at: new Date().toISOString(),
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// Source: Craigslist (RSS)
// ---------------------------------------------------------------------------
async function scrapeCraigslist() {
  const base = `https://${CRITERIA.clSite}.craigslist.org`;
  await prime(base + "/");

  const url =
    `${base}/search/${CRITERIA.clArea}/apa` +
    `?min_bedrooms=${CRITERIA.minBeds}&max_bedrooms=${CRITERIA.maxBeds}` +
    `&availabilityMode=0&format=rss`;
  const req = new Request(url);
  req.headers = headers({ Referer: base + "/" });

  let xml;
  try {
    xml = await req.loadString();
  } catch (e) {
    throw new Error("CL network: " + e.message);
  }
  const code = (req.response || {}).statusCode;
  if (code && code >= 400) throw new Error("CL HTTP " + code);

  const out = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of items) {
    const link =
      (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ||
      (block.match(/rdf:about="([^"]+)"/) || [])[1] ||
      "";
    if (!link) continue;
    const title = decodeEntities(
      (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""
    );
    const date = (block.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1] || null;
    out.push(
      listing({
        source: "craigslist",
        source_id: idFromUrl(link.trim()),
        url: link.trim(),
        title,
        price: parsePrice(title),
        beds: parseBeds(title),
        sqft: parseSqft(title),
        neighborhood: parseHood(title),
        posted_at: date,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source: Redfin (internal "stingray" JSON API)
// ---------------------------------------------------------------------------
function stripRedfin(t) {
  return t.replace(/^\{\}&&/, "");
}

async function redfinRegion() {
  const req = new Request(
    "https://www.redfin.com/stingray/do/location-autocomplete?location=" +
      encodeURIComponent(`${CRITERIA.city}, ${CRITERIA.state}`) +
      "&v=2"
  );
  req.headers = headers({
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.redfin.com/",
  });
  let txt;
  try {
    txt = await req.loadString();
  } catch (e) {
    throw new Error("Redfin region network: " + e.message);
  }
  const code = (req.response || {}).statusCode;
  if (code && code >= 400) throw new Error("Redfin region HTTP " + code);
  const data = JSON.parse(stripRedfin(txt));
  for (const sec of (data.payload && data.payload.sections) || []) {
    for (const row of sec.rows || []) {
      if (String(row.type) === "6" && row.id) {
        return row.id.split("_").pop();
      }
    }
  }
  return null;
}

async function scrapeRedfin() {
  await prime("https://www.redfin.com/");

  const regionId = await redfinRegion();
  if (!regionId) throw new Error("Redfin: no region ID");

  const q = [
    "al=1",
    `region_id=${regionId}`,
    "region_type=6",
    "num_homes=350",
    "ord=redfin-recommended-asc",
    "page_number=1",
    "uipt=1,2,3,4,7,8",
    "v=8",
    `min_beds=${CRITERIA.minBeds}`,
    `max_beds=${CRITERIA.maxBeds}`,
  ].join("&");

  const req = new Request(
    "https://www.redfin.com/stingray/api/v1/search/rentals?" + q
  );
  req.headers = headers({
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.redfin.com/",
  });

  let txt;
  try {
    txt = await req.loadString();
  } catch (e) {
    throw new Error("Redfin rentals network: " + e.message);
  }
  const code = (req.response || {}).statusCode;
  if (code && code >= 400) throw new Error("Redfin HTTP " + code);

  const data = JSON.parse(stripRedfin(txt));
  const homes = data.homes || (data.payload && data.payload.homes) || [];

  const out = [];
  for (const h of homes) {
    const id = h.rentalId || h.propertyId || h.listingId;
    if (!id) continue;
    const rent = h.rentPriceRange || {};
    const price = rent.min || rent.max || null;
    const street = (h.streetLine && h.streetLine.value) || h.name || "Redfin rental";
    out.push(
      listing({
        source: "redfin",
        source_id: id,
        url: h.url ? "https://www.redfin.com" + h.url : "",
        title: street,
        price: typeof price === "number" ? price : null,
        beds: typeof h.beds === "number" ? h.beds : null,
        baths: typeof h.baths === "number" ? h.baths : null,
        sqft: h.sqFt && h.sqFt.value,
        address: street,
        neighborhood: h.neighborhood || null,
        lat: h.latLong && h.latLong.latitude,
        lng: h.latLong && h.latLong.longitude,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source: Zillow (search page — worth trying from a residential iPhone IP)
// ---------------------------------------------------------------------------
async function scrapeZillow() {
  const searchUrl =
    "https://www.zillow.com/san-francisco-ca/rentals/" +
    `?beds=${CRITERIA.minBeds}-${CRITERIA.maxBeds}`;
  await prime("https://www.zillow.com/");

  const req = new Request(searchUrl);
  req.headers = headers({ Referer: "https://www.zillow.com/" });

  let html;
  try {
    html = await req.loadString();
  } catch (e) {
    throw new Error("Zillow network: " + e.message);
  }
  const code = (req.response || {}).statusCode;
  if (code && code >= 400) throw new Error("Zillow HTTP " + code);

  // Extract __NEXT_DATA__ JSON embedded in the page
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Zillow: no __NEXT_DATA__");
  const page = JSON.parse(m[1]);

  // Walk the nested structure to find listResults
  function findListResults(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 12) return [];
    if (Array.isArray(obj)) {
      for (const el of obj) {
        const r = findListResults(el, depth + 1);
        if (r.length) return r;
      }
      return [];
    }
    if (Array.isArray(obj.listResults) && obj.listResults.length) return obj.listResults;
    for (const v of Object.values(obj)) {
      const r = findListResults(v, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  const results = findListResults(page, 0);
  if (!results.length) throw new Error("Zillow: 0 list results (possibly blocked)");

  const out = [];
  for (const h of results) {
    const id = h.zpid || h.id;
    if (!id) continue;
    out.push(
      listing({
        source: "zillow",
        source_id: id,
        url: h.detailUrl
          ? (h.detailUrl.startsWith("http") ? h.detailUrl : "https://www.zillow.com" + h.detailUrl)
          : "",
        title: h.address || h.streetAddress || "Zillow rental",
        price: parsePrice(h.price || h.unformattedPrice),
        beds: h.beds != null ? Number(h.beds) : null,
        baths: h.baths != null ? Number(h.baths) : null,
        sqft: h.area != null ? Number(h.area) : null,
        address: h.address || null,
        neighborhood: h.hdpData && h.hdpData.homeInfo && h.hdpData.homeInfo.neighborhoodRegion
          ? h.hdpData.homeInfo.neighborhoodRegion.name
          : null,
        lat: h.latLong ? h.latLong.latitude : null,
        lng: h.latLong ? h.latLong.longitude : null,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub publish — retries on 409 (stale SHA) up to 3 times
// ---------------------------------------------------------------------------
async function getToken() {
  if (Keychain.contains("gh_token")) return Keychain.get("gh_token");
  const a = new Alert();
  a.title = "GitHub token";
  a.message =
    "Paste a fine-grained personal access token with Contents: Read and write " +
    "on " + OWNER + "/" + REPO + ". Stored only in this device's keychain.";
  a.addSecureTextField("github_pat_…");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  const idx = await a.present();
  if (idx === -1) throw new Error("No token provided");
  const t = a.textFieldValue(0).trim();
  if (!t) throw new Error("Empty token");
  Keychain.set("gh_token", t);
  return t;
}

async function publish(payload, token) {
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
  const content = Data.fromString(JSON.stringify(payload, null, 2)).toBase64String();

  for (let attempt = 0; attempt < 3; attempt++) {
    // Always fetch a fresh SHA immediately before the PUT to avoid 409 conflicts.
    let sha = null;
    const get = new Request(`${api}?ref=${BRANCH}`);
    get.headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    };
    try {
      const cur = await get.loadJSON();
      if (cur && cur.sha) sha = cur.sha;
    } catch (_) {}

    const body = {
      message: `data: scriptable crawl ${new Date().toISOString()}`,
      content,
      branch: BRANCH,
    };
    if (sha) body.sha = sha;

    const put = new Request(api);
    put.method = "PUT";
    put.headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    put.body = JSON.stringify(body);
    const res = await put.loadJSON();
    const status = (put.response || {}).statusCode || 0;

    if (status === 409 && attempt < 2) continue; // retry with a freshly fetched SHA
    if (status >= 400) {
      throw new Error(
        "GitHub " + status + ": " + JSON.stringify(res).slice(0, 300)
      );
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const token = await getToken();

  const SOURCES = [
    ["craigslist", scrapeCraigslist],
    ["redfin", scrapeRedfin],
    ["zillow", scrapeZillow],
  ];

  const sources = {};
  let listings = [];
  for (const [name, fn] of SOURCES) {
    try {
      const got = await fn();
      listings = listings.concat(got);
      sources[name] = {
        status: "ok",
        count: got.length,
        error: null,
        last_success: new Date().toISOString(),
      };
    } catch (e) {
      sources[name] = {
        status: "blocked",
        count: 0,
        error: String(e).slice(0, 200),
        last_success: null,
      };
    }
  }

  listings.sort((a, b) =>
    String(b.posted_at || "").localeCompare(String(a.posted_at || ""))
  );

  const payload = {
    generated_at: new Date().toISOString(),
    criteria: {
      city: CRITERIA.city,
      state: CRITERIA.state,
      min_bedrooms: CRITERIA.minBeds,
      max_bedrooms: CRITERIA.maxBeds,
    },
    sources,
    total: listings.length,
    listings,
  };

  await publish(payload, token);

  const ok = Object.values(sources).filter((s) => s.status === "ok").length;
  // Show the actual error message (not just "blocked") to help diagnose failures.
  const summary =
    `${payload.total} listings · ${ok}/${SOURCES.length} sources OK\n` +
    Object.entries(sources)
      .map(([k, v]) =>
        `${k}: ${v.status === "ok" ? v.count + " found" : (v.error || v.status)}`
      )
      .join("\n");

  if (config.runsInWidget) {
    const w = new ListWidget();
    w.addText("SF Rentals");
    w.addText(summary);
    Script.setWidget(w);
  } else {
    const note = new Alert();
    note.title = "SF Rentals updated";
    note.message = summary;
    note.addAction("OK");
    await note.present();
  }
  Script.complete();
}

(async () => {
  try {
    await main();
  } catch (e) {
    const a = new Alert();
    a.title = "SF Rentals — error";
    a.message = String(e);
    a.addAction("OK");
    await a.present();
    Script.complete();
  }
})();
