"""Trulia adapter (best-effort).

Trulia is owned by Zillow and shares the same PerimeterX bot protection, so the
same caveat applies: expect [] from datacenter/CI IPs. Data lives in the Next.js
`__NEXT_DATA__` blob.
"""
from __future__ import annotations

from typing import List

from .. import http
from ..config import Criteria
from ..models import Listing
from ._embedded import extract_next_data

name = "trulia"


def _search_url(c: Criteria) -> str:
    city = c.city.replace(" ", "_")
    return f"https://www.trulia.com/for_rent/{city},{c.state}/{c.min_bedrooms}p_beds/"


def _walk(node, out: List[dict]) -> None:
    if isinstance(node, dict):
        # Trulia home cards carry an "url" + "location" + "price" shape.
        if node.get("__typename") == "HOME" or (node.get("url") and node.get("price")):
            out.append(node)
        for v in node.values():
            _walk(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out)


def search(c: Criteria) -> List[Listing]:
    resp = http.get(_search_url(c))
    data = extract_next_data(resp.text)
    if not data:
        return []

    raw: List[dict] = []
    _walk(data, raw)

    listings: List[Listing] = []
    seen = set()
    for home in raw:
        url = home.get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        if url.startswith("/"):
            url = "https://www.trulia.com" + url
        price = home.get("price")
        if isinstance(price, dict):
            price = price.get("price") or price.get("formattedPrice")
        loc = home.get("location") or {}
        listings.append(
            Listing(
                source=name,
                source_id=url.rstrip("/").split("/")[-1],
                url=url,
                title=loc.get("fullLocation") or loc.get("city") or "Trulia rental",
                price=_int(price),
                beds=(home.get("bedrooms") or {}).get("value") if isinstance(home.get("bedrooms"), dict) else home.get("bedrooms"),
                baths=(home.get("bathrooms") or {}).get("value") if isinstance(home.get("bathrooms"), dict) else home.get("bathrooms"),
                address=loc.get("fullLocation"),
                lat=(home.get("coordinates") or {}).get("latitude"),
                lng=(home.get("coordinates") or {}).get("longitude"),
            )
        )
    return listings


def _int(value) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = "".join(ch for ch in value if ch.isdigit())
        return int(digits[:6]) if digits else None
    return None
