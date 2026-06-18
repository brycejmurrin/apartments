"""Zillow adapter (GetSearchPageState).

WARNING: Zillow uses PerimeterX/HUMAN bot protection and almost always blocks
datacenter IPs (including GitHub Actions runners). Expect this adapter to be
blocked (HTTP 403/429) from CI. It works most reliably when run from a
residential IP; to make it robust in CI you would route `scraper.http` through a
residential proxy.

The shared HTTP client now uses curl_cffi Chrome TLS/HTTP2 impersonation, and
this adapter additionally primes cookies by first loading the human-facing
rentals page in a persistent session before calling the JSON endpoint with the
same session. This improves the odds of clearing fingerprint-based blocks, but
PerimeterX's JS sensor challenge cannot be satisfied by a non-browser client, so
requests may still be blocked.

Strategy: hit the same JSON endpoint the Zillow web app itself calls to populate
its rentals search map/list:

    GET https://www.zillow.com/search/GetSearchPageState.htm

The endpoint takes a URL-encoded ``searchQueryState`` JSON blob describing the
map bounds + filters, a ``wants`` blob selecting which result buckets to return,
and a ``requestId``. The response is JSON; rental cards live under
``cat1.searchResults.listResults``. This is far more stable than scraping the
embedded ``__NEXT_DATA__`` HTML blob.
"""
from __future__ import annotations

import json
from typing import List, Optional

from .. import http
from ..config import Criteria
from ..models import Listing

name = "zillow"

# Approximate bounding box covering the city of San Francisco. Zillow requires a
# map bounds even when the map is hidden; this box is wide enough to capture the
# whole city without spilling far into the Bay/Pacific. If the configured city is
# not SF these bounds are still sent (usersSearchTerm drives the actual query),
# so results are filtered by the search term rather than the box alone.
_SF_MAP_BOUNDS = {
    "west": -122.55,
    "east": -122.35,
    "south": 37.70,
    "north": 37.83,
}


def _to_int(value) -> Optional[int]:
    """Coerce a numeric/str price-ish value into an int, else None."""
    if value is None:
        return None
    if isinstance(value, bool):  # bool is an int subclass; reject it
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = "".join(ch for ch in value if ch.isdigit())
        if digits:
            try:
                return int(digits)
            except ValueError:
                return None
    return None


def _to_float(value) -> Optional[float]:
    """Coerce a numeric/str value into a float, else None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _abs_url(detail_url: Optional[str], zpid: Optional[str]) -> str:
    """Make a detailUrl absolute, falling back to a zpid-based URL."""
    if detail_url:
        if detail_url.startswith("/"):
            return "https://www.zillow.com" + detail_url
        return detail_url
    if zpid:
        return f"https://www.zillow.com/homedetails/{zpid}_zpid/"
    return "https://www.zillow.com/"


def _search_query_state(c: Criteria) -> dict:
    """Build the searchQueryState payload Zillow's web app sends."""
    beds: dict = {}
    if c.min_bedrooms is not None:
        beds["min"] = c.min_bedrooms
    if c.max_bedrooms is not None:
        beds["max"] = c.max_bedrooms

    price: dict = {}
    if c.min_price is not None:
        price["min"] = c.min_price
    if c.max_price is not None:
        price["max"] = c.max_price

    filter_state = {
        "isForRent": {"value": True},
        "isForSaleByAgent": {"value": False},
        "isForSaleByOwner": {"value": False},
        "isNewConstruction": {"value": False},
        "isComingSoon": {"value": False},
        "isAuction": {"value": False},
        "isForSaleForeclosure": {"value": False},
    }
    if beds:
        filter_state["beds"] = beds
    if price:
        filter_state["price"] = price

    return {
        "pagination": {},
        "usersSearchTerm": f"{c.city}, {c.state}",
        "mapBounds": dict(_SF_MAP_BOUNDS),
        "isMapVisible": False,
        "filterState": filter_state,
        "isListVisible": True,
    }


def _referer(c: Criteria) -> str:
    slug = c.city.strip().lower().replace(" ", "-")
    return f"https://www.zillow.com/{slug}-{c.state.lower()}/rentals/"


def _result_list(data: dict) -> List[dict]:
    """Pull cat1.searchResults.listResults defensively."""
    if not isinstance(data, dict):
        return []
    cat1 = data.get("cat1") or {}
    results = (cat1.get("searchResults") or {}) if isinstance(cat1, dict) else {}
    list_results = results.get("listResults") if isinstance(results, dict) else None
    return list_results if isinstance(list_results, list) else []


def _listings_from_result(home: dict) -> List[Listing]:
    """Map a single listResults entry to one Listing, or several when it has
    a ``units`` array (apartment buildings advertising multiple rents)."""
    if not isinstance(home, dict):
        return []

    zpid = home.get("zpid")
    zpid_str = str(zpid) if zpid is not None else ""
    url = _abs_url(home.get("detailUrl"), zpid_str)
    address = home.get("address") or home.get("addressStreet")
    lat_long = home.get("latLong") or {}
    lat = _to_float(lat_long.get("latitude"))
    lng = _to_float(lat_long.get("longitude"))
    baths = _to_float(home.get("baths"))
    sqft = _to_int(home.get("area"))

    units = home.get("units")
    if isinstance(units, list) and units:
        out: List[Listing] = []
        for i, unit in enumerate(units):
            if not isinstance(unit, dict):
                continue
            unit_beds = _to_float(unit.get("beds"))
            if unit_beds is None:
                unit_beds = _to_float(home.get("beds"))
            unit_price = _to_int(unit.get("price"))
            # A building's units share the same zpid; disambiguate the source_id
            # so they don't collapse during dedupe.
            unit_id = unit.get("unitId") or unit.get("rentZestimate")
            source_id = f"{zpid_str}-{unit_id}" if unit_id else f"{zpid_str}-{i}"
            out.append(
                Listing(
                    source=name,
                    source_id=source_id,
                    url=url,
                    title=address or "Zillow rental",
                    price=unit_price,
                    beds=unit_beds,
                    baths=baths,
                    sqft=sqft,
                    address=address,
                    lat=lat,
                    lng=lng,
                )
            )
        if out:
            return out

    price = _to_int(home.get("unformattedPrice"))
    if price is None:
        price = _to_int(home.get("price"))

    return [
        Listing(
            source=name,
            source_id=zpid_str,
            url=url,
            title=address or home.get("statusText") or "Zillow rental",
            price=price,
            beds=_to_float(home.get("beds")),
            baths=baths,
            sqft=sqft,
            address=address,
            lat=lat,
            lng=lng,
        )
    ]


def search(c: Criteria) -> List[Listing]:
    params = {
        "searchQueryState": json.dumps(_search_query_state(c), separators=(",", ":")),
        "wants": json.dumps({"cat1": ["listResults"]}, separators=(",", ":")),
        "requestId": 2,
    }
    referer = _referer(c)
    headers = {
        "Accept": "application/json,text/javascript,*/*;q=0.01",
        "Referer": referer,
        "X-Requested-With": "XMLHttpRequest",
    }

    # Use a persistent, Chrome-impersonating session so cookies set while loading
    # the human-facing rentals page are sent on the JSON request below.
    s = http.session()

    # Cookie-priming: load the rentals page first to collect any clearance
    # cookies. Its failure is non-fatal (we only want the side-effect cookies),
    # so swallow any error here.
    try:
        http.get(referer, sess=s, headers={"Referer": "https://www.zillow.com/"})
    except Exception:
        pass

    # Let HTTP errors (403/429/503 -> HTTPStatusError) propagate so the pipeline
    # can mark this source "blocked" rather than silently returning [].
    resp = http.get(
        "https://www.zillow.com/search/GetSearchPageState.htm",
        sess=s,
        params=params,
        headers=headers,
    )

    try:
        data = resp.json()
    except (json.JSONDecodeError, ValueError):
        try:
            data = json.loads(resp.text)
        except (json.JSONDecodeError, ValueError):
            return []

    listings: List[Listing] = []
    seen = set()
    for home in _result_list(data):
        for listing in _listings_from_result(home):
            if listing.source_id in seen:
                continue
            seen.add(listing.source_id)
            listings.append(listing)
    return listings
