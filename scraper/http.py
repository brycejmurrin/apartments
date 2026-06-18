"""Shared HTTP client: realistic headers, polite retries, sane timeouts.

Anti-bot reality check: Zillow, Trulia and Apartments.com fingerprint
aggressively and frequently block datacenter IPs (which is what GitHub Actions
runners use). This client does the basics — a browser-like User-Agent and
backoff — but it cannot defeat PerimeterX/Cloudflare on its own. Adapters are
expected to fail *gracefully* when blocked rather than crash the whole run.
"""
from __future__ import annotations

import time
from typing import Optional

import httpx

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

BASE_HEADERS = {
    "User-Agent": DEFAULT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}


def get(
    url: str,
    *,
    headers: Optional[dict] = None,
    params: Optional[dict] = None,
    timeout: float = 20.0,
    retries: int = 3,
) -> httpx.Response:
    """GET with browser headers and exponential backoff.

    Raises httpx.HTTPStatusError on the final non-2xx response so callers can
    distinguish "blocked" (4xx/5xx) from a successful empty result.
    """
    merged = {**BASE_HEADERS, **(headers or {})}
    last_exc: Optional[Exception] = None
    for attempt in range(retries):
        try:
            resp = httpx.get(
                url,
                headers=merged,
                params=params,
                timeout=timeout,
                follow_redirects=True,
            )
            if resp.status_code in (403, 429, 503):
                # Almost always an anti-bot wall; back off and retry once or twice.
                last_exc = httpx.HTTPStatusError(
                    f"{resp.status_code} for {url}", request=resp.request, response=resp
                )
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            last_exc = exc
            time.sleep(2 ** attempt)
    assert last_exc is not None
    raise last_exc
