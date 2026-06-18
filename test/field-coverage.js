#!/usr/bin/env node
// Field coverage audit — node test/field-coverage.js
// Reads docs/data/listings.json and shows what fields are populated per source.
// Run after a scrape to see what data each site is actually providing.

"use strict";
const fs = require("fs");
const path = require("path");

const jsonPath = path.join(__dirname, "../docs/data/listings.json");
if (!fs.existsSync(jsonPath)) {
  console.error("No listings.json found — run the scraper first.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const listings = data.listings || [];

console.log(`\nData generated: ${data.generated_at}`);
console.log(`Total listings: ${listings.length}\n`);

const FIELDS = ["price", "beds", "baths", "sqft", "address", "neighborhood", "lat", "lng", "posted_at"];
// Fields where 0 is a valid value (e.g. studio = 0 beds)
const ZERO_OK = new Set(["beds", "baths", "lat", "lng"]);

const bySource = {};
for (const l of listings) {
  (bySource[l.source] = bySource[l.source] || []).push(l);
}

for (const [src, items] of Object.entries(bySource)) {
  console.log(`${"─".repeat(60)}`);
  console.log(`  ${src.toUpperCase()}  (${items.length} listings)`);
  console.log(`${"─".repeat(60)}`);

  for (const f of FIELDS) {
    const populated = items.filter((l) => {
      const v = l[f];
      if (v == null || v === "") return false;
      if (!ZERO_OK.has(f) && v === 0) return false;
      return true;
    }).length;
    const pct = Math.round((populated / items.length) * 100);
    const filled = Math.round(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const flag = pct === 0 ? " ⚠" : pct < 50 ? " ▲" : "";
    console.log(`  ${f.padEnd(14)} [${bar}] ${String(pct).padStart(3)}%  (${populated}/${items.length})${flag}`);
  }

  console.log("\n  Sample listings:");
  for (const l of items.slice(0, 3)) {
    const parts = [
      l.price != null ? `$${l.price.toLocaleString()}` : "no-price",
      l.beds != null ? `${l.beds}br` : "no-beds",
      l.baths != null ? `${l.baths}ba` : "no-baths",
      l.sqft != null ? `${l.sqft}sqft` : "no-sqft",
      l.neighborhood || "no-neighborhood",
    ];
    const title = (l.title || l.url || "").slice(0, 55);
    console.log(`    ${parts.join(" | ")}  — ${title}`);
  }
  console.log("");
}

// Cross-source summary
console.log(`${"═".repeat(60)}`);
console.log("  SUMMARY");
console.log(`${"═".repeat(60)}`);
for (const f of FIELDS) {
  const populated = listings.filter((l) => {
    const v = l[f];
    if (v == null || v === "") return false;
    if (!ZERO_OK.has(f) && v === 0) return false;
    return true;
  }).length;
  const pct = Math.round((populated / listings.length) * 100);
  const flag = pct === 0 ? " ⚠ EMPTY" : pct < 30 ? " ▲ low" : "";
  console.log(`  ${f.padEnd(14)} ${String(pct).padStart(3)}%  (${populated}/${listings.length})${flag}`);
}
console.log("");
