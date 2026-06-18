"""Normalized listing model shared by every site adapter."""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Listing:
    """A single rental, normalized across all sources.

    Every adapter maps its raw payload onto this shape so the pipeline and
    the front-end never need to know which site a listing came from.
    """

    source: str                      # "craigslist", "redfin", ...
    source_id: str                   # stable id within that source (for dedupe)
    url: str
    title: str
    price: Optional[int] = None      # monthly rent in USD
    beds: Optional[float] = None
    baths: Optional[float] = None
    sqft: Optional[int] = None
    address: Optional[str] = None
    neighborhood: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    posted_at: Optional[str] = None  # ISO 8601, when the listing was posted
    scraped_at: str = field(default_factory=_now)
    first_seen: Optional[str] = None  # set/preserved by the pipeline
    stale: bool = False               # True if carried over from a prior run

    def key(self) -> str:
        """Dedupe key within a source."""
        return f"{self.source}:{self.source_id}"

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Parsing helpers (pure functions -> easy to unit test without network)
# ---------------------------------------------------------------------------

_PRICE_RE = re.compile(r"\$\s*([\d,]+)")
_BEDS_RE = re.compile(r"(\d+(?:\.\d+)?)\s*br", re.IGNORECASE)
_SQFT_RE = re.compile(r"(\d[\d,]*)\s*ft2", re.IGNORECASE)
_NEIGHBORHOOD_RE = re.compile(r"\(([^()]+)\)\s*$")


def parse_price(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    m = _PRICE_RE.search(text)
    if not m:
        return None
    try:
        value = int(m.group(1).replace(",", ""))
    except ValueError:
        return None
    # Filter out obvious noise (deposits like "$0", sale prices in the millions)
    if value < 200 or value > 100_000:
        return None
    return value


def parse_beds(text: Optional[str]) -> Optional[float]:
    if not text:
        return None
    m = _BEDS_RE.search(text)
    return float(m.group(1)) if m else None


def parse_sqft(text: Optional[str]) -> Optional[int]:
    if not text:
        return None
    m = _SQFT_RE.search(text)
    if not m:
        return None
    try:
        return int(m.group(1).replace(",", ""))
    except ValueError:
        return None


def parse_neighborhood(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    m = _NEIGHBORHOOD_RE.search(text.strip())
    return m.group(1).strip() if m else None
