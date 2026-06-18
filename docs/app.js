"use strict";

// Search criteria (matches the project's focus). Change here if you like.
const CRITERIA = { city: "San Francisco", state: "CA", bedrooms: 2, limit: 200 };

const API_DEFAULTS = { base: "https://api.rentcast.io/v1", proxy: "" };
const CACHE_KEY = "live_cache_v1";

let ALL = [];
let sortKey = "posted_at";
let sortDir = -1;
const activeSources = new Set();

// ---------------------------------------------------------------------------
// Settings (API key etc.) — persisted in localStorage, never uploaded
// ---------------------------------------------------------------------------
function getApi() {
  return {
    key: localStorage.getItem("api_key") || "",
    base: localStorage.getItem("api_base") || API_DEFAULTS.base,
    proxy: localStorage.getItem("api_proxy") || API_DEFAULTS.proxy,
  };
}
function loadSettingsForm() {
  const a = getApi();
  document.getElementById("apiKey").value = a.key;
  document.getElementById("apiBase").value = a.base;
  document.getElementById("apiProxy").value = a.proxy;
}
function saveSettings() {
  localStorage.setItem("api_key", document.getElementById("apiKey").value.trim());
  localStorage.setItem("api_base", document.getElementById("apiBase").value.trim() || API_DEFAULTS.base);
  localStorage.setItem("api_proxy", document.getElementById("apiProxy").value.trim());
  setStatus("Saved. Tap “⚡ Fetch live” to load listings.", "ok");
}

// ---------------------------------------------------------------------------
// Live fetch from the rental API (RentCast by default)
// ---------------------------------------------------------------------------
function buildUrl(a) {
  const q = new URLSearchParams({
    city: CRITERIA.city,
    state: CRITERIA.state,
    bedrooms: String(CRITERIA.bedrooms),
    status: "Active",
    limit: String(CRITERIA.limit),
  });
  const direct = `${a.base}/listings/rental/long-term?${q}`;
  return a.proxy ? a.proxy + encodeURIComponent(direct) : direct;
}

async function fetchLive() {
  const a = getApi();
  if (!a.key) {
    setStatus("Add a free API key first (⚙ API key).", "warn");
    document.getElementById("settings").classList.remove("hidden");
    return;
  }
  setStatus("Fetching live listings…", "info");
  try {
    const resp = await fetch(buildUrl(a), {
      headers: { "X-Api-Key": a.key, Accept: "application/json" },
    });
    if (!resp.ok) {
      const body = await resp.text();
      setStatus(`API error ${resp.status}: ${body.slice(0, 200)}`, "error");
      return;
    }
    const raw = await resp.json();
    const items = Array.isArray(raw) ? raw : raw.listings || raw.data || [];
    ALL = items.map(mapListing).filter((l) => l.beds == null || l.beds === CRITERIA.bedrooms);

    const payload = { generated_at: new Date().toISOString(), total: ALL.length, listings: ALL };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    renderMeta(payload, "live");
    activeSources.clear();
    buildSourceFilters();
    render();
    setStatus(`Loaded ${ALL.length} listings.`, "ok");
    setTimeout(() => document.getElementById("status").classList.add("hidden"), 2000);
  } catch (e) {
    // A TypeError here is almost always the browser blocking the response (CORS).
    setStatus(
      `Couldn't reach the API: ${e.message}. If this says "Failed to fetch", the ` +
      `API may not allow direct browser calls — set a CORS proxy prefix under ⚙ API key.`,
      "error"
    );
  }
}

// Map a RentCast listing object onto the table's shape. Defensive about keys.
function mapListing(r) {
  const address = r.formattedAddress || r.addressLine1 || "";
  const priceNum = typeof r.price === "number" ? r.price : parseInt(r.price, 10) || null;
  return {
    source: "rentcast",
    source_id: String(r.id || address),
    url:
      r.listingUrl ||
      `https://www.google.com/search?q=${encodeURIComponent((address || "") + " for rent")}`,
    title: address || "Rental",
    price: priceNum,
    beds: r.bedrooms != null ? Number(r.bedrooms) : null,
    baths: r.bathrooms != null ? Number(r.bathrooms) : null,
    sqft: r.squareFootage != null ? Number(r.squareFootage) : null,
    address,
    neighborhood: r.city || null,
    lat: r.latitude ?? null,
    lng: r.longitude ?? null,
    posted_at: r.listedDate || r.lastSeenDate || null,
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderMeta(data, mode) {
  const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : "never";
  document.getElementById("meta").textContent =
    `${data.total || 0} listings · ${mode === "live" ? "fetched" : "cached"}: ${when}`;
}

function buildSourceFilters() {
  const container = document.getElementById("sourceFilters");
  const names = new Set(ALL.map((l) => l.source));
  if (activeSources.size === 0) names.forEach((n) => activeSources.add(n));
  container.innerHTML = "";
  [...names].sort().forEach((name) => {
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML = `<input type="checkbox" ${activeSources.has(name) ? "checked" : ""}/> ${name}`;
    label.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? activeSources.add(name) : activeSources.delete(name);
      render();
    });
    container.appendChild(label);
  });
}

function filtered() {
  const q = document.getElementById("search").value.toLowerCase();
  const min = parseInt(document.getElementById("minPrice").value, 10);
  const max = parseInt(document.getElementById("maxPrice").value, 10);
  return ALL.filter((l) => {
    if (activeSources.size && !activeSources.has(l.source)) return false;
    if (!isNaN(min) && (l.price == null || l.price < min)) return false;
    if (!isNaN(max) && (l.price == null || l.price > max)) return false;
    if (q) {
      const hay = `${l.title || ""} ${l.neighborhood || ""} ${l.address || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const rows = filtered().sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });
  const tbody = document.getElementById("rows");
  tbody.innerHTML = "";
  for (const l of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${l.price != null ? "$" + l.price.toLocaleString() : "—"}</td>
      <td>${l.beds != null ? l.beds : "—"}</td>
      <td>${l.sqft != null ? l.sqft.toLocaleString() : "—"}</td>
      <td><a href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.title || l.url)}</a></td>
      <td>${escapeHtml(l.neighborhood || "")}</td>
      <td><span class="src">${l.source}</span></td>
      <td>${l.posted_at ? new Date(l.posted_at).toLocaleDateString() : "—"}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById("count").textContent = `${rows.length} shown`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = `status ${kind || ""}`;
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Startup: show cached results if we have them; otherwise prompt to fetch
// ---------------------------------------------------------------------------
async function init() {
  loadSettingsForm();
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const data = JSON.parse(cached);
      ALL = data.listings || [];
      renderMeta(data, "cache");
      buildSourceFilters();
      render();
      return;
    } catch (_) {}
  }
  // No live cache yet — fall back to any committed crawl data (the optional
  // `make crawl` path writes docs/data/listings.json).
  try {
    const resp = await fetch("./data/listings.json", { cache: "no-store" });
    const data = await resp.json();
    if (data.listings && data.listings.length) {
      ALL = data.listings;
      renderMeta(data, "cache");
      buildSourceFilters();
      render();
      return;
    }
  } catch (_) {}
  document.getElementById("meta").textContent =
    "No listings yet — add an API key (⚙) and tap ⚡ Fetch live.";
}

document.getElementById("fetchBtn").addEventListener("click", fetchLive);
document.getElementById("settingsBtn").addEventListener("click", () =>
  document.getElementById("settings").classList.toggle("hidden")
);
document.getElementById("saveSettings").addEventListener("click", saveSettings);
["search", "minPrice", "maxPrice"].forEach((id) =>
  document.getElementById(id).addEventListener("input", render)
);
document.querySelectorAll("th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    sortDir = sortKey === key ? -sortDir : -1;
    sortKey = key;
    render();
  })
);

init();
