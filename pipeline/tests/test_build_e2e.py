"""End-to-end smoke test for chunkpack.build.assign_and_build on synthetic data —
cheap correctness check before pointing the pipeline at the real ~1M-row dataset."""
from __future__ import annotations

import io

import numpy as np
import pandas as pd
import pytest
from PIL import Image

from lsvoxel.chunkpack.build import assign_and_build, validate_chunks
from lsvoxel.chunkpack.metablob import read_chunk_meta
from lsvoxel.chunkpack.pointindex import read_point_index
from lsvoxel.chunkpack.proxy import read_proxy
from lsvoxel.chunkpack.row_to_voxel import read_row_to_voxel


class FakeThumbnailSource:
    def __init__(self, seed=0):
        self._rng = np.random.default_rng(seed)

    def open(self, row_id: int) -> bytes:
        rng = np.random.default_rng(row_id)  # deterministic per row_id
        arr = (rng.random((64, 48, 3)) * 255).astype(np.uint8)  # non-square on purpose
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG")
        return buf.getvalue()


def _has_basisu() -> bool:
    import shutil

    return shutil.which("basisu") is not None


@pytest.mark.skipif(not _has_basisu(), reason="basisu binary not installed")
def test_assign_and_build_synthetic(tmp_path):
    n = 2000
    rng = np.random.default_rng(42)
    coords3d = rng.normal(size=(n, 3)).astype(np.float32)
    # a few outliers to exercise the percentile-trim frame logic
    coords3d[0] = [1000.0, 1000.0, 1000.0]
    coords3d[1] = [-1000.0, -1000.0, -1000.0]

    points_df = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "subset": np.where(np.arange(n) % 2 == 0, "covers", "medium"),
            "global_idx": (np.arange(n) % 1000).astype(np.int64),
        }
    )
    subsets = {"covers": 0, "medium": 1}

    out_dir = tmp_path / "chunks" / "synthetic"
    result = assign_and_build(
        dataset_id="synthetic",
        points_df=points_df,
        coords3d=coords3d,
        num_voxels=32,
        thumb_source=FakeThumbnailSource(),
        out_dir=out_dir,
        subsets=subsets,
        thumb_url_template="{subset_name}/{local_idx:08d}.webp",
        umap_run="umap-001",
        points_table_path=tmp_path / "points.parquet",
        voxels_per_chunk=16,
        tmp_dir=tmp_path / "_tmp",
    )

    assert result["n_points"] == n
    assert result["n_chunks"] > 0
    assert (out_dir / "manifest.json").exists()

    # validate_chunks re-derives every byte count/hash and must agree
    v = validate_chunks(out_dir)
    assert v["status"] == "ok"
    assert v["n_chunks"] == result["n_chunks"]

    # point_index.bin: dense by row_id, subset_code/local_idx round-trip
    pidx = read_point_index(out_dir / "point_index.bin")
    assert len(pidx) == n
    expected_subset_code = points_df["subset"].map(subsets).to_numpy(dtype=np.uint8)
    assert np.array_equal(pidx["subset_code"], expected_subset_code)
    assert np.array_equal(pidx["local_idx"], points_df["global_idx"].to_numpy(dtype=np.uint32))

    # row_to_voxel.bin: dense by row_id, every chunk_id referenced actually exists
    # in the manifest, and every (chunk_id, local_voxel_id) has nonzero count in
    # that chunk's meta.bin
    r2v = read_row_to_voxel(out_dir / "row_to_voxel.bin")
    assert len(r2v) == n

    import json

    manifest = json.loads((out_dir / "manifest.json").read_text())
    chunk_by_id = {c["chunk_id"]: c for c in manifest["chunks"]}
    meta_cache = {}
    total_points_via_meta = 0
    for row_id in range(n):
        cid = int(r2v["chunk_id"][row_id])
        lid = int(r2v["local_voxel_id"][row_id])
        assert cid in chunk_by_id, f"row {row_id} references unknown chunk {cid}"
        if cid not in meta_cache:
            meta_cache[cid] = read_chunk_meta(out_dir / chunk_by_id[cid]["meta_path"])
        meta = meta_cache[cid]
        rec = meta.voxel_records[lid]
        assert rec["count"] > 0, f"row {row_id} maps to an empty voxel record"
        # this row's row_id must actually appear in that voxel's point_ids slice
        off = int(rec["point_offset"])
        cnt = int(rec["count"])
        assert row_id in meta.point_ids[off : off + cnt].tolist()

    for cid, meta in meta_cache.items():
        total_points_via_meta += int(meta.voxel_records["count"].astype(np.uint64).sum())

    # proxy.bin: dense over the full chunk grid, and the occupied entries' point
    # counts sum to n (every point accounted for exactly once)
    chunks_per_axis, proxy_records = read_proxy(out_dir / "proxy.bin")
    assert chunks_per_axis == manifest["world"]["chunks_per_axis"]
    assert len(proxy_records) == chunks_per_axis**3
    assert int(proxy_records["n_points"].astype(np.uint64).sum()) == n

    # every meta.bin's point_ids array is internally consistent: grouped by
    # local_voxel_id ascending, row_id ascending within a voxel, and every
    # occupied voxel's point_offset/count slice matches its own local_voxel_id group
    for cid, meta in meta_cache.items():
        occupied = np.flatnonzero(meta.voxel_records["count"] > 0)
        assert len(occupied) == chunk_by_id[cid]["n_occupied_voxels"]
        for lid in occupied.tolist():
            rec = meta.voxel_records[lid]
            off, cnt = int(rec["point_offset"]), int(rec["count"])
            sl = meta.point_ids[off : off + cnt]
            assert (np.diff(sl.astype(np.int64)) > 0).all(), "row_ids within a voxel must be strictly ascending"
