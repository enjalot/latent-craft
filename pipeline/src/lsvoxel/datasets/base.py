"""ThumbnailSource: the interface chunkpack/atlas.py needs from every dataset.

Keeping this as a narrow protocol means atlas.py never needs to know whether a
dataset's thumbnails live as one webp file per point (BL) or a packed blob+offsets
file (Monet, planned) — see the dataset-specific modules for each implementation.
"""
from __future__ import annotations

from typing import Protocol


class ThumbnailSource(Protocol):
    def open(self, row_id: int) -> bytes:
        """Return the raw thumbnail image bytes (webp) for a given row_id."""
        ...
