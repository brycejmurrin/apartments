"""Apartments.com adapter (best-effort).

Apartments.com (CoStar) sits behind Cloudflare and bot detection; datacenter/CI
IPs are frequently challenged, so expect [] from Actions. The page embeds its
results as JSON-LD and in a JS `pageData`-style object; we read the JSON-LD
`about`/`itemListElement` array, which is the most stable surface.
"""
from __future__ import annotations

import json
import re
from typing import List

from .. import http
from ..config import Criteria
from ..models import Listing

name = "apartments_com"

_JSONLD_RE = re.compile(
    r'<script type="application/ld\+json">(.*?)</script>', re.DOTALL
)


def _search_url(c: Criteria) -> str:
    city = c.city.lower().replace(" ", "-")
    return f"https://www.apartments.com/{city}-{c.state.lower()}/{c.min_bedrooms}-bedrooms/"


def search(c: Criteria) -> List[Listing]:
    resp = http.get(_search_url(c))
    listings: List[Listing] = []
    seen = set()

    for block in _JSONLD_RE.findall(resp.text):
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        items = []
        if isinstance(data, dict) and data.get("@type") == "SearchResultsPage":
            items = (data.get("about") or [])
        elif isinstance(data, dict) and "itemListElement" in data:
            items = [el.get("item", el) for el in data["itemListElement"]]
        for item in items:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("@id")
            if not url or url in seen:
                continue
            seen.add(url)
            addr = item.get("address") or {}
            if isinstance(addr, dict):
                street = addr.get("streetAddress")
                hood = addr.get("addressLocality")
            else:
                street = hood = None
            listings.append(
                Listing(
                    source=name,
                    source_id=url.rstrip("/").split("/")[-2] if url.endswith("/") else url.rstrip("/").split("/")[-1],
                    url=url,
                    title=item.get("name") or street or "Apartments.com listing",
                    address=street,
                    neighborhood=hood,
                )
            )
    return listings
