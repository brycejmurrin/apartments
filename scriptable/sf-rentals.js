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
  // Bedroom bounds for the crawl. Set both to null to crawl ALL rentals (every
  // bedroom count) and filter on the dashboard instead. Set e.g. minBeds:2,
  // maxBeds:2 to crawl only 2-beds.
  minBeds: null,
  maxBeds: null,
  clSite: "sfbay", // Craigslist site
  clArea: "sfc",   // Craigslist area (San Francisco city)
};

// Bed query fragments — emit nothing when the bound is null (crawl all).
function bedFrag(minKey, maxKey) {
  let s = "";
  if (CRITERIA.minBeds != null) s += `&${minKey}=${CRITERIA.minBeds}`;
  if (CRITERIA.maxBeds != null) s += `&${maxKey}=${CRITERIA.maxBeds}`;
  return s;
}

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
function parseBaths(text) {
  if (typeof text === "number") return text;
  const m = (text || "").match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|baths)\b/i);
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
    `?availabilityMode=0&format=rss` +
    bedFrag("min_bedrooms", "max_bedrooms");
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
    "&availabilityMode=0" +
    bedFrag("min_bedrooms", "max_bedrooms");
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
    if (!Array.isArray(it)) continue;
    const postId = it[0];

    // Walk the item array. It mixes scalars and tagged sub-arrays/objects.
    // Collect every string + number so we can detect each field by shape
    // rather than relying on a fixed position (the layout drifts).
    const strings = [];
    const numbers = [];
    let beds = null, baths = null, sqft = null, lat = null, lng = null, posted = null;

    const visit = (node) => {
      if (node == null) return;
      if (typeof node === "string") {
        strings.push(node);
        return;
      }
      if (typeof node === "number") {
        numbers.push(node);
        // 10-digit value ~ unix seconds → posting date.
        if (posted == null && node > 1000000000 && node < 4000000000) {
          posted = new Date(node * 1000).toISOString();
        }
        return;
      }
      if (Array.isArray(node)) {
        // A [lat, lng] geo pair (SF: lat ~37.x, lng ~ -122.x).
        if (
          node.length >= 2 &&
          typeof node[0] === "number" &&
          typeof node[1] === "number" &&
          node[0] > 32 && node[0] < 42 &&
          node[1] < -114 && node[1] > -125
        ) {
          lat = node[0];
          lng = node[1];
        }
        node.forEach(visit);
        return;
      }
      if (typeof node === "object") {
        if (node.bedrooms != null && beds == null) beds = Number(node.bedrooms);
        if (node.bathrooms != null && baths == null) baths = Number(node.bathrooms);
        const sq = node.sqft || node.size || node.area;
        if (sq != null && sqft == null) sqft = parseSqft(String(sq)) || Number(sq) || null;
        Object.values(node).forEach(visit);
      }
    };
    it.forEach(visit);

    // Title = the longest free-text string (not a pure housing/price token).
    let title = "";
    for (const s of strings) {
      if (/^\$?\d/.test(s.trim())) continue;
      if (s.length > title.length) title = s;
    }
    if (!title) title = strings.sort((a, b) => b.length - a.length)[0] || "";

    // Beds/sqft/hood from any string if not already structured.
    for (const s of strings) {
      if (beds == null) beds = parseBeds(s);
      if (sqft == null) sqft = parseSqft(s);
    }
    let neighborhood = null;
    for (const s of strings) {
      neighborhood = neighborhood || parseHood(s);
    }

    // Price: a "$" string wins; else the largest plausible rent number.
    let price = null;
    for (const s of strings) {
      price = price || parsePrice(s);
    }
    if (price == null) {
      const rents = numbers.filter((n) => n >= 500 && n <= 90000);
      if (rents.length) price = Math.max(...rents);
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
        price,
        beds,
        baths,
        sqft,
        neighborhood,
        lat,
        lng,
        posted_at: posted,
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

// Known Redfin city region IDs (region_type 6), used when the autocomplete
// endpoint is blocked. Keys are lowercased with spaces removed (see lookup
// below). Add more here if you change CRITERIA.city.
const REDFIN_REGION = { "sanfrancisco,ca": "17151" };

async function redfinRegion() {
  // Primary: ask Redfin's autocomplete. This path is sometimes 403'd even from
  // a residential IP, so failure falls through to the known-ID map below.
  try {
    const r = await httpGet(
      "https://www.redfin.com/stingray/do/location-autocomplete?location=" +
        encodeURIComponent(`${CRITERIA.city}, ${CRITERIA.state}`) +
        "&v=2&al=1",
      { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" }
    );
    if (!(r.code >= 400 || r.error)) {
      const data = JSON.parse(stripRedfin(r.text));
      for (const sec of (data.payload && data.payload.sections) || []) {
        for (const row of sec.rows || []) {
          if (String(row.type) === "6" && row.id) return row.id.split("_").pop();
        }
      }
    }
  } catch (_) {}

  // Fallback: hardcoded region id (bypasses the blocked autocomplete endpoint).
  const key = `${CRITERIA.city},${CRITERIA.state}`.toLowerCase().replace(/\s+/g, "");
  if (REDFIN_REGION[key]) return REDFIN_REGION[key];
  throw new Error("no region id (autocomplete blocked, no fallback)");
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
  ]
    .concat(CRITERIA.minBeds != null ? [`min_beds=${CRITERIA.minBeds}`] : [])
    .concat(CRITERIA.maxBeds != null ? [`max_beds=${CRITERIA.maxBeds}`] : [])
    .join("&");
  const r = await httpGet(
    "https://www.redfin.com/stingray/api/v1/search/rentals?" + q,
    { Accept: "application/json, text/plain, */*", Referer: "https://www.redfin.com/" }
  );
  if (r.code >= 400 || r.error) throw new Error("rentals HTTP " + (r.code || r.error));

  const data = JSON.parse(stripRedfin(r.text));
  const homes = data.homes || (data.payload && data.payload.homes) || [];
  const out = [];
  for (const h of homes) {
    // Redfin's rentals API nests fields under homeData + rentalExtension; older
    // shapes are flat. Read from wherever the field exists.
    const hd = h.homeData || h;
    const rx = h.rentalExtension || hd.rentalExtension || {};
    const id = hd.propertyId || hd.listingId || h.rentalId || h.propertyId;
    if (!id) continue;

    const addrInfo = hd.addressInfo || {};
    const street =
      addrInfo.formattedStreetLine ||
      rx.propertyName ||
      (hd.streetLine && hd.streetLine.value) ||
      hd.name ||
      "Redfin rental";

    const rent = rx.rentPriceRange || h.rentPriceRange || {};
    const price = rent.min || rent.max || null;
    const bedR = rx.bedRange || {};
    const bathR = rx.bathRange || {};
    const sqftR = rx.sqftRange || {};
    const centroid = (addrInfo.centroid && addrInfo.centroid.centroid) || {};
    const url = hd.url || h.url || "";

    // Posting date: Redfin gives epoch millis in a few possible fields.
    const epoch =
      rx.availableDate || hd.listingAddedDate || hd.searchStatusDate || rx.lastUpdated;
    const posted =
      typeof epoch === "number" ? new Date(epoch).toISOString() : null;

    out.push(
      listing({
        source: "redfin",
        source_id: id,
        url: url ? (url.startsWith("http") ? url : "https://www.redfin.com" + url) : "",
        title: rx.propertyName || street,
        price: typeof price === "number" ? price : null,
        beds:
          bedR.min != null
            ? bedR.min
            : typeof hd.beds === "number"
            ? hd.beds
            : null,
        baths: bathR.min != null ? bathR.min : null,
        sqft: sqftR.min != null ? sqftR.min : (hd.sqFt && hd.sqFt.value) || null,
        address: street,
        neighborhood: addrInfo.city || hd.neighborhood || null,
        lat: centroid.latitude != null ? centroid.latitude : null,
        lng: centroid.longitude != null ? centroid.longitude : null,
        posted_at: posted,
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
  // beds=min-max (e.g. 2-2). Omit entirely to crawl all bedroom counts.
  const beds =
    CRITERIA.minBeds != null
      ? `?beds=${CRITERIA.minBeds}-${CRITERIA.maxBeds != null ? CRITERIA.maxBeds : ""}`
      : "";
  const r = await httpGet(
    "https://www.zillow.com/san-francisco-ca/rentals/" + beds,
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
    const hi = (h.hdpData && h.hdpData.homeInfo) || {};
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
        price: parsePrice(h.price || h.unformattedPrice || hi.price),
        beds: h.beds != null ? Number(h.beds) : hi.bedrooms != null ? Number(hi.bedrooms) : null,
        baths: h.baths != null ? Number(h.baths) : hi.bathrooms != null ? Number(hi.bathrooms) : null,
        sqft:
          h.area != null
            ? Number(h.area)
            : hi.livingArea != null
            ? Number(hi.livingArea)
            : null,
        address: h.address || hi.streetAddress || null,
        neighborhood:
          (h.hdpData && hi.neighborhoodRegion && hi.neighborhoodRegion.name) ||
          hi.city ||
          "San Francisco",
        lat: h.latLong ? h.latLong.latitude : hi.latitude != null ? hi.latitude : null,
        lng: h.latLong ? h.latLong.longitude : hi.longitude != null ? hi.longitude : null,
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
    (CRITERIA.minBeds != null ? `${CRITERIA.minBeds}p_beds/` : "");
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
// Source: Apartments.com — via a real WebView (defeats Akamai Bot Manager)
// ---------------------------------------------------------------------------
// Apartments.com is fronted by Akamai Bot Manager, which 403s any raw HTTP
// request (no valid _abck sensor cookie). A real browser passes because it
// executes Akamai's JS. Scriptable ships a real iOS WebKit WebView, so we load
// the page there (real TLS + JS + your residential IP), let Akamai clear, then
// scrape the rendered DOM via evaluateJavaScript. Widgets can't run a WebView,
// so this source is skipped in widget context.
async function scrapeApartments() {
  if (config.runsInWidget) throw new Error("WebView unavailable in widget");

  const city = CRITERIA.city.trim().toLowerCase().replace(/ /g, "-");
  const url =
    `https://www.apartments.com/${city}-${CRITERIA.state.toLowerCase()}/` +
    (CRITERIA.minBeds != null ? `${CRITERIA.minBeds}-bedrooms/` : "");

  const wv = new WebView();
  await wv.loadURL(url);
  // Give Akamai's sensor JS time to clear and the listings to render.
  await sleep(4500);

  // Scrape JSON-LD + placard cards from the live DOM and MERGE them per URL:
  // placards carry price/beds/address, JSON-LD carries geo/name. Returns JSON.
  const extractor = `(function(){
    var map = {};
    function key(u){ return (u||'').replace(/\\/+$/,''); }
    function slot(u){ var k=key(u); if(!map[k]) map[k]={url:u}; return map[k]; }
    function set(o, f, v){ if(v!=null && v!=='' && (o[f]==null||o[f]==='')) o[f]=v; }

    // Placards first (richest pricing/bed data).
    try {
      var cards = document.querySelectorAll('article.placard, li.mortar-wrapper article, .placard');
      for (var c=0;c<cards.length;c++){
        var a = cards[c];
        var u = a.getAttribute('data-url');
        if(!u){ var ln=a.querySelector('a.property-link,a[href]'); u = ln && ln.href; }
        if(!u) continue;
        function tx(sel){ var el=a.querySelector(sel); return el?el.textContent.replace(/\\s+/g,' ').trim():null; }
        var o = slot(u);
        set(o,'id', a.getAttribute('data-listingid'));
        set(o,'name', tx('.js-placardTitle, .property-title, .property-name'));
        set(o,'price', tx('.property-pricing, .price-range, .property-rents'));
        set(o,'beds', tx('.property-beds, .bed-range'));
        set(o,'baths', tx('.property-baths, .bath-range'));
        set(o,'address', tx('.property-address'));
      }
    } catch(e){}

    // JSON-LD fills name/address/geo gaps.
    try {
      var s = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i=0;i<s.length;i++){
        var d; try { d = JSON.parse(s[i].textContent); } catch(e){ continue; }
        var arr = Array.isArray(d) ? d : [d];
        for (var j=0;j<arr.length;j++){
          var e = arr[j]; if(!e||typeof e!=='object') continue;
          var items = [];
          if (e['@type']==='SearchResultsPage' && e.about && e.about.length) items = e.about;
          else if (e.itemListElement && e.itemListElement.length)
            items = e.itemListElement.map(function(x){ return (x&&x.item)||x; });
          for (var k=0;k<items.length;k++){
            var it = items[k]; if(!it||typeof it!=='object') continue;
            var u = it.url || it['@id']; if(!u) continue;
            var addr = it.address || {}; var geo = it.geo || {};
            var o = slot(u);
            set(o,'name', it.name);
            set(o,'address', (typeof addr==='string')?addr:(addr.streetAddress||null));
            set(o,'city', (typeof addr==='object')?(addr.addressLocality||null):null);
            if(geo.latitude!=null) set(o,'lat', geo.latitude);
            if(geo.longitude!=null) set(o,'lng', geo.longitude);
          }
        }
      }
    } catch(e){}

    var out = [];
    for (var kk in map) out.push(map[kk]);
    return JSON.stringify({ ok: out.length>0, count: out.length,
      title: document.title || '', items: out });
  })();`;

  let parsed;
  try {
    const res = await wv.evaluateJavaScript(extractor);
    parsed = JSON.parse(res);
  } catch (e) {
    throw new Error("WebView eval failed: " + e.message);
  }

  if (!parsed.items || !parsed.items.length) {
    // Title often reveals a challenge ("Access Denied" / "Pardon Our Interruption").
    throw new Error("0 listings (page: " + (parsed.title || "?").slice(0, 40) + ")");
  }

  const out = [];
  for (const it of parsed.items) {
    let u = it.url;
    if (u && u.startsWith("/")) u = "https://www.apartments.com" + u;
    out.push(
      listing({
        source: "apartments_com",
        source_id: it.id || idFromUrl(u),
        url: u,
        title: it.name || it.address || "Apartments.com listing",
        price: parsePrice(it.price),
        beds: parseBeds(it.beds),
        baths: parseBaths(it.baths || it.beds),
        sqft: parseSqft(it.beds),
        address: it.address || null,
        neighborhood: it.city || null,
        lat: it.lat != null ? Number(it.lat) : null,
        lng: it.lng != null ? Number(it.lng) : null,
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
