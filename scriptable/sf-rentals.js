// SF 2-Bedroom Rentals — Scriptable scraper
// ---------------------------------------------------------------------------
// Runs on your iPhone (Scriptable app). Because it uses the phone's native HTTP
// client (no browser CORS) from your residential IP, it can fetch the listing
// sites that block datacenter/cloud IPs. It then pushes the results to your
// GitHub repo via the API, so the GitHub Pages dashboard displays them.
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
  clArea: "sfc", // Craigslist area (San Francisco city)
};

// A real mobile-Safari header set; helps blend in from the residential IP.
function headers() {
  return {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers (mirror the Python scraper)
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
  const url =
    `https://${CRITERIA.clSite}.craigslist.org/search/${CRITERIA.clArea}/apa` +
    `?min_bedrooms=${CRITERIA.minBeds}&max_bedrooms=${CRITERIA.maxBeds}` +
    `&availabilityMode=0&format=rss`;
  const req = new Request(url);
  req.headers = headers();
  const xml = await req.loadString();
  if (req.response.statusCode >= 400) throw new Error("HTTP " + req.response.statusCode);

  const out = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of items) {
    const link =
      (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] ||
      (block.match(/rdf:about="([^"]+)"/) || [])[1] ||
      "";
    if (!link) continue;
    const title = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
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
  req.headers = headers();
  const txt = await req.loadString();
  if (req.response.statusCode >= 400) throw new Error("HTTP " + req.response.statusCode);
  const data = JSON.parse(stripRedfin(txt));
  const sections = (data.payload && data.payload.sections) || [];
  for (const sec of sections) {
    for (const row of sec.rows || []) {
      if (String(row.type) === "6" && row.id) {
        return row.id.split("_").pop();
      }
    }
  }
  return null;
}

async function scrapeRedfin() {
  const regionId = await redfinRegion();
  if (!regionId) return [];
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
  const req = new Request("https://www.redfin.com/stingray/api/v1/search/rentals?" + q);
  req.headers = headers();
  const txt = await req.loadString();
  if (req.response.statusCode >= 400) throw new Error("HTTP " + req.response.statusCode);
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
// GitHub publish
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

  // Current file SHA (required to update an existing file).
  let sha = null;
  const get = new Request(`${api}?ref=${BRANCH}`);
  get.headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  try {
    const cur = await get.loadJSON();
    if (cur && cur.sha) sha = cur.sha;
  } catch (e) {
    /* file may not exist yet */
  }

  const body = {
    message: `data: scriptable crawl ${new Date().toISOString()}`,
    content: Data.fromString(JSON.stringify(payload, null, 2)).toBase64String(),
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
  if (put.response.statusCode >= 400) {
    throw new Error("GitHub " + put.response.statusCode + ": " + JSON.stringify(res).slice(0, 200));
  }
  return res;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const token = await getToken();

  const SOURCES = [
    ["craigslist", scrapeCraigslist],
    ["redfin", scrapeRedfin],
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
      sources[name] = { status: "blocked", count: 0, error: String(e).slice(0, 200), last_success: null };
    }
  }

  listings.sort((a, b) => String(b.posted_at || "").localeCompare(String(a.posted_at || "")));

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
  const summary =
    `${payload.total} listings · ${ok}/${SOURCES.length} sources OK\n` +
    Object.entries(sources)
      .map(([k, v]) => `${k}: ${v.status === "ok" ? v.count : v.status}`)
      .join("\n");

  // If run from a widget/Shortcut, return text; otherwise show an alert.
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
