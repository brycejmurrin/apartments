"use strict";

let ALL = [];
let sortKey = "posted_at";
let sortDir = -1;
const activeSources = new Set();

// ---------------------------------------------------------------------------
// Data load + render
// ---------------------------------------------------------------------------
async function loadData(bust = false) {
  const url = "./data/listings.json" + (bust ? `?t=${Date.now()}` : "");
  const resp = await fetch(url, { cache: "no-store" });
  const data = await resp.json();
  ALL = data.listings || [];

  const when = data.generated_at ? new Date(data.generated_at).toLocaleString() : "never";
  const srcSummary = Object.entries(data.sources || {})
    .map(([k, v]) => `${k}: ${v.status === "ok" ? v.count : v.status}`)
    .join(" · ");
  document.getElementById("meta").textContent =
    `${data.total || 0} listings · last crawl: ${when}` + (srcSummary ? ` · ${srcSummary}` : "");

  buildSourceFilters(data.sources || {});
  render();
}

function buildSourceFilters(sources) {
  const container = document.getElementById("sourceFilters");
  const names = new Set([...ALL.map((l) => l.source), ...Object.keys(sources)]);
  if (activeSources.size === 0) names.forEach((n) => activeSources.add(n));
  container.innerHTML = "";
  [...names].sort().forEach((name) => {
    const id = `src_${name}`;
    const label = document.createElement("label");
    label.className = "chip";
    label.innerHTML =
      `<input type="checkbox" id="${id}" ${activeSources.has(name) ? "checked" : ""}/> ${name}`;
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
    if (!activeSources.has(l.source)) return false;
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
    if (l.stale) tr.className = "stale";
    tr.innerHTML = `
      <td>${l.price != null ? "$" + l.price.toLocaleString() : "—"}</td>
      <td>${l.beds != null ? l.beds : "—"}</td>
      <td>${l.sqft != null ? l.sqft.toLocaleString() : "—"}</td>
      <td><a href="${l.url}" target="_blank" rel="noopener">${escapeHtml(l.title || l.url)}</a>${l.stale ? ' <span class="badge">stale</span>' : ""}</td>
      <td>${escapeHtml(l.neighborhood || "")}</td>
      <td><span class="src src-${l.source}">${l.source}</span></td>
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
document.getElementById("refreshBtn").addEventListener("click", async () => {
  setStatus("Reloading…", "info");
  try {
    await loadData(true);
    setStatus("Up to date.", "ok");
    setTimeout(() => document.getElementById("status").classList.add("hidden"), 1500);
  } catch (e) {
    setStatus(`Failed to load data: ${e.message}`, "error");
  }
});
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

loadData();
