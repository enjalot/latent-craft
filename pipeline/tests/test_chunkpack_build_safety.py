from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from lsvoxel.chunkpack import build


class NoThumbnailSource:
    def open(self, _row_id: int) -> bytes:
        return b""


def test_publish_replaces_a_complete_directory(tmp_path):
    target = tmp_path / "pack"
    target.mkdir()
    (target / "old-only").write_text("old")
    staging = tmp_path / ".pack.building-test"
    staging.mkdir()
    (staging / "manifest.json").write_text("new")

    build._publish_staged_pack(staging, target)

    assert (target / "manifest.json").read_text() == "new"
    assert not (target / "old-only").exists()
    assert not staging.exists()


def test_failed_staged_build_preserves_the_current_pack(tmp_path, monkeypatch):
    target = tmp_path / "pack"
    target.mkdir()
    (target / "manifest.json").write_text("known-good")

    def fail(**_kwargs):
        raise RuntimeError("encoder failed")

    monkeypatch.setattr(build, "_assign_and_build_into", fail)
    with pytest.raises(RuntimeError, match="encoder failed"):
        build.assign_and_build(
            dataset_id="test",
            points_df=pd.DataFrame({"row_id": np.array([], dtype=np.uint32)}),
            coords3d=np.empty((0, 3), dtype=np.float32),
            num_voxels=16,
            thumb_source=NoThumbnailSource(),
            out_dir=target,
            subsets={},
            thumb_url_template="{local_idx}",
            umap_run="test",
            points_table_path=tmp_path / "points.parquet",
        )

    assert (target / "manifest.json").read_text() == "known-good"
    assert not list(tmp_path.glob(".pack.building-*"))


def test_voxel_count_overflow_fails_instead_of_clamping(tmp_path, monkeypatch):
    n = np.iinfo(np.uint16).max + 1
    points = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "subset": np.repeat("test", n),
            "global_idx": np.arange(n, dtype=np.uint32),
        }
    )
    coords = np.zeros((n, 3), dtype=np.float32)
    frame = {
        "extent": [-1, 1, -1, 1, -1, 1],
        "raw_extent": [-1, 1, -1, 1, -1, 1],
        "method": "test",
        "extent_pct": [0, 100],
        "pad_frac": 0,
    }
    monkeypatch.setattr(build.frame_mod, "compute_frame_3d", lambda _coords: frame)
    monkeypatch.setattr(build.frame_mod, "normalize_to_cube", lambda values, _extent: values)

    with pytest.raises(ValueError, match="uint16 limit"):
        build.assign_and_build(
            dataset_id="overflow",
            points_df=points,
            coords3d=coords,
            num_voxels=16,
            thumb_source=NoThumbnailSource(),
            out_dir=tmp_path / "pack",
            subsets={"test": 0},
            thumb_url_template="{local_idx}",
            umap_run="test",
            points_table_path=tmp_path / "points.parquet",
        )

    assert not (tmp_path / "pack").exists()
