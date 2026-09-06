"""Disk-backed assignment for large builds; no full N×3 float64 work arrays."""
from pathlib import Path

import numpy as np
import pandas as pd

from ..frame import normalize_to_cube
from .assign import assign_points_to_chunks


def prepare_assignment(coords, extent, num_voxels, voxels_per_chunk, scratch: Path, batch_rows=1_000_000):
    n = len(coords)
    if not n or batch_rows < 1:
        raise ValueError("Nonempty coordinates and positive batch size required")
    scratch.mkdir(parents=True, exist_ok=False)
    chunk = np.memmap(scratch / "chunk.u32", mode="w+", dtype="<u4", shape=n)
    local = np.memmap(scratch / "local.u16", mode="w+", dtype="<u2", shape=n)
    distance = np.memmap(scratch / "distance.f64", mode="w+", dtype="<f8", shape=n)
    for start in range(0, n, batch_rows):
        stop = min(n, start + batch_rows)
        source = coords[start:stop]
        if not np.isfinite(source).all():
            raise ValueError("Nonfinite projection coordinates")
        normalized = normalize_to_cube(source, extent)
        assignment = assign_points_to_chunks(normalized, num_voxels, voxels_per_chunk)
        chunk[start:stop], local[start:stop] = assignment["chunk_id"], assignment["local_voxel_id"]
        d2 = np.zeros(stop-start, dtype=np.float64)
        for axis, name in enumerate(("vx", "vy", "vz")):
            center = -1 + (assignment[name].astype(np.float64) + .5) * (2 / num_voxels)
            d2 += (normalized[:, axis] - center) ** 2
        distance[start:stop] = d2
    chunk.flush(); local.flush(); distance.flush()
    # lexsort is stable, so equal-distance ties retain ascending input row IDs.
    # The one global int64 sort permutation costs 8N bytes, not N Python objects.
    order = np.lexsort((distance, local, chunk))
    sorted_chunks, sorted_locals = chunk[order], local[order]
    starts = np.r_[0, np.flatnonzero((sorted_chunks[1:] != sorted_chunks[:-1]) |
                                   (sorted_locals[1:] != sorted_locals[:-1])) + 1]
    reps = pd.DataFrame(dict(chunk_id=sorted_chunks[starts], local_voxel_id=sorted_locals[starts],
        repr_row_id=order[starts].astype(np.uint32), n_points=np.diff(np.r_[starts, n]).astype(np.int64)))
    del distance
    (scratch / "distance.f64").unlink()
    return {"chunk_id": chunk, "local_voxel_id": local}, reps
