"""Entrypoint: `python -m scraper.run`.

Reads criteria from scraper.config (overridable via env vars), runs every
adapter, and writes docs/data/listings.json. Designed to run from GitHub Actions
or locally (a residential IP gets far better results from the anti-bot sites).
"""
from __future__ import annotations

import logging
import os

from .config import CRITERIA, Criteria
from .pipeline import run, write


def _criteria_from_env() -> Criteria:
    c = CRITERIA
    if os.getenv("CITY"):
        c.city = os.environ["CITY"]
    if os.getenv("STATE"):
        c.state = os.environ["STATE"]
    if os.getenv("MIN_BEDROOMS"):
        c.min_bedrooms = int(os.environ["MIN_BEDROOMS"])
    if os.getenv("MAX_BEDROOMS"):
        c.max_bedrooms = int(os.environ["MAX_BEDROOMS"])
    if os.getenv("MIN_PRICE"):
        c.min_price = int(os.environ["MIN_PRICE"])
    if os.getenv("MAX_PRICE"):
        c.max_price = int(os.environ["MAX_PRICE"])
    return c


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    criteria = _criteria_from_env()
    result = run(criteria)
    write(result)
    ok = sum(1 for s in result["sources"].values() if s["status"] == "ok")
    print(f"Done: {result['total']} listings, {ok}/{len(result['sources'])} sources OK")


if __name__ == "__main__":
    main()
