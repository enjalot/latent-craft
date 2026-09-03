"""British Library book-images dataset: points table + thumbnail source.

Joins the already-built embeddings substrate's row table against the thumbs
manifest to produce points.parquet — the row_id-indexed table every downstream
pipeline stage (UMAP fit, voxel assignment, chunk pack, minimap pack) reads from.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..config import (
    BL_ROWS_PARQUET,
    BL_SUBSETS,
    BL_THUMBS_MANIFEST_ROOT,
    BL_THUMBS_ROOT,
)
from .base import ThumbnailSource


def _load_thumbs_manifest() -> pd.DataFrame:
    parts = []
    for subset in BL_SUBSETS:
        subset_dir = BL_THUMBS_MANIFEST_ROOT / subset
        files = sorted(subset_dir.glob("*.parquet"))
        if not files:
            raise FileNotFoundError(f"no manifest parquets under {subset_dir}")
        df = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
        parts.append(df)
    return pd.concat(parts, ignore_index=True)


def build_points_table(
    out_path: Path,
    rows_parquet: Path = BL_ROWS_PARQUET,
    thumbs_manifest_root: Path = BL_THUMBS_MANIFEST_ROOT,
) -> pd.DataFrame:
    rows = pd.read_parquet(rows_parquet)
    rows["row_id"] = rows.index.astype("uint32")

    thumbs = _load_thumbs_manifest()

    # (source_filename, file_row_number) is a more precise join key than (subset, fname):
    # it encodes exact shard + row position, so it can't collide even if a fname repeats
    # across subsets or within a subset.
    if rows.duplicated(["source_filename", "file_row_number"]).any():
        raise ValueError("rows.parquet has duplicate (source_filename, file_row_number)")
    if thumbs.duplicated(["source_filename", "file_row_number"]).any():
        raise ValueError("thumbs manifest has duplicate (source_filename, file_row_number)")

    joined = rows.merge(
        thumbs[
            ["source_filename", "file_row_number", "thumb_path", "global_idx", "orig_width", "orig_height"]
        ],
        on=["source_filename", "file_row_number"],
        how="inner",
        validate="one_to_one",
    )
    if len(joined) != len(rows):
        missing = len(rows) - len(joined)
        raise ValueError(
            f"points-table join dropped {missing} of {len(rows)} rows — "
            "every embedding row must resolve a thumbnail"
        )

    joined = joined.sort_values("row_id").reset_index(drop=True)
    out = joined[
        [
            "row_id", "subset", "fname", "thumb_path", "global_idx",
            "orig_width", "orig_height", "date", "image_type",
        ]
    ]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(out_path, index=False)
    return out


class BLThumbnailSource(ThumbnailSource):
    """O(1) row_id -> thumbnail bytes, backed by points.parquet's thumb_path column."""

    def __init__(self, points_df: pd.DataFrame, thumbs_root: Path = BL_THUMBS_ROOT):
        if not (points_df["row_id"].to_numpy() == range(len(points_df))).all():
            raise ValueError("points_df must be dense, row_id-ordered (0..N-1, no gaps)")
        self._thumb_paths = points_df["thumb_path"].to_numpy()
        self._root = thumbs_root

    def open(self, row_id: int) -> bytes:
        path = self._root / self._thumb_paths[row_id]
        return path.read_bytes()
