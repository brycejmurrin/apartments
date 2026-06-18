"""Run adapters, merge with previous results, write the JSON the site reads.

Key behavior: if a source returns nothing this run (commonly because it was
blocked), we *keep* that source's listings from the previous run and mark them
`stale=True`, rather than letting the table empty out. Successful sources fully
replace their own prior listings.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

from .adapters import ADAPTERS
from .config import Criteria
from .models import Listing

log = logging.getLogger("scraper")

OUTPUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "listings.json"


def _matches(listing: Listing, c: Criteria) -> bool:
    if listing.price is not None:
        if c.min_price is not None and listing.price < c.min_price:
            return False
        if c.max_price is not None and listing.price > c.max_price:
            return False
    if listing.beds is not None:
        if listing.beds < c.min_bedrooms or listing.beds > c.max_bedrooms:
            return False
    return True


def _load_previous() -> dict:
    if OUTPUT.exists():
        try:
            return json.loads(OUTPUT.read_text())
        except json.JSONDecodeError:
            pass
    return {"listings": [], "sources": {}}


def run(c: Criteria) -> dict:
    previous = _load_previous()
    prev_by_key = {l["source"] + ":" + l["source_id"]: l for l in previous.get("listings", [])}

    sources: Dict[str, dict] = {}
    merged: List[dict] = []

    for adapter in ADAPTERS:
        name = adapter.name
        try:
            found = [l for l in adapter.search(c) if _matches(l, c)]
            # Preserve first_seen across runs.
            for l in found:
                prior = prev_by_key.get(l.key())
                l.first_seen = (prior or {}).get("first_seen") or l.scraped_at
            merged.extend(l.to_dict() for l in found)
            sources[name] = {
                "status": "ok",
                "count": len(found),
                "error": None,
                "last_success": datetime.now(timezone.utc).isoformat(),
            }
            log.info("%s: %d listings", name, len(found))
        except Exception as exc:  # noqa: BLE001 - one bad source must not kill the run
            log.warning("%s failed: %s", name, exc)
            # Carry over this source's previous listings, marked stale.
            carried = [
                {**l, "stale": True}
                for l in previous.get("listings", [])
                if l["source"] == name
            ]
            merged.extend(carried)
            prev_meta = previous.get("sources", {}).get(name, {})
            sources[name] = {
                "status": "blocked",
                "count": len(carried),
                "error": str(exc)[:200],
                "last_success": prev_meta.get("last_success"),
            }

    # Sort newest first; stale and price-less listings sink slightly.
    merged.sort(
        key=lambda l: (not l.get("stale"), l.get("posted_at") or l.get("scraped_at") or ""),
        reverse=True,
    )

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "criteria": c.to_dict(),
        "sources": sources,
        "total": len(merged),
        "listings": merged,
    }
    return result


def write(result: dict) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(result, indent=2))
    log.info("wrote %d listings -> %s", result["total"], OUTPUT)
