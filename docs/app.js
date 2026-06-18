"use strict";

const WORKFLOW_FILE = "crawl.yml";
const DEFAULT_BRANCH = "claude/multi-site-rental-scraper-kto2c3";

let ALL = [];
let sortKey = "posted_at";
let sortDir = -1;
const activeSources = new Set();

// ---------------------------------------------------------------------------
// Settings (persisted in localStorage) + owner/repo auto-detection
// ---------------------------------------------------------------------------
function detectRepo() {
  // On GitHub Pages the URL is https://OWNER.github.io/REPO/
  const host = location.hostname;
  let owner = "";
  let repo = "";
  if (host.endsWith("github.io")) {
    owner = host.split(".")[0];
    repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
  }
  return { owner, repo };
}

function getSettings() {
  const detected = detectRepo();
  return {
    owner: localStorage.getItem("gh_owner") || detected.owner,
    repo: localStorage.getItem("gh_repo") || detected.repo,
    branch: localStorage.getItem("gh_branch") || DEFAULT_BRANCH,
    token: localStorage.getItem("gh_token") || "",
  };
}

function loadSettingsForm() {
  const s = getSettings();
  document.getElementById("owner").value = s.owner;
  document.getElementById("repo").value = s.repo;
  document.getElementById("branch").value = s.branch;
  document.getElementById("token").value = s.token;
  updateActionsLink();
}

function saveSettings() {
  localStorage.setItem("gh_owner", document.getElementById("owner").value.trim());
  localStorage.setItem("gh_repo", document.getElementById("repo").value.trim());
  localStorage.setItem("gh_branch", document.getElementById("branch").value.trim());
  localStorage.setItem("gh_token", document.getElementById("token").value.trim());
  updateActionsLink();
  setStatus("Settings saved.", "ok");
}

function updateActionsLink() {
  const s = getSettings();
  const link = document.getElementById("actionsLink");
  if (s.owner && s.repo) {
    link.href = `https://github.com/${s.owner}/${s.repo}/actions/workflows/${WORKFLOW_FILE}`;
  }
}

// ---------------------------------------------------------------------------
// Trigger the crawler via the GitHub Actions API (workflow_dispatch)
// ---------------------------------------------------------------------------
async function runCrawler() {
  const s = getSettings();
  if (!s.token || !s.owner || !s.repo) {
    setStatus("Add a token, owner and repo in Settings first (or use the Actions tab link).", "warn");
    document.getElementById("settings").classList.remove("hidden");
    return;
  }
  setStatus("Dispatching workflow…", "info");
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${s.owner}/${s.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${s.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: s.branch }),
      }
    );
    if (resp.status === 204) {
      setStatus("Crawler started. Polling for completion…", "info");
      pollRun(s);
    } else {
      const body = await resp.text();
      setStatus(`Dispatch failed (${resp.status}): ${body}`, "error");
    }
  } catch (e) {
    setStatus(`Dispatch error: ${e.message}`, "error");
  }
}

async function pollRun(s, attempt = 0) {
  if (attempt > 40) {
    setStatus("Still running — refresh later to see results.", "warn");
    return;
  }
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${s.owner}/${s.repo}/actions/workflows/${WORKFLOW_FILE}/runs?branch=${encodeURIComponent(s.branch)}&per_page=1`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: "application/vnd.github+json" } }
    );
    const data = await resp.json();
    const run = (data.workflow_runs || [])[0];
    if (run) {
      if (run.status === "completed") {
        if (run.conclusion === "success") {
          setStatus("Crawl complete — reloading results.", "ok");
          setTimeout(() => loadData(true), 3000); // give the commit a moment
          return;
        }
        setStatus(`Crawl finished: ${run.conclusion}.`, "warn");
        return;
      }
      setStatus(`Crawler ${run.status}… (${attempt}s)`, "info");
    }
  } catch (e) {
    /* keep polling */
  }
  setTimeout(() => pollRun(s, attempt + 5), 5000);
}

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
document.getElementById("runBtn").addEventListener("click", runCrawler);
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

loadSettingsForm();
loadData();
