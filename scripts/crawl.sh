#!/usr/bin/env bash
# Run the crawler locally (from your residential IP) and publish the results.
# Listing sites block datacenter/cloud IPs, so this must run on your own machine,
# not in CI. After it pushes, GitHub Pages serves the updated docs/data within a
# minute or so.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Running crawler…"
python -m scraper.run

if git diff --quiet -- docs/data/listings.json; then
  echo "No changes to listings — nothing to publish."
  exit 0
fi

git add docs/data/listings.json
git commit -m "data: local crawl $(date -u +%Y-%m-%dT%H:%MZ)"

branch="$(git rev-parse --abbrev-ref HEAD)"
echo "Pushing to origin/$branch…"
git push origin "$branch"
echo "Done. The live page will refresh shortly."
