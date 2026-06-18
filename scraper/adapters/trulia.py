"""Trulia adapter.

Trulia is a Next.js application owned by Zillow and shares Zillow's PerimeterX
bot protection. In practice this means requests from datacenter / CI IP ranges
(e.g. GitHub Actions runners) will *usually* be challenged and blocked: an
``http.get`` against the search page tends to return 403/429/503, which
``scraper.http`` surfaces as an ``httpx.HTTPStatusError``. We let that propagate
so the pipeline can mark the source "blocked". Realistically this adapter needs
a residential proxy and works best when run locally / from a residential IP.

Data interface (primary path)
-----------------------------
The most stable *free* interface is the embedded Next.js ``__NEXT_DATA__`` JSON
blob on the for-rent search results page::

    https://www.trulia.com/for_rent/<City_With_Underscores>,<ST>/<min_beds>p_beds/

We fetch the HTML, pull the ``__NEXT_DATA__`` JSON via
``_embedded.extract_next_data`` and then *recursively walk* the tree to find
home / listing objects. The exact wrapping path under ``props.pageProps`` has
moved around over time (searchData / homes / cards / results / ...), so rather
than hard-coding a key path we detect the shape of an individual home object.

A Trulia home object typically looks like (keys vary by release)::

    {
      "url": "/p/.../<numeric-id>",
      "providerListingId": "...",
      "location": {"streetAddress": "...", "city": "...", "stateCode": "CA",
                   "partialLocation": "...", "neighborhoodName": "...",
                   "coordinates": {"latitude": 37.7, "longitude": -122.4}},
      "price": {"price": 4200, "formattedPrice": "$4,200/mo"},
      "bedrooms": {"value": 2} | 2,
      "bathrooms": {"value": 1} | 1,
      "floorSpace": {"formattedDimension": "950 sqft", "value": 950}
    }

Fallback path
-------------
If ``__NEXT_DATA__`` is absent (Trulia occasionally serves a different shell, or
a bot-challenge interstitial that still returns 200) we attempt Trulia's GraphQL
search endpoint (``POST https://www.trulia.com/graphql``). This is implemented
conservatively and wrapped so any failure falls back cleanly to returning
whatever the primary path produced (usually ``[]``). The ``__NEXT_DATA__`` path
is always preferred.

Only the standard library plus ``scraper.http`` and the shared
``extract_next_data`` helper are used here.
"""
from __future__ import annotations

import json
import re
from typing import List, Optional

import httpx

from .. import http
from ..config import Criteria
from ..models import Listing
from ._embedded import extract_next_data

name = "trulia"

_BASE = "https://www.trulia.com"

# Trailing numeric id inside a Trulia listing url, e.g. ".../<id>" or ".../<id>/".
_URL_ID_RE = re.compile(r"(\d{5,})/?$")
# Generic "first run of digits" extractor for prices / dimensions / etc.
_DIGITS_RE = re.compile(r"\d[\d,]*")


# ---------------------------------------------------------------------------
# URL construction
# ---------------------------------------------------------------------------
def _search_url(c: Criteria) -> str:
    city = c.city.strip().replace(" ", "_")
    beds = max(int(c.min_bedrooms or 0), 0)
    base = f"{_BASE}/for_rent/{city},{c.state}/"
    if beds > 0:
        return f"{base}{beds}p_beds/"
    return base


# ---------------------------------------------------------------------------
# Shape detection + recursive walk
# ---------------------------------------------------------------------------
def _looks_like_home(node: dict) -> bool:
    """Heuristic: does this dict look like a single Trulia home/listing card?

    We require a url (relative or absolute, pointing at a property page) plus at
    least one rental-ish attribute (price / beds / baths / location). Detecting
    the *shape* keeps us resilient to the wrapping key changing between releases.
    """
    typename = node.get("__typename")
    if isinstance(typename, str) and typename.upper() in {
        "HOME",
        "RENTALHOME",
        "RENTALCOMMUNITY",
        "BUILDING",
        "INDIVIDUALHOME",
    }:
        return True

    url = node.get("url")
    if not isinstance(url, str) or not url:
        return False
    # A real property url points at a property page, not e.g. a nav link.
    if not (url.startswith("/p/") or url.startswith("/b/") or "/p/" in url or "/b/" in url):
        # Some payloads omit the /p/ prefix; fall back to "has an id + rental info".
        if not _URL_ID_RE.search(url):
            return False

    has_attr = any(
        k in node for k in ("price", "location", "bedrooms", "bathrooms", "floorSpace")
    )
    return has_attr


def _walk(node, out: List[dict], seen_ids: set) -> None:
    if isinstance(node, dict):
        if _looks_like_home(node):
            # De-dupe by python identity to avoid re-adding the same object that
            # appears in multiple index structures.
            if id(node) not in seen_ids:
                seen_ids.add(id(node))
                out.append(node)
            # Don't descend into a matched home (its children aren't homes).
            return
        for v in node.values():
            _walk(v, out, seen_ids)
    elif isinstance(node, list):
        for v in node:
            _walk(v, out, seen_ids)


# ---------------------------------------------------------------------------
# Field coercion helpers (tolerate {"value": x} and plain x shapes)
# ---------------------------------------------------------------------------
def _num_field(value) -> Optional[float]:
    """Extract a number from {"value": n}, {"formattedValue": "2"} or plain n."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        for key in ("value", "max", "min", "formattedValue", "formattedDimension"):
            if key in value:
                got = _num_field(value.get(key))
                if got is not None:
                    return got
        return None
    if isinstance(value, str):
        m = _DIGITS_RE.search(value)
        if m:
            try:
                return float(m.group(0).replace(",", ""))
            except ValueError:
                return None
    return None


def _to_int(value) -> Optional[int]:
    n = _num_field(value)
    return int(n) if n is not None else None


def _price(home: dict) -> Optional[int]:
    price = home.get("price")
    if isinstance(price, dict):
        # Prefer the numeric field, fall back to parsing the formatted string.
        for key in ("price", "value", "formattedPrice", "formattedPriceLabel"):
            if key in price:
                val = _to_int(price.get(key))
                if val is not None:
                    return val
        return None
    return _to_int(price)


def _sqft(home: dict) -> Optional[int]:
    fs = home.get("floorSpace")
    if fs is None:
        # Some payloads use a flatter key.
        fs = home.get("sqft") or home.get("squareFeet")
    return _to_int(fs)


def _coords(loc: dict, home: dict):
    coords = loc.get("coordinates") or home.get("coordinates") or {}
    if not isinstance(coords, dict):
        coords = {}
    lat = coords.get("latitude") or coords.get("lat")
    lng = coords.get("longitude") or coords.get("lng") or coords.get("lon")
    try:
        lat = float(lat) if lat is not None else None
    except (TypeError, ValueError):
        lat = None
    try:
        lng = float(lng) if lng is not None else None
    except (TypeError, ValueError):
        lng = None
    return lat, lng


def _address(loc: dict) -> Optional[str]:
    street = loc.get("streetAddress")
    city = loc.get("city")
    state = loc.get("stateCode") or loc.get("state")
    parts = [p for p in (street, city, state) if p]
    if parts:
        return ", ".join(parts)
    return (
        loc.get("fullLocation")
        or loc.get("partialLocation")
        or loc.get("formattedLocation")
        or None
    )


def _source_id(home: dict, url: str) -> str:
    """Prefer the listing url's trailing numeric id, then providerListingId/id."""
    m = _URL_ID_RE.search(url)
    if m:
        return m.group(1)
    for key in ("providerListingId", "id", "legacyId", "propertyId"):
        val = home.get(key)
        if val:
            return str(val)
    # Last resort: the url's final path segment (stable enough for de-dupe).
    return url.rstrip("/").split("/")[-1] or url


def _home_to_listing(home: dict, seen_urls: set) -> Optional[Listing]:
    url = home.get("url") or ""
    if not isinstance(url, str) or not url:
        return None
    if url.startswith("/"):
        url = _BASE + url
    elif not url.startswith("http"):
        url = f"{_BASE}/{url}"
    if url in seen_urls:
        return None

    loc = home.get("location") or {}
    if not isinstance(loc, dict):
        loc = {}

    address = _address(loc)
    neighborhood = (
        loc.get("neighborhoodName")
        or loc.get("neighborhood")
        or home.get("neighborhoodName")
    )
    title = (
        address
        or loc.get("partialLocation")
        or loc.get("fullLocation")
        or "Trulia rental"
    )
    lat, lng = _coords(loc, home)

    seen_urls.add(url)
    return Listing(
        source=name,
        source_id=_source_id(home, url),
        url=url,
        title=title,
        price=_price(home),
        beds=_num_field(home.get("bedrooms")),
        baths=_num_field(home.get("bathrooms")),
        sqft=_sqft(home),
        address=address,
        neighborhood=neighborhood if isinstance(neighborhood, str) else None,
        lat=lat,
        lng=lng,
    )


# ---------------------------------------------------------------------------
# Primary path: __NEXT_DATA__
# ---------------------------------------------------------------------------
def _from_next_data(data: dict, seen_urls: set) -> List[Listing]:
    raw: List[dict] = []
    # Walk the whole blob; the homes usually live under props.pageProps but the
    # exact key has changed, so we don't depend on it.
    _walk(data, raw, set())

    listings: List[Listing] = []
    for home in raw:
        listing = _home_to_listing(home, seen_urls)
        if listing is not None:
            listings.append(listing)
    return listings


# ---------------------------------------------------------------------------
# Fallback path: GraphQL SEARCH_FOR_RENT
# ---------------------------------------------------------------------------
# Conservative, best-effort GraphQL query mirroring Trulia's for-rent search.
# Field selection is intentionally defensive — _home_to_listing tolerates
# missing keys — so minor schema drift degrades gracefully rather than crashing.
_GRAPHQL_QUERY = """
query WEB_searchForRent($searchDetails: SEARCH_DETAILS_INPUT!, $limit: Int) {
  searchHomesByBoundingBox(searchDetails: $searchDetails, limit: $limit) {
    homes {
      url
      providerListingId
      bedrooms { value }
      bathrooms { value }
      floorSpace { value formattedDimension }
      price { price formattedPrice }
      location {
        streetAddress
        city
        stateCode
        partialLocation
        neighborhoodName
        coordinates { latitude longitude }
      }
    }
  }
}
""".strip()


def _from_graphql(c: Criteria, seen_urls: set) -> List[Listing]:
    """Best-effort GraphQL fallback. Never raises; returns [] on any problem.

    We cannot validate this against the live endpoint from this sandbox, so it
    is deliberately forgiving: any non-2xx, unexpected JSON shape, or transport
    error simply yields an empty list, leaving the primary result intact.
    """
    variables = {
        "searchDetails": {
            "searchType": "FOR_RENT",
            "location": {
                "partialLocation": f"{c.city}, {c.state}",
                "city": c.city,
                "stateCode": c.state,
            },
            "filter": {
                "rental": True,
                "beds": {
                    "min": int(c.min_bedrooms) if c.min_bedrooms is not None else None,
                    "max": int(c.max_bedrooms) if c.max_bedrooms is not None else None,
                },
                "price": {
                    "min": c.min_price,
                    "max": c.max_price,
                },
            },
        },
        "limit": 200,
    }
    payload = {
        "operationName": "WEB_searchForRent",
        "query": _GRAPHQL_QUERY,
        "variables": variables,
    }

    try:
        resp = httpx.post(
            f"{_BASE}/graphql",
            headers={
                **http.BASE_HEADERS,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Origin": _BASE,
                "Referer": _search_url(c),
            },
            content=json.dumps(payload),
            timeout=20.0,
            follow_redirects=True,
        )
    except httpx.HTTPError:
        return []

    if resp.status_code != 200:
        return []
    try:
        body = resp.json()
    except (json.JSONDecodeError, ValueError):
        return []

    # Walk the GraphQL response the same way — it carries the same home shape.
    raw: List[dict] = []
    _walk(body, raw, set())

    listings: List[Listing] = []
    for home in raw:
        listing = _home_to_listing(home, seen_urls)
        if listing is not None:
            listings.append(listing)
    return listings


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def search(c: Criteria) -> List[Listing]:
    """Return rentals matching ``c`` from Trulia.

    Raises ``httpx.HTTPStatusError`` if the search page is blocked (so the
    pipeline can mark the source "blocked"). Returns ``[]`` only when a page was
    successfully retrieved but genuinely contains no homes.
    """
    # Primary fetch — let 403/429/503 propagate (handled by http.get's retries
    # then raised as HTTPStatusError -> pipeline marks "blocked").
    resp = http.get(_search_url(c))

    seen_urls: set = set()
    listings: List[Listing] = []

    data = extract_next_data(resp.text)
    if data:
        listings = _from_next_data(data, seen_urls)

    # Fallback: only if the embedded blob was missing or yielded nothing.
    if not listings:
        try:
            fallback = _from_graphql(c, seen_urls)
        except Exception:
            # Belt-and-suspenders: the fallback must never break the run.
            fallback = []
        if fallback:
            listings.extend(fallback)

    return listings
