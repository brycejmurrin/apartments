"use strict";

// ---------------------------------------------------------------------------
// Live, page-only scraping via a free-tier scraping API.
//
// Chain (all in your browser, no backend):
//   this page -> CORS proxy -> scraping API (residential proxy + anti-bot) -> site
//
// The scraping API runs the fetch on its own residential IPs and clears the
// sites' bot walls, so it returns the same HTML/JSON the Scriptable scraper
// reads. We parse it here with the same logic. You need a free scraping-API key
// (ScraperAPI gives 5,000 credits/month free). Stored only in localStorage.
// ---------------------------------------------------------------------------

const LIVE = {
  city: "San Francisco",
  state: "CA",
  clSite: "sfbay",
  clArea: "sfc",
  redfinRegion: "17151", // SF city, region_type 6
};

// ---- config (key + provider + proxy), persisted locally -------------------
function cfg() {
  return {
    key: localStorage.getItem("scraper_key") || "",
    // {URL} and {KEY} are substituted. Default = ScraperAPI. {RENDER} -> true/false.
    tmpl:
      localStorage.getItem("scraper_tmpl") ||
      "https://api.scraperapi.com/?api_key={KEY}&render={RENDER}&url={URL}",
    // CORS proxy wrapping the whole scraping-API URL. {URL} substituted.
    proxy: localStorage.getItem("scraper_proxy") || "https://corsproxy.io/?url={URL}",
  };
}

// Build the final fetch URL: scraping-API request, wrapped in the CORS proxy.
function wrap(targetUrl, render) {
  const c = cfg();
  const api = c.tmpl
    .replace("{KEY}", encodeURIComponent(c.key))
    .replace("{RENDER}", render ? "true" : "false")
    .replace("{URL}", encodeURIComponent(targetUrl));
  return c.proxy ? c.proxy.replace("{URL}", encodeURIComponent(api)) : api;
}

async function grab(targetUrl, render) {
  const resp = await fetch(wrap(targetUrl, render), { headers: { Accept: "*/*" } });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return resp.text();
}

// ---- shared parse helpers (mirror scraper) --------------------------------
function num(t, re) {
  const m = (t || "").match(re);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}
const price = (t) =>
  typeof t === "number" ? (t >= 200 && t <= 100000 ? t : null) : (() => {
    const v = num(t, /\$\s*([\d,]+)/);
    return v && v >= 200 && v <= 100000 ? v : null;
  })();
const beds = (t) =>
  typeof t === "number" ? t : /studio/i.test(t || "") ? 0 : num(t, /(\d+(?:\.\d+)?)\s*(?:br|bd|beds?)\b/i);
const baths = (t) => (typeof t === "number" ? t : num(t, /(\d+(?:\.\d+)?)\s*(?:ba|bath)\b/i));
const sqft = (t) => (typeof t === "number" ? t : num(t, /(\d[\d,]*)\s*(?:ft2|sq\s?ft|sqft)/i));
const hood = (t) => {
  const m = (t || "").trim().match(/\(([^()]+)\)\s*$/);
  return m ? m[1].trim() : null;
};
function L(o) {
  return {
    source: o.source, source_id: String(o.source_id), url: o.url, title: o.title || "",
    price: o.price ?? null, beds: o.beds ?? null, baths: o.baths ?? null, sqft: o.sqft ?? null,
    address: o.address ?? null, neighborhood: o.neighborhood ?? null,
    lat: o.lat ?? null, lng: o.lng ?? null, posted_at: o.posted_at ?? null, stale: false,
  };
}
const nextData = (html) => {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NEXT_DATA__");
  return JSON.parse(m[1]);
};
function findArray(obj, key, d) {
  if (!obj || typeof obj !== "object" || d > 12) return [];
  if (Array.isArray(obj)) {
    for (const e of obj) { const r = findArray(e, key, d + 1); if (r.length) return r; }
    return [];
  }
  if (Array.isArray(obj[key]) && obj[key].length) return obj[key];
  for (const v of Object.values(obj)) { const r = findArray(v, key, d + 1); if (r.length) return r; }
  return [];
}

// ---- per-source scrapers --------------------------------------------------
async function liveCraigslist() {
  const url =
    "https://sapi.craigslist.org/web/v8/postings/search/full" +
    "?batch=1-0-360-0-0&cc=US&lang=en&searchPath=apa&availabilityMode=0";
  const data = JSON.parse(await grab(url, false));
  const items = (data.data && data.data.items) || [];
  const out = [];
  for (const it of items) {
    if (!Array.isArray(it)) continue;
    const id = it[0];
    const strings = [], numbers = [];
    let bd = null, ba = null, sq = null, lat = null, lng = null, posted = null;
    const visit = (n) => {
      if (n == null) return;
      if (typeof n === "string") return void strings.push(n);
      if (typeof n === "number") {
        numbers.push(n);
        if (posted == null && n > 1e9 && n < 4e9) posted = new Date(n * 1000).toISOString();
        return;
      }
      if (Array.isArray(n)) {
        if (n.length >= 2 && typeof n[0] === "number" && typeof n[1] === "number" &&
            n[0] > 32 && n[0] < 42 && n[1] < -114 && n[1] > -125) { lat = n[0]; lng = n[1]; }
        return void n.forEach(visit);
      }
      if (typeof n === "object") {
        if (n.bedrooms != null && bd == null) bd = Number(n.bedrooms);
        if (n.bathrooms != null && ba == null) ba = Number(n.bathrooms);
        Object.values(n).forEach(visit);
      }
    };
    it.forEach(visit);
    let title = "";
    for (const s of strings) { if (/^\$?\d/.test(s.trim())) continue; if (s.length > title.length) title = s; }
    for (const s of strings) { if (bd == null) bd = beds(s); if (sq == null) sq = sqft(s); }
    let nb = null, pr = null;
    for (const s of strings) { nb = nb || hood(s); pr = pr || price(s); }
    if (pr == null) { const r = numbers.filter((n) => n >= 500 && n <= 90000); if (r.length) pr = Math.max(...r); }
    if (!id && !title) continue;
    out.push(L({
      source: "craigslist", source_id: id || title,
      url: id ? `https://${LIVE.clSite}.craigslist.org/d/apa/${id}.html` : `https://${LIVE.clSite}.craigslist.org/`,
      title, price: pr, beds: bd, baths: ba, sqft: sq, neighborhood: nb, lat, lng, posted_at: posted,
    }));
  }
  return out;
}

async function liveRedfin() {
  const q =
    `al=1&region_id=${LIVE.redfinRegion}&region_type=6&num_homes=350` +
    "&ord=redfin-recommended-asc&page_number=1&uipt=1,2,3,4,7,8&v=8";
  const txt = (await grab("https://www.redfin.com/stingray/api/v1/search/rentals?" + q, false)).replace(/^\{\}&&/, "");
  const data = JSON.parse(txt);
  const homes = data.homes || (data.payload && data.payload.homes) || [];
  return homes.map((h) => {
    const hd = h.homeData || h, rx = h.rentalExtension || hd.rentalExtension || {};
    const id = hd.propertyId || hd.listingId || h.rentalId; if (!id) return null;
    const ai = hd.addressInfo || {}, rent = rx.rentPriceRange || {}, cen = (ai.centroid && ai.centroid.centroid) || {};
    const street = ai.formattedStreetLine || rx.propertyName || "Redfin rental";
    const u = hd.url || h.url || "";
    return L({
      source: "redfin", source_id: id, url: u ? (u.startsWith("http") ? u : "https://www.redfin.com" + u) : "",
      title: rx.propertyName || street, price: rent.min || rent.max || null,
      beds: (rx.bedRange || {}).min ?? null, baths: (rx.bathRange || {}).min ?? null, sqft: (rx.sqftRange || {}).min ?? null,
      address: street, neighborhood: ai.city || null, lat: cen.latitude ?? null, lng: cen.longitude ?? null,
      posted_at: typeof rx.availableDate === "number" ? new Date(rx.availableDate).toISOString() : null,
    });
  }).filter(Boolean);
}

function zillowMap(h) {
  const id = h.zpid || h.id; if (!id) return null;
  const hi = (h.hdpData && h.hdpData.homeInfo) || {};
  return L({
    source: "zillow", source_id: id,
    url: h.detailUrl ? (h.detailUrl.startsWith("http") ? h.detailUrl : "https://www.zillow.com" + h.detailUrl) : "",
    title: h.address || "Zillow rental", price: price(h.price || h.unformattedPrice || hi.price),
    beds: h.beds ?? hi.bedrooms ?? null, baths: h.baths ?? hi.bathrooms ?? null, sqft: h.area ?? hi.livingArea ?? null,
    address: h.address || hi.streetAddress || null, neighborhood: hi.city || "San Francisco",
    lat: h.latLong ? h.latLong.latitude : hi.latitude ?? null, lng: h.latLong ? h.latLong.longitude : hi.longitude ?? null,
  });
}
async function liveZillow() {
  const out = [], seen = new Set();
  for (let p = 1; p <= 3; p++) {
    const seg = p > 1 ? `${p}_p/` : "";
    let results;
    try { results = findArray(nextData(await grab("https://www.zillow.com/san-francisco-ca/rentals/" + seg, false)), "listResults", 0); }
    catch (e) { if (p === 1) throw e; break; }
    let added = 0;
    for (const h of results) { const l = zillowMap(h); if (l && !seen.has(l.source_id)) { seen.add(l.source_id); out.push(l); added++; } }
    if (!added) break;
  }
  return out;
}

function looksTrulia(n) {
  if (!n || typeof n !== "object") return false;
  if (["HOME","RENTALHOME","RENTALCOMMUNITY","BUILDING","INDIVIDUALHOME"].includes((n.__typename || "").toUpperCase())) return true;
  const u = n.url; if (typeof u !== "string" || !u) return false;
  if (!(u.indexOf("/p/") >= 0 || u.indexOf("/b/") >= 0 || /\d{5,}\/?$/.test(u))) return false;
  return ["price","location","bedrooms","bathrooms","floorSpace"].some((k) => k in n);
}
function walkTrulia(n, out, seen, d) {
  if (d > 14 || !n || typeof n !== "object") return;
  if (looksTrulia(n)) { if (!seen.has(n)) { seen.add(n); out.push(n); } return; }
  (Array.isArray(n) ? n : Object.values(n)).forEach((v) => walkTrulia(v, out, seen, d + 1));
}
const tnum = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object") { for (const k of ["value","max","min","price"]) if (v[k] != null) { const n = tnum(v[k]); if (n != null) return n; } return null; }
  const m = String(v).match(/\d[\d,]*/); return m ? parseInt(m[0].replace(/,/g, ""), 10) : null;
};
async function liveTrulia() {
  const out = [], seenUrls = new Set();
  for (let p = 1; p <= 3; p++) {
    const seg = p > 1 ? `${p}_p/` : "";
    let homes;
    try { homes = []; walkTrulia(nextData(await grab(`https://www.trulia.com/for_rent/San_Francisco,CA/` + seg, false)), homes, new Set(), 0); }
    catch (e) { if (p === 1) throw e; break; }
    let added = 0;
    for (const h of homes) {
      let u = h.url || ""; if (u.startsWith("/")) u = "https://www.trulia.com" + u;
      if (!u || seenUrls.has(u)) continue; seenUrls.add(u); added++;
      const loc = (h.location && typeof h.location === "object" && h.location) || {}, c = loc.coordinates || {};
      const addr = [loc.streetAddress, loc.city, loc.stateCode || loc.state].filter(Boolean).join(", ") || loc.partialLocation || null;
      const idm = u.match(/(\d{5,})\/?$/);
      out.push(L({
        source: "trulia", source_id: idm ? idm[1] : h.providerListingId || u, url: u, title: addr || "Trulia rental",
        price: tnum(h.price), beds: tnum(h.bedrooms), baths: tnum(h.bathrooms), sqft: tnum(h.floorSpace),
        address: addr, neighborhood: loc.neighborhoodName || null, lat: c.latitude ?? null, lng: c.longitude ?? null,
      }));
    }
    if (!added) break;
  }
  return out;
}

async function liveApartments() {
  // render=true so the scraping API executes Akamai's JS for us.
  const html = await grab("https://www.apartments.com/san-francisco-ca/", true);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const map = new Map();
  const slot = (u) => { const k = u.replace(/\/+$/, ""); if (!map.has(k)) map.set(k, { url: u }); return map.get(k); };
  const setf = (o, f, v) => { if (v != null && v !== "" && (o[f] == null || o[f] === "")) o[f] = v; };
  doc.querySelectorAll("article.placard, li.mortar-wrapper article, .placard").forEach((a) => {
    let u = a.getAttribute("data-url"); if (!u) { const ln = a.querySelector("a.property-link,a[href]"); u = ln && ln.href; }
    if (!u) return; const o = slot(u);
    const tx = (s) => { const el = a.querySelector(s); return el ? el.textContent.replace(/\s+/g, " ").trim() : null; };
    setf(o, "id", a.getAttribute("data-listingid"));
    setf(o, "name", tx(".js-placardTitle, .property-title, .property-name"));
    setf(o, "price", tx(".property-pricing, .price-range, .property-rents"));
    setf(o, "beds", tx(".property-beds, .bed-range"));
    setf(o, "baths", tx(".property-baths, .bath-range"));
    setf(o, "address", tx(".property-address"));
  });
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    let d; try { d = JSON.parse(s.textContent); } catch (e) { return; }
    (Array.isArray(d) ? d : [d]).forEach((e) => {
      if (!e || typeof e !== "object") return;
      let items = [];
      if (e["@type"] === "SearchResultsPage" && e.about) items = e.about;
      else if (e.itemListElement) items = e.itemListElement.map((x) => (x && x.item) || x);
      items.forEach((it) => {
        if (!it || typeof it !== "object") return; const u = it.url || it["@id"]; if (!u) return;
        const o = slot(u), addr = it.address || {}, geo = it.geo || {};
        setf(o, "name", it.name);
        setf(o, "address", typeof addr === "string" ? addr : addr.streetAddress || null);
        setf(o, "city", typeof addr === "object" ? addr.addressLocality || null : null);
        if (geo.latitude != null) setf(o, "lat", geo.latitude);
        if (geo.longitude != null) setf(o, "lng", geo.longitude);
      });
    });
  });
  if (!map.size) throw new Error("0 listings (Akamai?)");
  return [...map.values()].map((it) => {
    let u = it.url; if (u && u.startsWith("/")) u = "https://www.apartments.com" + u;
    return L({
      source: "apartments_com", source_id: it.id || u, url: u, title: it.name || it.address || "Apartments.com listing",
      price: price(it.price), beds: beds(it.beds), baths: baths(it.baths || it.beds), sqft: sqft(it.beds),
      address: it.address || null, neighborhood: it.city || null, lat: it.lat ?? null, lng: it.lng ?? null,
    });
  });
}

// ---- orchestration --------------------------------------------------------
const SOURCES = [
  ["craigslist", liveCraigslist],
  ["redfin", liveRedfin],
  ["zillow", liveZillow],
  ["trulia", liveTrulia],
  ["apartments_com", liveApartments],
];

async function fetchLive() {
  if (!cfg().key) {
    window.SFRentals.setStatus("Add a free scraping-API key first (⚙ API key).", "warn");
    document.getElementById("liveSettings").classList.remove("hidden");
    return;
  }
  window.SFRentals.setStatus("Fetching live via scraping API… (~30–60s)", "info");
  const sources = {};
  let all = [];
  for (const [name, fn] of SOURCES) {
    try {
      const got = await fn();
      all = all.concat(got);
      sources[name] = { status: "ok", count: got.length };
      window.SFRentals.setStatus(`Fetched ${name}: ${got.length}…`, "info");
    } catch (e) {
      sources[name] = { status: "blocked", error: String(e.message || e).slice(0, 120) };
    }
  }
  // dedupe by url
  const byUrl = new Map();
  for (const l of all) { const k = (l.url || "id:" + l.source_id).replace(/\/+$/, ""); if (!byUrl.has(k)) byUrl.set(k, l); }
  const listings = [...byUrl.values()];
  window.SFRentals.setData(listings, sources);
  const ok = Object.values(sources).filter((s) => s.status === "ok").length;
  window.SFRentals.setStatus(`Live: ${listings.length} listings · ${ok}/${SOURCES.length} sources OK`, ok ? "ok" : "error");
}

// ---- settings UI wiring ---------------------------------------------------
function loadLiveForm() {
  const c = cfg();
  document.getElementById("scraperKey").value = c.key;
  document.getElementById("scraperTmpl").value = c.tmpl;
  document.getElementById("scraperProxy").value = c.proxy;
}
function saveLive() {
  localStorage.setItem("scraper_key", document.getElementById("scraperKey").value.trim());
  localStorage.setItem("scraper_tmpl", document.getElementById("scraperTmpl").value.trim());
  localStorage.setItem("scraper_proxy", document.getElementById("scraperProxy").value.trim());
  window.SFRentals.setStatus("Saved. Tap ⚡ Fetch live to load.", "ok");
}

document.getElementById("liveBtn").addEventListener("click", fetchLive);
document.getElementById("liveSettingsBtn").addEventListener("click", () =>
  document.getElementById("liveSettings").classList.toggle("hidden")
);
document.getElementById("saveLive").addEventListener("click", saveLive);
loadLiveForm();
