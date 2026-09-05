import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

spec = importlib.util.spec_from_file_location("basemap_build", Path(__file__).parents[1] / "scripts" / "build_basemap_monet.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixture(tmp_path, monkeypatch):
    pool = tmp_path / "pool"
    train = tmp_path / "training"
    pool.mkdir()
    (train / "shards").mkdir(parents=True)
    monkeypatch.setattr(builder, "MONET_POOL_DIR", pool)
    monkeypatch.setattr(builder, "TRAIN", train)
    # Deliberately interleaved pool and reversed local-row order. A positional
    # or shard-contiguity assumption would silently attach wrong thumbnails.
    np.save(pool / "prov_shard_idx.npy", np.array([1, 0, 1, 0], dtype=np.uint16))
    np.save(pool / "prov_local_row.npy", np.array([1, 0, 0, 1], dtype=np.uint16))
    (train / "manifest.json").write_text(json.dumps({"n_rows": 4, "shards": [
        {"idx": 0, "path": "b", "rows": 2}, {"idx": 1, "path": "a", "rows": 2}]}))
    np.savez(train / "shards" / "0000_meta.npz", id=np.array(["b0", "b1"]))
    np.savez(train / "shards" / "0001_meta.npz", id=np.array(["a0", "a1"]))
    return {"shards": ["a", "b"]}, np.array(["b1", "a0", "b0", "a1"])


def test_training_join_uses_provenance_not_pool_order(tmp_path, monkeypatch):
    manifest, ids = fixture(tmp_path, monkeypatch)
    assert builder.training_pool_rows(manifest, ids).tolist() == [2, 0, 1, 3]


def test_training_join_rejects_wrong_image_id(tmp_path, monkeypatch):
    manifest, ids = fixture(tmp_path, monkeypatch)
    ids[2] = "xx"
    with pytest.raises(ValueError, match="identity mismatch"):
        builder.training_pool_rows(manifest, ids)


def test_training_join_rejects_duplicate_provenance(tmp_path, monkeypatch):
    manifest, ids = fixture(tmp_path, monkeypatch)
    np.save(builder.MONET_POOL_DIR / "prov_local_row.npy", np.array([1, 0, 1, 1], dtype=np.uint16))
    with pytest.raises(ValueError, match="Duplicate"):
        builder.training_pool_rows(manifest, ids)
