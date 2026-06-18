// SF 2-Bedroom Rentals — Scriptable scraper
// ---------------------------------------------------------------------------
// Runs on your iPhone (Scriptable app). Uses the phone's residential IP +
// native HTTP to fetch listing sites, then pushes results to your GitHub repo
// via the API so the GitHub Pages dashboard shows them.
//
// Sources: Craigslist, Redfin, Zillow, Trulia, Apartments.com.
// Each source degrades independently — if one is blocked the rest still run.
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

// Minimal, real-looking Safari headers. We deliberately do NOT set
// Accept-Encoding or Connection — NSURLSession (which Scriptable's Request uses)
// manages those itself and transparently decompresses gzip; forcing "br" can
// hand back Brotli bytes it can't decode.
function headers(extra) {
  return Object.assign(
    {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    extra || {}
  );
}

function sleep(ms) {
  return new Promise((r) => Timer.schedule(ms, false, r));
}

// GET that returns { code, text }. Never throws on HTTP status; caller decides.
async function httpGet(url, extra) {
  const req = new Request(url);
  req.headers = headers(extra);
  let text = "";
  try {
    text = await req.loadString();
  } catch (e) {
    return { code: 0, text: "", error: e.message };
  }
  return { code: (req.response || {}).statusCode || 0, text };
}

// Visit a page to collect cookies (best-effort warm-up).
async function prime(url) {
  await httpGet(url);
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
  if (typeof text === "number") return text >= 200 && text <= 100000 ? text : null;
  const m = (text || "").match(/\$\s*([\d,]+)/);
  if (!m) return null;
  const v = parseInt(m[1].replace(/,/g, ""), 10);
  return v >= 200 && v <= 100000 ? v : null;
}
function parseBeds(text) {
  if (typeof text === "number") return text;
  if (/studio/i.test(text || "")) return 0;
  const m = (text || "").match(/(\d+(?:\.\d+)?)\s*(?:br|bd|beds?)\b/i);
  return m ? parseFloat(m[1]) : null;
}
function parseSqft(text) {
  if (typeof text === "number") return text;
  const m = (text || "").match(/(\d[\d,]*)\s*(?:ft2|sq\s?ft|sqft)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}
function parseHood(text) {
  const m = (text || "").trim().match(/\(([^()]+)\)\s*$/);
  return m ? m[1].trim() : null;
}
function idFromUrl(url) {
  const parts = (url || "").replace(/\/+$/, "").split("/");
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
// Source: Craigslist — RSS primary, JSON sapi fallback
// ---------------------------------------------------------------------------
async function clFromRss() {
  const base = `https://${CRITERIA.clSite}.craigslist.org`;
  const url =
    `${base}/search/${CRITERIA.clArea}/apa` +
    `?min_bedrooms=${CRITERIA.minBeds}&max_bedrooms=${CRITERIA.maxBeds}` +
    `&availabilityMode=0&format=rss`;
  const r = await httpGet(url, { Referer: base + "/", Accept: "application/rss+xml,application/xml,text/xml,*/*" });
  if (r.code >= 400 || r.error) throw new Error("RSS HTTP " + (r.code || r.error));

  const out = [];
  const items = r.text.match(/<item[\s\S]*?<\/item>/g) || [];
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

// Modern JSON API the Craigslist web app itself calls. The first batch number
// is the site's area id (sfbay = 1). Returns a compact positional array we map.
async function clFromSapi() {
  const url =
    "https://sapi.craigslist.org/web/v8/postings/search/full" +
    "?batch=1-0-360-0-0&cc=US&lang=en&searchPath=apa" +
    `&min_bedrooms=${CRITERIA.minBeds}&max_bedrooms=${CRITERIA.maxBeds}` +
    "&availabilityMode=0";
  const r = await httpGet(url, {
    Accept: "application/json, text/plain, */*",
    Referer: `https://${CRITERIA.clSite}.craigslist.org/`,
    Origin: `https://${CRITERIA.clSite}.craigslist.org`,
  });
  if (r.code >= 400 || r.error) throw new Error("sapi HTTP " + (r.code || r.error));

  const data = JSON.parse(r.text);
  const items = (data.data && data.data.items) || [];
  const minPosters = (data.data && data.data.decode && data.data.decode.minPosterId) || 0;
  const out = [];
  for (const it of items) {
    // Positional array: [postId, ?, category, ..., price, ..., {6:[lat,lng]}, ..., title]
    if (!Array.isArray(it)) continue;
    const postId = it[0];
    // title is the last string element; price is the first plausible $ number.
    let title = "";
    let price = null;
    for (const el of it) {
      if (typeof el === "string" && el.length > title.length) title = el;
      if (typeof el === "number" && price == null && el >= 200 && el <= 100000) price = el;
    }
    let lat = null, lng = null;
    for (const el of it) {
      if (el && typeof el === "object" && !Array.isArray(el)) {
        const geo = el["6"] || el[6];
        if (Array.isArray(geo) && geo.length >= 2) {
          lat = parseFloat(geo[0]);
          lng = parseFloat(geo[1]);
        }
      }
    }
    if (!postId && !title) continue;
    out.push(
      listing({
        source: "craigslist",
        source_id: postId || (minPosters + ""),
        url: postId
          ? `https://${CRITERIA.clSite}.craigslist.org/d/apa/${postId}.html`
          : `https://${CRITERIA.clSite}.craigslist.org/`,
        title: decodeEntities(title),
        price: parsePrice(price),
        beds: parseBeds(title),
        sqft: parseSqft(title),
        neighborhood: parseHood(title),
      })
    );
  }
  return out;
}

async function scrapeCraigslist() {
  await prime(`https://${CRITERIA.clSite}.craigslist.org/`);
  const errors = [];
  for (const [label, fn] of [["rss", clFromRss], ["sapi", clFromSapi]]) {
    try {
      const got = await fn();
      if (got.length) return got;
      errors.push(label + ": 0 results");
    } catch (e) {
      errors.push(e.message);
    }
    await sleep(400);
  }
  throw new Error(errors.join(" | "));
}

// ---------------------------------------------------------------------------
// Source: Redfin (internal "stingray" JSON API), with one retry
// ---------------------------------------------------------------------------
function stripRedfin(t) {
  return (t || "").replace(/^\{\}&&/, "");
}

async function redfinRegion() {
  const r = await httpGet(
    "https://www.redfin.com/stingray/do/location-autocomplete?location=" +
      encodeURIComponent(`${CRITERIA.city}, ${CRITERIA.state}`) +
      "&v=2&al=1",
    { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" }
  );
  if (r.code >= 400 || r.error) throw new Error("region HTTP " + (r.code || r.error));
  const data = JSON.parse(stripRedfin(r.text));
  for (const sec of (data.payload && data.payload.sections) || []) {
    for (const row of sec.rows || []) {
      if (String(row.type) === "6" && row.id) return row.id.split("_").pop();
    }
  }
  throw new Error("no region id");
}

async function redfinOnce() {
  const regionId = await redfinRegion();
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
  const r = await httpGet(
    "https://www.redfin.com/stingray/api/v1/search/rentals?" + q,
    { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" }
  );
  if (r.code >= 400 || r.error) throw new Error("rentals HTTP " + (r.code || r.error));

  const data = JSON.parse(stripRedfin(r.text));
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

async function scrapeRedfin() {
  await prime("https://www.redfin.com/");
  try {
    return await redfinOnce();
  } catch (e) {
    await sleep(600);
    return await redfinOnce(); // one retry; if it throws again, source = blocked
  }
}

// ---------------------------------------------------------------------------
// Source: Zillow (__NEXT_DATA__)
// ---------------------------------------------------------------------------
function findKeyArray(obj, key, depth) {
  if (!obj || typeof obj !== "object" || depth > 12) return [];
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const r = findKeyArray(el, key, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKeyArray(v, key, depth + 1);
    if (r.length) return r;
  }
  return [];
}

async function scrapeZillow() {
  await prime("https://www.zillow.com/");
  const r = await httpGet(
    "https://www.zillow.com/san-francisco-ca/rentals/" +
      `?beds=${CRITERIA.minBeds}-${CRITERIA.maxBeds}`,
    { Referer: "https://www.zillow.com/" }
  );
  if (r.code >= 400 || r.error) throw new Error("HTTP " + (r.code || r.error));

  const m = r.text.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NEXT_DATA__ (challenged?)");
  const page = JSON.parse(m[1]);
  const results = findKeyArray(page, "listResults", 0);
  if (!results.length) throw new Error("0 list results");

  const out = [];
  for (const h of results) {
    const id = h.zpid || h.id;
    if (!id) continue;
    out.push(
      listing({
        source: "zillow",
        source_id: id,
        url: h.detailUrl
          ? h.detailUrl.startsWith("http")
            ? h.detailUrl
            : "https://www.zillow.com" + h.detailUrl
          : "",
        title: h.address || h.streetAddress || "Zillow rental",
        price: parsePrice(h.price || h.unformattedPrice),
        beds: h.beds != null ? Number(h.beds) : null,
        baths: h.baths != null ? Number(h.baths) : null,
        sqft: h.area != null ? Number(h.area) : null,
        address: h.address || null,
        neighborhood:
          h.hdpData && h.hdpData.homeInfo && h.hdpData.homeInfo.neighborhoodRegion
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
// Source: Trulia (__NEXT_DATA__ recursive walk)
// ---------------------------------------------------------------------------
function truliaNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") {
    for (const k of ["value", "max", "min", "price"]) {
      if (v[k] != null) {
        const n = truliaNum(v[k]);
        if (n != null) return n;
      }
    }
    return null;
  }
  const m = String(v).match(/\d[\d,]*/);
  return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
}

function looksLikeTruliaHome(node) {
  if (!node || typeof node !== "object") return false;
  const tn = (node.__typename || "").toUpperCase();
  if (["HOME", "RENTALHOME", "RENTALCOMMUNITY", "BUILDING", "INDIVIDUALHOME"].includes(tn))
    return true;
  const url = node.url;
  if (typeof url !== "string" || !url) return false;
  if (!(url.indexOf("/p/") >= 0 || url.indexOf("/b/") >= 0 || /\d{5,}\/?$/.test(url)))
    return false;
  return ["price", "location", "bedrooms", "bathrooms", "floorSpace"].some((k) => k in node);
}

function walkTrulia(node, out, seen, depth) {
  if (depth > 14 || !node || typeof node !== "object") return;
  if (looksLikeTruliaHome(node)) {
    if (!seen.has(node)) {
      seen.add(node);
      out.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkTrulia(v, out, seen, depth + 1);
  } else {
    for (const v of Object.values(node)) walkTrulia(v, out, seen, depth + 1);
  }
}

async function scrapeTrulia() {
  await prime("https://www.trulia.com/");
  const city = CRITERIA.city.replace(/ /g, "_");
  const url =
    `https://www.trulia.com/for_rent/${city},${CRITERIA.state}/` +
    `${CRITERIA.minBeds}p_beds/`;
  const r = await httpGet(url, { Referer: "https://www.trulia.com/" });
  if (r.code >= 400 || r.error) throw new Error("HTTP " + (r.code || r.error));

  const m = r.text.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NEXT_DATA__ (challenged?)");
  const page = JSON.parse(m[1]);

  const homes = [];
  walkTrulia(page, homes, new Set(), 0);
  if (!homes.length) throw new Error("0 homes");

  const out = [];
  const seenUrls = new Set();
  for (const h of homes) {
    let url2 = h.url || "";
    if (url2.startsWith("/")) url2 = "https://www.trulia.com" + url2;
    if (!url2 || seenUrls.has(url2)) continue;
    seenUrls.add(url2);
    const loc = (h.location && typeof h.location === "object" && h.location) || {};
    const street = loc.streetAddress;
    const addr = [street, loc.city, loc.stateCode || loc.state].filter(Boolean).join(", ") ||
      loc.partialLocation || null;
    const coords = loc.coordinates || h.coordinates || {};
    const idm = url2.match(/(\d{5,})\/?$/);
    out.push(
      listing({
        source: "trulia",
        source_id: idm ? idm[1] : h.providerListingId || idFromUrl(url2),
        url: url2,
        title: addr || "Trulia rental",
        price: truliaNum(h.price),
        beds: truliaNum(h.bedrooms),
        baths: truliaNum(h.bathrooms),
        sqft: truliaNum(h.floorSpace),
        address: addr,
        neighborhood: loc.neighborhoodName || null,
        lat: coords.latitude != null ? Number(coords.latitude) : null,
        lng: coords.longitude != null ? Number(coords.longitude) : null,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source: Apartments.com (JSON-LD primary)
// ---------------------------------------------------------------------------
async function scrapeApartments() {
  await prime("https://www.apartments.com/");
  const city = CRITERIA.city.trim().toLowerCase().replace(/ /g, "-");
  const url =
    `https://www.apartments.com/${city}-${CRITERIA.state.toLowerCase()}/` +
    `${CRITERIA.minBeds}-bedrooms/`;
  const r = await httpGet(url, { Referer: "https://www.apartments.com/" });
  if (r.code >= 400 || r.error) throw new Error("HTTP " + (r.code || r.error));

  const out = [];
  const seen = new Set();
  const blocks =
    r.text.match(
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
    ) || [];
  for (const raw of blocks) {
    const json = raw.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    let data;
    try {
      data = JSON.parse(json);
    } catch (_) {
      continue;
    }
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      let items = [];
      if (entry["@type"] === "SearchResultsPage" && Array.isArray(entry.about))
        items = entry.about;
      else if (Array.isArray(entry.itemListElement))
        items = entry.itemListElement.map((el) => (el && el.item) || el);
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const u = it.url || it["@id"];
        if (!u || seen.has(u)) continue;
        seen.add(u);
        const addr = it.address || {};
        const geo = it.geo || {};
        out.push(
          listing({
            source: "apartments_com",
            source_id: idFromUrl(u),
            url: u,
            title: it.name || (typeof addr === "string" ? addr : addr.streetAddress) || "Apartments.com listing",
            address: typeof addr === "string" ? addr : addr.streetAddress || null,
            neighborhood: typeof addr === "object" ? addr.addressLocality || null : null,
            lat: geo.latitude != null ? Number(geo.latitude) : null,
            lng: geo.longitude != null ? Number(geo.longitude) : null,
          })
        );
      }
    }
  }
  if (!out.length) throw new Error("0 listings (Cloudflare challenge?)");
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
    // Fetch a fresh SHA immediately before the PUT to avoid 409 conflicts.
    let sha = null;
    const get = new Request(`${api}?ref=${BRANCH}`);
    get.headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
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

    if (status === 409 && attempt < 2) {
      await sleep(500);
      continue;
    }
    if (status >= 400) {
      throw new Error("GitHub " + status + ": " + JSON.stringify(res).slice(0, 300));
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
    ["trulia", scrapeTrulia],
    ["apartments_com", scrapeApartments],
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

  // De-dupe across sources by url.
  const byUrl = new Map();
  for (const l of listings) {
    const key = (l.url || "id:" + l.source_id).replace(/\/+$/, "");
    if (!byUrl.has(key)) byUrl.set(key, l);
  }
  listings = [...byUrl.values()];
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
  const summary =
    `${payload.total} listings · ${ok}/${SOURCES.length} sources OK\n` +
    Object.entries(sources)
      .map(([k, v]) => `${k}: ${v.status === "ok" ? v.count + " found" : v.error || v.status}`)
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
