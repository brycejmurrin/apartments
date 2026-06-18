"use strict";

// Static dashboard for docs/data/listings.json — the file the Scriptable
// scraper (or `make crawl`) pushes to this repo. No API keys, no live fetch:
// the page just renders whatever listings have been committed.

let ALL = [];
let sortKey = "posted_at";
let sortDir = -1;
const activeSources = new Set();

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
async function load() {
  setStatus("Loading latest listings…", "info");
  try {
    const resp = await fetch("./data/listings.json?t=" + Date.now(), { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    ALL = data.listings || [];
    renderMeta(data);
    renderSources(data.sources || {});
    activeSources.clear();
    buildSourceFilters();
    render();
    if (ALL.length) {
      setStatus(`Loaded ${ALL.length} listings.`, "ok");
      setTimeout(() => document.getElementById("status").classList.add("hidden"), 1500);
    } else {
      setStatus("No listings yet — run the Scriptable scraper on your phone, then Refresh.", "warn");
    }
  } catch (e) {
    setStatus("Couldn't load listings.json: " + e.message, "error");
    document.getElementById("meta").textContent = "No data yet.";
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderMeta(data) {
  const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : "never";
  document.getElementById("meta").textContent = `${data.total || 0} listings · updated ${when}`;
}

function renderSources(sources) {
  const el = document.getElementById("sources");
  const entries = Object.entries(sources);
  if (!entries.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = entries
    .map(([name, s]) => {
      const ok = s.status === "ok";
      const label = ok ? `${s.count}` : "blocked";
      const title = s.error ? ` title="${escapeHtml(s.error)}"` : "";
      return `<span class="src-stat ${ok ? "ok" : "bad"}"${title}>${name}: ${label}</span>`;
    })
    .join("");
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
  const minB = parseInt(document.getElementById("minBeds").value, 10);
  const maxB = parseInt(document.getElementById("maxBeds").value, 10);
  return ALL.filter((l) => {
    if (activeSources.size && !activeSources.has(l.source)) return false;
    if (!isNaN(min) && (l.price == null || l.price < min)) return false;
    if (!isNaN(max) && (l.price == null || l.price > max)) return false;
    if (!isNaN(minB) && (l.beds == null || l.beds < minB)) return false;
    if (!isNaN(maxB) && (l.beds == null || l.beds > maxB)) return false;
    if (q) {
      const hay = `${l.title || ""} ${l.neighborhood || ""} ${l.address || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const rows = filtered().sort((a, b) => {
    let av = a[sortKey],
      bv = b[sortKey];
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
// Wire up
// ---------------------------------------------------------------------------
document.getElementById("refreshBtn").addEventListener("click", load);
["search", "minPrice", "maxPrice", "minBeds", "maxBeds"].forEach((id) =>
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

load();
