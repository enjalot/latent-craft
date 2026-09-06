import numpy as np
import pandas as pd
import pytest

from lsvoxel.chunkpack.assign import assign_points_to_chunks, select_representatives
from lsvoxel.chunkpack.bounded import prepare_assignment
from lsvoxel.frame import normalize_to_cube


def test_bounded_matches_in_memory_including_ties_outliers_and_batch_boundaries(tmp_path):
    coords = np.random.default_rng(4).normal(size=(1003, 3))
    coords[:4] = [[0, 0, 0], [0, 0, 0], [-10, 0, 0], [10, 0, 0]]
    extent = [-2, 2] * 3
    normalized = normalize_to_cube(coords, extent)
    expected = assign_points_to_chunks(normalized, 32, 16)
    assignment, reps = prepare_assignment(coords, extent, 32, 16, tmp_path / "scratch", batch_rows=31)
    for name in assignment:
        np.testing.assert_array_equal(assignment[name], expected[name])
    pd.testing.assert_frame_equal(reps, select_representatives(normalized, expected, 32))
    assert reps.n_points.sum() == len(coords)


def test_bounded_rejects_nonfinite(tmp_path):
    with pytest.raises(ValueError, match="Nonfinite"):
        prepare_assignment(np.array([[0, np.nan, 1]]), [-1, 1]*3, 32, 16, tmp_path / "scratch")
