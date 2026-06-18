"""Adapter registry. Order here is the order sources are crawled."""
from . import apartments_com, craigslist, redfin, trulia, zillow

ADAPTERS = [craigslist, redfin, zillow, trulia, apartments_com]

__all__ = ["ADAPTERS"]
