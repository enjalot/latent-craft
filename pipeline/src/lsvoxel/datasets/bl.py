"""British Library book-images dataset: points table + thumbnail source.

Joins the already-built embeddings substrate's row table against the thumbs
manifest to produce points.parquet — the row_id-indexed table every downstream
pipeline stage (UMAP fit, voxel assignment, chunk pack, minimap pack) reads from —
then joins the Flickr lookup table on top for the original-image columns
(`image_url`, `image_width`, `image_height`) that `point_meta.bin` is built from.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from ..config import (
    BL_FLICKR_TABLE,
    BL_ROWS_PARQUET,
    BL_SUBSETS,
    BL_THUMBS_MANIFEST_ROOT,
    BL_THUMBS_ROOT,
)
from ..points_table import write_points_table
from .base import ThumbnailSource

#: The per-row values built packs carry or key off — what a rebuild must reproduce
#: exactly (see `points_table.write_points_table`). `global_idx` is `point_index.bin`'s
#: `local_idx`; `subset` its `subset_code` and the minimap's density axis; `fname`
#: the identity the thumbs manifest join resolved.
BL_CONTRACT_COLUMNS = ("row_id", "fname", "subset", "global_idx")


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


def _load_flickr_table(path: Path) -> pd.DataFrame:
    """(fname, image_type) -> original-image URL, checked to be a unique key: the
    join below is a left join onto the points rows and must never fan out."""
    flickr = pd.read_parquet(path, columns=["fname", "image_type", "flickr_original_url"])
    n_dup = int(flickr.duplicated(["fname", "image_type"]).sum())
    if n_dup:
        raise ValueError(f"{path}: {n_dup} duplicate (fname, image_type) keys — join would be ambiguous")
    return flickr


def _join_originals(out: pd.DataFrame, flickr: pd.DataFrame) -> pd.DataFrame:
    """Add `image_url` / `image_width` / `image_height` without disturbing row order.

    `image_type` equals `subset` for every row today, but it's the Flickr table's
    own key, so the join uses it rather than assuming. Rows with no Flickr match
    (all of `covers`, a handful of `plates`) and rows whose match has no original
    URL both land as a null `image_url`; the pixel size comes from the thumbs
    manifest's `orig_width`/`orig_height`, which every row has.
    """
    n_dup = int(out.duplicated(["fname", "image_type"]).sum())
    if n_dup:
        raise ValueError(f"points table has {n_dup} duplicate (fname, image_type) keys")
    merged = out.merge(flickr, on=["fname", "image_type"], how="left", validate="one_to_one")
    # A left merge keeps the left order, but the whole pipeline rides on this, so check.
    if not np.array_equal(merged["row_id"].to_numpy(), np.arange(len(out), dtype=np.uint32)):
        raise ValueError("Flickr join reordered rows")

    url = merged["flickr_original_url"]
    out = out.copy()
    out["image_url"] = url.mask(url == "")  # empty string == no url, same as a null
    out["image_width"] = out["orig_width"].clip(lower=0).astype(np.int32)
    out["image_height"] = out["orig_height"].clip(lower=0).astype(np.int32)
    return out


def build_points_table(
    out_path: Path,
    rows_parquet: Path = BL_ROWS_PARQUET,
    thumbs_manifest_root: Path = BL_THUMBS_MANIFEST_ROOT,
    flickr_table: Path = BL_FLICKR_TABLE,
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
    out = _join_originals(out, _load_flickr_table(flickr_table))

    write_points_table(out, out_path, BL_CONTRACT_COLUMNS)
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
