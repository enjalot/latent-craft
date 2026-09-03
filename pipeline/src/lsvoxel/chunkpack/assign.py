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
    the voxel's cell center, ties -> lowest row_id) and n_points (occupancy count)."""
    n = coords_norm.shape[0]
    cell = 2.0 / num_voxels
    cx = -1.0 + (assign["vx"].astype(np.float64) + 0.5) * cell
    cy = -1.0 + (assign["vy"].astype(np.float64) + 0.5) * cell
    cz = -1.0 + (assign["vz"].astype(np.float64) + 0.5) * cell
    dist2 = (
        (coords_norm[:, 0] - cx) ** 2
        + (coords_norm[:, 1] - cy) ** 2
        + (coords_norm[:, 2] - cz) ** 2
    )

    df = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "chunk_id": assign["chunk_id"],
            "local_voxel_id": assign["local_voxel_id"],
            "dist2": dist2,
        }
    )
    counts = df.groupby(["chunk_id", "local_voxel_id"], sort=False).size()
    reps = (
        df.sort_values(["chunk_id", "local_voxel_id", "dist2", "row_id"])
        .drop_duplicates(["chunk_id", "local_voxel_id"], keep="first")
        .set_index(["chunk_id", "local_voxel_id"])["row_id"]
    )
    out = pd.DataFrame({"repr_row_id": reps, "n_points": counts}).reset_index()
    return out
