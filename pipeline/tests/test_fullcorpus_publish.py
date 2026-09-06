import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from lsvoxel.point_meta import write_point_meta, PointMetaStore
from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack

spec = importlib.util.spec_from_file_location("full_publish", Path(__file__).parents[1] / "scripts/build_fullcorpus_monet.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
audit_spec = importlib.util.spec_from_file_location("full_audit", Path(__file__).parents[1] / "scripts/verify_fullcorpus_monet.py")
audit = importlib.util.module_from_spec(audit_spec)
audit_spec.loader.exec_module(audit)


def test_source_mapping_preserves_shuffled_rows_and_validates_global_shard_boundary():
    counts, names, codes = np.array([2, 1, 3]), np.array(["a", "b", "c"]), np.array([0, 4, 8], dtype=np.uint8)
    refs, sources = publisher.map_source_rows(np.array([1, 0, 0]), np.array([0, 1, 0]),
        np.array(["b", "a", "a"]), counts, names, codes, 0, 2)
    np.testing.assert_array_equal(refs, [65536, 1, 0])
    np.testing.assert_array_equal(sources, [4, 0, 0])
    refs, sources = publisher.map_source_rows(np.array([2]), np.array([2]), None, counts, names, codes, 2, 3)
    assert refs[0] == (2 << 16) + 2 and sources[0] == 8
    for shard, local in ((1, 1), (2, 0), (-1, 0), (0, -1)):
        with pytest.raises(ValueError, match="outside"):
            publisher.map_source_rows(np.array([shard]), np.array([local]), None, counts, names, codes, 0, 2)
    with pytest.raises(ValueError, match="category"):
        publisher.map_source_rows(np.array([0]), np.array([0]), np.array(["b"]), counts, names, codes, 0, 2)


def test_metadata_extension_preserves_pool_and_has_explicit_empty_complement(tmp_path):
    source = tmp_path / "source.bin"
    write_point_meta(source, ["https://example.com/é.jpg", None], [200, 0], [100, 0])
    destination = tmp_path / "full.bin"
    publisher.extend_pool_meta(source, destination, 5, 2)
    with PointMetaStore(source) as old, PointMetaStore(destination) as new:
        assert new.n_rows == 5
        assert new.lookup(0) == old.lookup(0)
        assert new.lookup(1) == old.lookup(1)
        for row in (2, 4):
            assert new.lookup(row) == {"url": None, "width": 0, "height": 0}
        with pytest.raises(IndexError):
            new.lookup(5)
    with pytest.raises(FileExistsError):
        publisher.extend_pool_meta(source, destination, 5, 2)


def test_compact_categorical_points_keep_high_corpus_codes_and_row_identity(tmp_path):
    n = 101
    coords = tmp_path / "coords.npy"
    np.save(coords, np.random.default_rng(3).normal(size=(n, 2)).astype(np.float32))
    points = pd.DataFrame(dict(row_id=np.arange(n, dtype=np.uint32),
        subset=pd.Categorical.from_codes(np.arange(n) % 2, categories=["a", "b"])))
    build_minimap_pack("full", coords, points, tmp_path / "map", {"a": 0, "b": 8}, overview_only=True)
    assert validate_minimap_pack(tmp_path / "map")["n_points"] == n
    records = np.fromfile(tmp_path / "map/points/xy_id.bin", dtype=[("x", "<u2"), ("y", "<u2"), ("packed", "<u4")])
    rows = records["packed"] & 0x0fffffff
    np.testing.assert_array_equal(np.sort(rows), np.arange(n))
    np.testing.assert_array_equal(records["packed"] >> 28, (rows % 2)*8)


def test_full_release_audit_detects_corrupted_postings(tmp_path, monkeypatch):
    from lsvoxel.chunkpack import build
    from lsvoxel.chunkpack.streaming import convert
    n = 47
    folder = tmp_path / "points"; folder.mkdir()
    coords_paths = [tmp_path / f"coords{dim}.npy" for dim in (2, 3)]
    for dim, path in zip((2, 3), coords_paths):
        np.save(path, np.random.default_rng(dim).normal(size=(n, dim)).astype(np.float32))
    refs = np.arange(n, dtype=np.uint32)
    np.save(folder / "thumb_refs.npy", refs)
    np.save(folder / "source_codes.npy", np.zeros(n, dtype=np.uint8))
    (folder / "provenance.json").write_text(json.dumps(dict(dataset="fixture", n_points=n,
        coordinates=[dict(path=str(p)) for p in coords_paths])))
    points = pd.DataFrame(dict(row_id=refs, global_idx=refs, subset="images"))
    source, release, minimap = tmp_path / "source", tmp_path / "release", tmp_path / "minimap"
    build_minimap_pack("fixture", coords_paths[0], points, minimap, {"images": 0}, overview_only=True)
    monkeypatch.setattr(build.atlas_mod, "encode_ktx2", lambda png, output, **kwargs: output.write_bytes(b"fixture-atlas"))
    class EmptyThumbs:
        def open(self, row): return b""
    build.assign_and_build("fixture", points, np.load(coords_paths[1]), 16, EmptyThumbs(), source,
        {"images": 0}, "{local_idx}", "fixture", folder / "points.parquet", wide_counts=True)
    convert(source, release, minimap)
    report = audit.verify(release, folder)
    assert report["points"] == n and report["postings_exactly_once"] and report["spatial_rows_exactly_once"]
    postings = release / "c/000000/postings.bin"
    rows = np.fromfile(postings, dtype="<u4"); rows[0] = rows[1]; rows.tofile(postings)
    with pytest.raises(ValueError, match="postings"):
        audit.verify(release, folder)
