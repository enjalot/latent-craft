"""row_to_voxel.bin — whole-dataset, dense-by-row_id lookup from point to its voxel.

This is the integration piece the plan's synthesis pass added: since the 2D and 3D
UMAP fits are independent optimizations (not one fit with an axis dropped), the 2D
minimap can't derive a point's 3D voxel from coordinates alone. Needed for the
minimap's flashlight (2D region -> 3D voxels), crosshair (3D voxel -> 2D point via
coords2d[row_id]), and click-to-teleport.

Layout (8B/record, dense, index == row_id):
  chunk_id:u32  local_voxel_id:u16  reserved:u16
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

ROW_TO_VOXEL_DTYPE = np.dtype(
    [
        ("chunk_id", "<u4"),
        ("local_voxel_id", "<u2"),
        ("reserved", "<u2"),
    ]
)
assert ROW_TO_VOXEL_DTYPE.itemsize == 8, ROW_TO_VOXEL_DTYPE.itemsize


def build_row_to_voxel(n_points: int, assign: dict, out_path: Path) -> None:
    if len(assign["chunk_id"]) != n_points or len(assign["local_voxel_id"]) != n_points:
        raise ValueError("assign arrays must be row_id-ordered, length == n_points")
    recs = np.zeros(n_points, dtype=ROW_TO_VOXEL_DTYPE)
    recs["chunk_id"] = assign["chunk_id"]
    recs["local_voxel_id"] = assign["local_voxel_id"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    recs.tofile(out_path)


def read_row_to_voxel(path: Path) -> np.ndarray:
    return np.fromfile(path, dtype=ROW_TO_VOXEL_DTYPE)
