"""Helpers for pulling JSON that sites embed in their HTML.

Modern listing sites are React/Next.js apps that ship their data as a JSON blob
inside the page (e.g. Next.js `__NEXT_DATA__`). Parsing that blob is far more
stable than scraping rendered DOM with CSS selectors.
"""
from __future__ import annotations

import json
import re
from typing import Optional

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def extract_next_data(html: str) -> Optional[dict]:
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def extract_script_json(html: str, marker: str) -> Optional[dict]:
    """Grab the first {...} JSON object on a line/script containing `marker`."""
    idx = html.find(marker)
    if idx == -1:
        return None
    brace = html.find("{", idx)
    if brace == -1:
        return None
    depth = 0
    for i in range(brace, len(html)):
        ch = html[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(html[brace : i + 1])
                except json.JSONDecodeError:
                    return None
    return None
