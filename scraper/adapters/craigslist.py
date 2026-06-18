"""Craigslist adapter.

Uses Craigslist's RSS feed, the simplest stable free interface: append
`format=rss` to any search URL. The feed is RSS 1.0 / RDF, parsed here with the
standard library (no third-party deps). RSS does not always include price in the
item title, so price/sqft are best-effort from whatever text is present.

URL shape:
    https://{site}.craigslist.org/search/{area}/apa?min_bedrooms=2&format=rss
"""
from __future__ import annotations

from typing import List
from xml.etree import ElementTree as ET

from .. import http
from ..config import Criteria
from ..models import (
    Listing,
    parse_beds,
    parse_neighborhood,
    parse_price,
    parse_sqft,
)

name = "craigslist"

_NS = {
    "rss": "http://purl.org/rss/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def _build_url(c: Criteria) -> str:
    return f"https://{c.cl_site}.craigslist.org/search/{c.cl_area}/apa"


def _build_params(c: Criteria) -> dict:
    params = {
        "availabilityMode": 0,
        "format": "rss",
    }
    if c.min_bedrooms is not None:
        params["min_bedrooms"] = c.min_bedrooms
    if c.max_bedrooms is not None:
        params["max_bedrooms"] = c.max_bedrooms
    if c.min_price is not None:
        params["min_price"] = c.min_price
    if c.max_price is not None:
        params["max_price"] = c.max_price
    return params


def parse_feed(xml_text: str) -> List[Listing]:
    """Parse a Craigslist RSS/RDF document into Listings. Pure -> unit testable."""
    root = ET.fromstring(xml_text)
    listings: List[Listing] = []
    for item in root.findall("rss:item", _NS):
        link = item.findtext("rss:link", default="", namespaces=_NS).strip()
        if not link:
            link = (item.get("{http://www.w3.org/1999/02/22-rdf-syntax-ns#}about") or "").strip()
        if not link:
            continue
        title = (item.findtext("rss:title", default="", namespaces=_NS) or "").strip()
        posted = item.findtext("dc:date", default=None, namespaces=_NS)

        listings.append(
            Listing(
                source=name,
                source_id=link.rstrip("/").split("/")[-1].replace(".html", ""),
                url=link,
                title=title,
                price=parse_price(title),
                beds=parse_beds(title),
                sqft=parse_sqft(title),
                neighborhood=parse_neighborhood(title),
                posted_at=posted,
            )
        )
    return listings


def search(c: Criteria) -> List[Listing]:
    # Prime cookies on a Chrome-impersonating session (Craigslist fronts with
    # Akamai), then fetch the RSS feed on the same session.
    s = http.session()
    try:
        http.get(f"https://{c.cl_site}.craigslist.org/", sess=s)
    except Exception:
        pass
    resp = http.get(_build_url(c), params=_build_params(c), sess=s)
    return parse_feed(resp.text)
