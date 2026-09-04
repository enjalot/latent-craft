"""Point -> voxel -> chunk assignment, and representative-point-per-voxel selection.

Representative-point policy (plan's open decision #2, default chosen): nearest to the
voxel's geometric cell center, ties broken by lowest row_id. The thumbnail of this
point becomes the voxel's atlas tile.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import voxel as voxel_mod


def assign_points_to_chunks(
    coords_norm: np.ndarray, num_voxels: int, voxels_per_chunk: int = 16
) -> dict[str, np.ndarray]:
    """coords_norm: (N,3) float array already frame-normalized into [-1,1]^3
    (see frame.normalize_to_cube). Returns per-point arrays."""
    x, y, z = coords_norm[:, 0], coords_norm[:, 1], coords_norm[:, 2]
    vx, vy, vz = voxel_mod.voxel_bins(x, y, z, num_voxels)
    chunk_id = voxel_mod.chunk_id_of(vx, vy, vz, num_voxels, voxels_per_chunk)
    local_id = voxel_mod.local_voxel_id(vx, vy, vz, voxels_per_chunk)
    return {
        "chunk_id": np.asarray(chunk_id, dtype=np.uint32),
        "local_voxel_id": np.asarray(local_id, dtype=np.uint16),
        "vx": np.asarray(vx, dtype=np.uint16),
        "vy": np.asarray(vy, dtype=np.uint16),
        "vz": np.asarray(vz, dtype=np.uint16),
    }


def select_representatives(
    coords_norm: np.ndarray, assign: dict[str, np.ndarray], num_voxels: int
) -> pd.DataFrame:
    """One row per OCCUPIED (chunk_id, local_voxel_id) pair: repr_row_id (nearest to
    the voxel's cell center, ties -> lowest row_id) and n_points (occupancy count).

    The sort is over compact NumPy arrays. The previous implementation first made a
    full N-row pandas DataFrame and then sorted/grouped it, which duplicated several
    two-million-row columns just to return one row per occupied voxel.
    """
    n = coords_norm.shape[0]
    if n == 0:
        return pd.DataFrame(
            {
                "chunk_id": pd.Series(dtype=np.uint32),
                "local_voxel_id": pd.Series(dtype=np.uint16),
                "repr_row_id": pd.Series(dtype=np.uint32),
                "n_points": pd.Series(dtype=np.int64),
            }
        )
    cell = 2.0 / num_voxels
    cx = -1.0 + (assign["vx"].astype(np.float64) + 0.5) * cell
    cy = -1.0 + (assign["vy"].astype(np.float64) + 0.5) * cell
    cz = -1.0 + (assign["vz"].astype(np.float64) + 0.5) * cell
    dist2 = (
        (coords_norm[:, 0] - cx) ** 2
        + (coords_norm[:, 1] - cy) ** 2
        + (coords_norm[:, 2] - cz) ** 2
    )

    row_ids = np.arange(n, dtype=np.uint32)
    chunk_ids = assign["chunk_id"]
    local_ids = assign["local_voxel_id"]
    order = np.lexsort((row_ids, dist2, local_ids, chunk_ids))
    sorted_chunks = chunk_ids[order]
    sorted_locals = local_ids[order]
    boundaries = np.flatnonzero(
        (sorted_chunks[1:] != sorted_chunks[:-1])
        | (sorted_locals[1:] != sorted_locals[:-1])
    ) + 1
    starts = np.concatenate(([0], boundaries))
    ends = np.concatenate((boundaries, [n]))
    representative_rows = order[starts].astype(np.uint32, copy=False)
    return pd.DataFrame(
        {
            "chunk_id": sorted_chunks[starts],
            "local_voxel_id": sorted_locals[starts],
            "repr_row_id": representative_rows,
            "n_points": (ends - starts).astype(np.int64, copy=False),
        }
    )
