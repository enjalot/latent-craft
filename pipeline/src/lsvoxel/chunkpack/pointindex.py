"""point_index.bin — whole-dataset, dense-by-row_id array letting the client resolve
any row_id straight to a thumbnail URL with zero network round-trip (needed for
"mining reveals the full stack": an inventory slot's hover view lists every point that
was in a mined voxel, not just the one representative atlas tile).

Layout (8B/record, dense, index == row_id):
  subset_code:u8  reserved:u8  local_idx:u32 (== thumbs-manifest global_idx)  reserved2:u16
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

POINT_INDEX_DTYPE = np.dtype(
    [
        ("subset_code", "u1"),
        ("reserved", "u1"),
        ("local_idx", "<u4"),
        ("reserved2", "<u2"),
    ]
)
assert POINT_INDEX_DTYPE.itemsize == 8, POINT_INDEX_DTYPE.itemsize


def build_point_index(
    points_df: pd.DataFrame, subset_codes: dict[str, int], out_path: Path
) -> None:
    n = len(points_df)
    row_ids = points_df["row_id"].to_numpy()
    if not np.array_equal(row_ids, np.arange(n, dtype=row_ids.dtype)):
        raise ValueError("points_df must be dense, row_id-ordered (0..N-1, no gaps)")

    recs = np.zeros(n, dtype=POINT_INDEX_DTYPE)
    subset_arr = points_df["subset"].map(subset_codes)
    if subset_arr.isna().any():
        missing = points_df.loc[subset_arr.isna(), "subset"].unique().tolist()
        raise ValueError(f"subset(s) not in subset_codes mapping: {missing}")
    recs["subset_code"] = subset_arr.to_numpy(dtype=np.uint8)
    recs["local_idx"] = points_df["global_idx"].to_numpy(dtype=np.uint32)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    recs.tofile(out_path)


def read_point_index(path: Path) -> np.ndarray:
    return np.fromfile(path, dtype=POINT_INDEX_DTYPE)
