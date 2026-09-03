"""Smoke test for minimap.build.build_minimap_pack on synthetic data."""
from __future__ import annotations

import numpy as np
import pandas as pd

from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack


def test_build_minimap_pack_synthetic(tmp_path):
    n = 5000
    rng = np.random.default_rng(7)
    coords2d = rng.normal(size=(n, 2)).astype(np.float32)
    coords2d[0] = [500.0, 500.0]  # outlier, exercises the trimmed-core frame
    coords2d[1] = [-500.0, -500.0]

    coords_path = tmp_path / "coords2d.npy"
    np.save(coords_path, coords2d)

    points_df = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "subset": np.where(np.arange(n) % 3 == 0, "covers", np.where(np.arange(n) % 3 == 1, "medium", "plates")),
        }
    )
    subsets = {"covers": 0, "medium": 1, "plates": 2}

    out_dir = tmp_path / "minimap" / "synthetic"
    result = build_minimap_pack(
        dataset_id="synthetic",
        coords2d_path=coords_path,
        points_df=points_df,
        out_dir=out_dir,
        subsets=subsets,
    )
    assert result["n_points"] == n
    assert (out_dir / "manifest.json").exists()
    assert (out_dir / "points" / "xy_id.bin").exists()
    assert (out_dir / "points" / "tile_index.u64").exists()
    assert (out_dir / "points" / "lod.bin").exists()

    v = validate_minimap_pack(out_dir)
    assert v["status"] == "ok"
    assert v["n_points"] == n
