"""Smoke test for minimap.build.build_minimap_pack on synthetic data."""
from __future__ import annotations

import numpy as np
import pandas as pd
import json

from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack
from lsvoxel.minimap.overview import overview_counts


def test_overview_counts_are_batched_exact_and_wide():
    # A single dense voxel/bin exceeds u16, and the last quantized coordinate
    # belongs to the last pixel. Batching cannot affect exact counts.
    x = np.zeros(100_001, dtype=np.uint16); x[-1] = 65535
    y = x.copy()
    counts = overview_counts(x, y, batch_rows=997)
    assert counts.shape == (512, 512) and counts.nbytes == 1024**2
    assert counts[0, 0] == 100_000 and counts[-1, -1] == 1
    assert counts.sum() == len(x)


def test_compact_overview_keeps_all_row_joins_without_density_planes_or_sprite_lod(tmp_path):
    n = 5000
    coords = np.random.default_rng(8).normal(size=(n,2)).astype(np.float32)
    source = tmp_path / "coords.npy"; np.save(source, coords)
    points = pd.DataFrame(dict(row_id=np.arange(n,dtype=np.uint32),subset="images"))
    output = tmp_path / "overview"
    build_minimap_pack("test",source,points,output,{"images":0},overview_only=True)
    assert validate_minimap_pack(output)["status"] == "ok"
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["tiles"]["max_zoom"] == 1 and manifest["lod"]["n_points"] == 0
    assert not list((output / "density").rglob("*.u32"))
    assert len(list((output / "density").rglob("*.png"))) <= 5
    records=np.fromfile(output / "points" / "xy_id.bin",dtype=[("x","<u2"),("y","<u2"),("row","<u4")])
    assert np.array_equal(np.sort(records["row"]),np.arange(n))
    for level in manifest["tiles"]["levels"]: assert level["total_count"] == n


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
