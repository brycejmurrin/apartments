"""Apartments.com adapter (CoStar).

Apartments.com sits behind Cloudflare and aggressive bot detection; datacenter
and CI IPs are frequently challenged with a JS/CAPTCHA wall, so this adapter
realistically needs a residential proxy and works best run locally. From a
blocked IP expect ``http.get`` to raise an HTTPStatusError (the pipeline then
marks the source "blocked"); we let that propagate.

The results page renders listings two ways and we read both, then merge:

1. **Placard cards (primary).** Each result is an ``<article>``/``<li>`` with
   class ``placard`` carrying ``data-listingid``/``data-url``/``data-aid`` and
   child elements with classes like ``property-title`` / ``js-placardTitle``
   (name), ``property-pricing`` / ``price-range`` (rent), ``property-beds``
   (beds), ``property-address`` (address). Parsed with a stdlib HTMLParser
   subclass so we add no third-party dependency.

2. **JSON-LD (supplementary).** A ``<script type="application/ld+json">`` block
   of ``@type":"SearchResultsPage"`` (with an ``about`` array) or an
   ``itemListElement`` list. Used to fill gaps (name/address and lat/lng from
   ``geo``).

Results are merged keyed by URL (falling back to source_id) so each path can
contribute the fields the other is missing, giving the widest coverage.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from typing import Dict, List, Optional

from .. import http
from ..config import Criteria
from ..models import Listing, parse_beds, parse_price, parse_sqft

name = "apartments_com"

_JSONLD_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)

# Class tokens we treat as marking a "placard" result card and its children.
# Apartments.com varies these over time, so we match on token membership.
# NB: "mortar-wrapper" is the *outer* wrapper that contains the placard; we key
# the card on "placard" itself so the article's data-* attrs are captured.
_PLACARD_TOKENS = {"placard"}
_TITLE_TOKENS = {"property-title", "js-placardtitle", "placardtitle"}
_PRICE_TOKENS = {"property-pricing", "price-range", "property-rents"}
_BEDS_TOKENS = {"property-beds", "bed-range"}
_ADDRESS_TOKENS = {"property-address", "property-addr"}


def _search_url(c: Criteria) -> str:
    city = c.city.strip().lower().replace(" ", "-")
    return (
        f"https://www.apartments.com/{city}-{c.state.lower()}/"
        f"{c.min_bedrooms}-bedrooms/"
    )


def _classes(attrs: Dict[str, Optional[str]]) -> set:
    return set((attrs.get("class") or "").lower().split())


def _source_id_from_url(url: str) -> str:
    """Apartments.com listing URLs look like
    https://www.apartments.com/<slug>/<id>/ where <id> is a short alnum code.
    Use the trailing path segment as a stable id, falling back to the slug."""
    parts = [p for p in url.split("/") if p]
    return parts[-1] if parts else url


class _PlacardParser(HTMLParser):
    """Streaming parser that pulls one Listing-worth of fields per placard.

    We keep this deliberately simple: when we enter an element whose class set
    intersects ``_PLACARD_TOKENS`` we open a card and capture its data-* attrs,
    then while inside the card we route text into the field whose marker class
    we last saw. Nested element depth is tracked so we close the card at the
    right boundary.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: List[dict] = []
        self._card: Optional[dict] = None
        self._depth = 0
        self._field: Optional[str] = None
        # depth at which the current field-marker element was opened
        self._field_depth = -1

    def handle_starttag(self, tag, attrs):  # noqa: D401
        a = dict(attrs)
        classes = _classes(a)

        if self._card is None:
            if classes & _PLACARD_TOKENS:
                self._card = {
                    "listingid": a.get("data-listingid") or a.get("data-aid"),
                    "url": a.get("data-url") or a.get("data-streetaddress"),
                    "title": "",
                    "price": "",
                    "beds": "",
                    "address": "",
                }
                self._depth = 0
                self._field = None
                self._field_depth = -1
            return

        # Inside a card: count depth so we know when it ends.
        self._depth += 1

        # An anchor often carries the canonical listing URL.
        if tag == "a":
            href = a.get("href")
            if href and not self._card.get("url"):
                self._card["url"] = href

        # Pick up id / url from any inner element if the root didn't have them
        # (e.g. when the placard is wrapped by an outer container).
        if not self._card.get("listingid"):
            self._card["listingid"] = a.get("data-listingid") or a.get("data-aid")
        if not self._card.get("url") and a.get("data-url"):
            self._card["url"] = a.get("data-url")

        # Determine which field, if any, this element marks.
        field = None
        if classes & _TITLE_TOKENS:
            field = "title"
        elif classes & _PRICE_TOKENS:
            field = "price"
        elif classes & _BEDS_TOKENS:
            field = "beds"
        elif classes & _ADDRESS_TOKENS:
            field = "address"
        # title also frequently lives in an alt/title attribute on the link
        if tag in ("a", "img"):
            for attr in ("title", "alt", "aria-label"):
                val = a.get(attr)
                if val and not self._card["title"] and classes & _TITLE_TOKENS:
                    self._card["title"] = val
        if field is not None and self._field is None:
            self._field = field
            self._field_depth = self._depth

    def handle_startendtag(self, tag, attrs):
        # Self-closing tags (e.g. <img/>) shouldn't change nesting depth.
        if self._card is not None:
            saved = self._depth
            self.handle_starttag(tag, attrs)
            self._depth = saved

    def handle_data(self, data):
        if self._card is None or self._field is None:
            return
        text = data.strip()
        if text:
            self._card[self._field] = (self._card[self._field] + " " + text).strip()

    def handle_endtag(self, tag):
        if self._card is None:
            return
        if self._field is not None and self._depth <= self._field_depth:
            # Left the field-marker element.
            self._field = None
            self._field_depth = -1
        if self._depth == 0:
            # Closing the placard root.
            self.cards.append(self._card)
            self._card = None
            self._field = None
            self._field_depth = -1
            return
        self._depth -= 1


def _parse_placards(html: str) -> List[dict]:
    parser = _PlacardParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        # A single malformed chunk shouldn't kill everything we already have.
        pass
    return parser.cards


_BED_NUM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:beds?|bd|br)\b", re.IGNORECASE)


def _beds_from_text(text: Optional[str]) -> Optional[float]:
    """Placards say "2 Beds" / "2 bd" / "Studio"; models.parse_beds only knows
    the "Nbr" form, so normalize first and feed it the canonical string."""
    if not text:
        return None
    if re.search(r"studio", text, re.IGNORECASE):
        return 0.0
    m = _BED_NUM_RE.search(text)
    if not m:
        return parse_beds(text)
    return parse_beds(f"{m.group(1)}br")


def _listing_from_card(card: dict) -> Optional[Listing]:
    url = (card.get("url") or "").strip()
    listing_id = (card.get("listingid") or "").strip()
    if not url and not listing_id:
        return None
    if url and url.startswith("/"):
        url = "https://www.apartments.com" + url
    source_id = listing_id or _source_id_from_url(url)
    title = (card.get("title") or "").strip()
    address = (card.get("address") or "").strip() or None
    return Listing(
        source=name,
        source_id=source_id,
        url=url or f"https://www.apartments.com/listing/{source_id}/",
        title=title or address or "Apartments.com listing",
        price=parse_price(card.get("price")),
        beds=_beds_from_text(card.get("beds")),
        sqft=parse_sqft(card.get("beds") or ""),
        address=address,
    )


def _iter_jsonld_items(html: str):
    for block in _JSONLD_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            if entry.get("@type") == "SearchResultsPage":
                for item in entry.get("about") or []:
                    if isinstance(item, dict):
                        yield item
            if "itemListElement" in entry:
                for el in entry.get("itemListElement") or []:
                    if isinstance(el, dict):
                        item = el.get("item", el)
                        if isinstance(item, dict):
                            yield item


def _listing_from_jsonld(item: dict) -> Optional[Listing]:
    url = item.get("url") or item.get("@id")
    if not url:
        return None
    addr = item.get("address")
    street = hood = None
    if isinstance(addr, dict):
        street = addr.get("streetAddress")
        hood = addr.get("addressLocality")
    elif isinstance(addr, str):
        street = addr
    lat = lng = None
    geo = item.get("geo")
    if isinstance(geo, dict):
        try:
            lat = float(geo["latitude"]) if geo.get("latitude") is not None else None
            lng = float(geo["longitude"]) if geo.get("longitude") is not None else None
        except (TypeError, ValueError):
            lat = lng = None
    return Listing(
        source=name,
        source_id=_source_id_from_url(url),
        url=url,
        title=item.get("name") or street or "Apartments.com listing",
        address=street,
        neighborhood=hood,
        lat=lat,
        lng=lng,
    )


def _merge(into: Listing, extra: Listing) -> None:
    """Fill any missing fields on ``into`` from ``extra`` (prefer richer data)."""
    for f in ("title", "price", "beds", "baths", "sqft", "address",
              "neighborhood", "lat", "lng", "posted_at"):
        cur = getattr(into, f)
        new = getattr(extra, f)
        if new in (None, "") :
            continue
        if cur in (None, "") or (f == "title" and cur == "Apartments.com listing"):
            setattr(into, f, new)


def _dedupe_key(listing: Listing) -> str:
    # Normalize the URL (drop trailing slash) so the two paths line up.
    if listing.url:
        return listing.url.rstrip("/")
    return f"id:{listing.source_id}"


def search(c: Criteria) -> List[Listing]:
    # Let 403/429/503 propagate so the pipeline can mark the source "blocked".
    resp = http.get(_search_url(c))
    html = resp.text

    by_key: Dict[str, Listing] = {}

    def add(listing: Optional[Listing]) -> None:
        if listing is None:
            return
        key = _dedupe_key(listing)
        if key in by_key:
            _merge(by_key[key], listing)
        else:
            by_key[key] = listing

    # Path 1: placard cards (primary, richest pricing/bed data).
    for card in _parse_placards(html):
        try:
            add(_listing_from_card(card))
        except Exception:
            # Never let one malformed card abort the run.
            continue

    # Path 2: JSON-LD (supplementary, good for address/geo gaps).
    for item in _iter_jsonld_items(html):
        try:
            add(_listing_from_jsonld(item))
        except Exception:
            continue

    return list(by_key.values())
