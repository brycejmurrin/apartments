"""Adapter contract: each site implements `search(criteria) -> list[Listing]`."""
from __future__ import annotations

from typing import List, Protocol

from ..config import Criteria
from ..models import Listing


class Adapter(Protocol):
    name: str

    def search(self, criteria: Criteria) -> List[Listing]:
        ...
