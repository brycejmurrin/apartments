"""Redfin adapter.

Redfin exposes an internal ("stingray") JSON API that the website itself calls.
Responses are prefixed with the anti-JSON-hijacking token `{}&&`, which we strip
before parsing. Two calls:

1. location-autocomplete -> resolve "San Francisco" to a region id
2. search/rentals        -> rentals within that region

This is undocumented and may change; the adapter degrades gracefully (returns
[]) if the shape shifts or Redfin blocks the request.
"""
from __future__ import annotations

import json
from typing import List, Optional

from .. import http
from ..config import Criteria
from ..models import Listing

name = "redfin"

_PREFIX = "{}&&"


def _strip(text: str) -> str:
    return text[len(_PREFIX):] if text.startswith(_PREFIX) else text


def _resolve_region(c: Criteria) -> Optional[dict]:
    resp = http.get(
        "https://www.redfin.com/stingray/do/location-autocomplete",
        params={"location": f"{c.city}, {c.state}", "v": 2},
    )
    data = json.loads(_strip(resp.text))
    sections = data.get("payload", {}).get("sections", [])
    for section in sections:
        for row in section.get("rows", []):
            # type "6" == place/city in Redfin's region taxonomy
            if str(row.get("type")) == "6" and row.get("id"):
                rid = row["id"].split("_")[-1]  # ids look like "6_12345"
                return {"region_id": rid, "region_type": 6}
    return None


def _to_cents(dollars: Optional[int]) -> Optional[int]:
    return dollars * 100 if dollars is not None else None


def search(c: Criteria) -> List[Listing]:
    region = _resolve_region(c)
    if not region:
        return []

    params = {
        "al": 1,
        "region_id": region["region_id"],
        "region_type": region["region_type"],
        "num_homes": 350,
        "ord": "redfin-recommended-asc",
        "page_number": 1,
        "uipt": "1,2,3,4,7,8",  # property types
        "v": 8,
        "min_beds": c.min_bedrooms,
    }
    if c.max_bedrooms:
        params["max_beds"] = c.max_bedrooms
    if c.min_price:
        params["min_price"] = c.min_price
    if c.max_price:
        params["max_price"] = c.max_price

    resp = http.get(
        "https://www.redfin.com/stingray/api/v1/search/rentals", params=params
    )
    data = json.loads(_strip(resp.text))
    homes = data.get("homes") or data.get("payload", {}).get("homes") or []

    listings: List[Listing] = []
    for home in homes:
        home_id = home.get("rentalId") or home.get("propertyId") or home.get("listingId")
        if not home_id:
            continue
        rent = home.get("rentPriceRange") or {}
        price = rent.get("min") or rent.get("max")
        beds = home.get("beds") or (home.get("bedRange") or {}).get("min")
        url_path = home.get("url", "")
        listings.append(
            Listing(
                source=name,
                source_id=str(home_id),
                url=f"https://www.redfin.com{url_path}" if url_path else "",
                title=home.get("streetLine", {}).get("value")
                or home.get("name")
                or "Redfin rental",
                price=int(price) if isinstance(price, (int, float)) else None,
                beds=float(beds) if isinstance(beds, (int, float)) else None,
                baths=home.get("baths"),
                sqft=(home.get("sqFt") or {}).get("value"),
                address=home.get("streetLine", {}).get("value"),
                neighborhood=(home.get("neighborhood") or None),
                lat=(home.get("latLong") or {}).get("latitude"),
                lng=(home.get("latLong") or {}).get("longitude"),
            )
        )
    return listings
