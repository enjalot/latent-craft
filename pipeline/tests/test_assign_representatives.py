from __future__ import annotations

from time import perf_counter

import numpy as np

from lsvoxel.chunkpack.assign import assign_points_to_chunks, select_representatives


def test_representatives_use_nearest_point_then_lowest_row_id():
    coords = np.array(
        [
            [-0.75, -0.5, -0.5],
            [-0.25, -0.5, -0.5],  # exactly equal distance to row 0 in the same cell
            [0.49, 0.49, 0.49],
            [0.70, 0.50, 0.50],
        ],
        dtype=np.float32,
    )
    assigned = assign_points_to_chunks(coords, num_voxels=2, voxels_per_chunk=1)
    reps = select_representatives(coords, assigned, num_voxels=2)

    assert reps["chunk_id"].tolist() == [0, 7]
    assert reps["local_voxel_id"].tolist() == [0, 0]
    assert reps["repr_row_id"].tolist() == [0, 2]
    assert reps["n_points"].tolist() == [2, 2]


def test_representative_selection_stays_on_the_numpy_fast_path():
    rng = np.random.default_rng(7)
    n = 200_000
    coords = rng.uniform(-1, 1, size=(n, 3)).astype(np.float32)
    assigned = assign_points_to_chunks(coords, num_voxels=160, voxels_per_chunk=16)

    started = perf_counter()
    reps = select_representatives(coords, assigned, num_voxels=160)
    elapsed = perf_counter() - started

    assert 0 < len(reps) <= n
    assert int(reps["n_points"].sum()) == n
    # Deliberately generous for shared CI; this catches a regression back to
    # full-frame pandas grouping/sorting without pretending to microbenchmark.
    assert elapsed < 5.0
