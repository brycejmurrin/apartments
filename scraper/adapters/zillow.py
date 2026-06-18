"""Zillow adapter (best-effort).

WARNING: Zillow uses PerimeterX/HUMAN bot protection and almost always blocks
datacenter IPs (including GitHub Actions runners). Expect this adapter to return
[] from CI. It works most reliably when run from a residential IP. To make it
robust you would route `scraper.http` through a residential proxy.

Strategy: fetch the rentals search page and read listing data out of the
embedded `__NEXT_DATA__` / cat1 search results blob.
"""
from __future__ import annotations

from typing import List

from .. import http
from ..config import Criteria
from ..models import Listing
from ._embedded import extract_next_data

name = "zillow"


def _search_url(c: Criteria) -> str:
    city = c.city.lower().replace(" ", "-")
    beds = c.min_bedrooms
    return f"https://www.zillow.com/{city}-{c.state.lower()}/rentals/{beds}-bedrooms/"


def _walk_listings(node, out: List[dict]) -> None:
    """Recursively collect dicts that look like a rental result."""
    if isinstance(node, dict):
        if node.get("zpid") and ("price" in node or "units" in node):
            out.append(node)
        for v in node.values():
            _walk_listings(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk_listings(v, out)


def search(c: Criteria) -> List[Listing]:
    resp = http.get(_search_url(c))
    data = extract_next_data(resp.text)
    if not data:
        return []

    raw: List[dict] = []
    _walk_listings(data, raw)

    listings: List[Listing] = []
    seen = set()
    for home in raw:
        zpid = str(home.get("zpid"))
        if zpid in seen:
            continue
        seen.add(zpid)
        price_text = home.get("price") or ""
        listings.append(
            Listing(
                source=name,
                source_id=zpid,
                url=home.get("detailUrl") or f"https://www.zillow.com/homedetails/{zpid}_zpid/",
                title=home.get("address") or home.get("statusText") or "Zillow rental",
                price=_price(price_text),
                beds=home.get("beds"),
                baths=home.get("baths"),
                sqft=home.get("area"),
                address=home.get("address"),
                lat=(home.get("latLong") or {}).get("latitude"),
                lng=(home.get("latLong") or {}).get("longitude"),
            )
        )
    return listings


def _price(text) -> int | None:
    if isinstance(text, (int, float)):
        return int(text)
    if isinstance(text, str):
        digits = "".join(ch for ch in text if ch.isdigit())
        if digits:
            return int(digits[:6]) if len(digits) <= 6 else None
    return None
