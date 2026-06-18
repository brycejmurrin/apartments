"""Search criteria. Edit this to change what the crawler looks for."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class Criteria:
    city: str = "San Francisco"
    state: str = "CA"
    min_bedrooms: int = 2
    max_bedrooms: int = 2
    min_price: Optional[int] = None
    max_price: Optional[int] = None

    # Craigslist site/area: sfbay -> San Francisco city proper is the "sfc" area.
    cl_site: str = "sfbay"
    cl_area: str = "sfc"

    def to_dict(self) -> dict:
        return asdict(self)


# The single source of truth for a run. Override via env in run.py if desired.
CRITERIA = Criteria()
