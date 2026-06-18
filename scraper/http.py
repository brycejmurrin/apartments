"""Shared HTTP client with browser impersonation (TLS + HTTP/2 fingerprint).

Why this exists: plain ``httpx``/``requests`` present a Python TLS (JA3) and
HTTP/2 fingerprint that Cloudflare, Akamai and PerimeterX flag instantly — which
is why every source returned 403 from CI *before any IP-reputation check*.
``curl_cffi`` performs the request with a real Chrome TLS + HTTP/2 fingerprint,
which is the single highest-leverage *free* change for getting past
fingerprint-based blocking.

It is not a silver bullet. PerimeterX (Zillow/Trulia) additionally runs a JS
sensor challenge that a non-browser client cannot satisfy, so those may still be
blocked. Cloudflare/Akamai sites (Craigslist, Redfin, Apartments.com) have a
real chance, especially when cookies are primed via :func:`session` first.

Adapters keep calling :func:`get` exactly as before; the impersonation is
transparent. For sites that hand out a bot-clearance cookie on the first page
view, call :func:`session`, hit the site homepage, then call the data endpoint
with the same session so the cookie is sent.
"""
from __future__ import annotations

import time
from typing import Any, Optional

from curl_cffi import requests as cffi

# Impersonation target. curl_cffi ships fingerprints for several Chrome builds;
# a recent one matches the User-Agent real browsers send today.
IMPERSONATE = "chrome124"

BASE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_BLOCKED = (403, 429, 503)


def session() -> "cffi.Session":
    """A Chrome-impersonating session that persists cookies across calls.

    Use for cookie-priming flows, e.g.::

        s = http.session()
        http.get("https://www.redfin.com/", sess=s)          # collect cookies
        resp = http.get("https://www.redfin.com/stingray/...", sess=s)
    """
    s = cffi.Session(impersonate=IMPERSONATE)
    s.headers.update(BASE_HEADERS)
    return s


def _request(
    method: str,
    url: str,
    *,
    sess: Optional["cffi.Session"] = None,
    headers: Optional[dict] = None,
    params: Optional[dict] = None,
    json: Any = None,
    data: Any = None,
    timeout: float = 25.0,
    retries: int = 3,
) -> "cffi.Response":
    """Perform a request with browser impersonation and backoff on bot walls.

    Retries on 403/429/503 (the typical anti-bot responses) with exponential
    backoff, then raises on the final blocked/again-non-2xx response so callers
    can distinguish "blocked" from a genuine empty result.
    """
    merged = {**BASE_HEADERS, **(headers or {})}
    client = sess if sess is not None else cffi
    resp: Optional["cffi.Response"] = None
    last_exc: Optional[Exception] = None

    for attempt in range(retries):
        kwargs: dict = {
            "headers": merged,
            "params": params,
            "timeout": timeout,
            "allow_redirects": True,
        }
        # A Session already carries impersonate; setting it again would error.
        if sess is None:
            kwargs["impersonate"] = IMPERSONATE
        if json is not None:
            kwargs["json"] = json
        if data is not None:
            kwargs["data"] = data
        try:
            resp = client.request(method, url, **kwargs)
        except Exception as exc:  # transport-level failure -> back off and retry
            last_exc = exc
            time.sleep(2 ** attempt)
            continue
        if resp.status_code not in _BLOCKED:
            break
        time.sleep(2 ** attempt)

    if resp is None:
        assert last_exc is not None
        raise last_exc
    resp.raise_for_status()
    return resp


def get(url: str, **kwargs) -> "cffi.Response":
    return _request("GET", url, **kwargs)


def post(url: str, **kwargs) -> "cffi.Response":
    return _request("POST", url, **kwargs)
