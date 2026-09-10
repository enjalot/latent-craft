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


def projection_fixture(tmp_path, monkeypatch):
    folder, pool, complement = [tmp_path / name for name in ("projection", "pool", "complement")]
    for path in (folder, pool, complement): path.mkdir()
    monkeypatch.setattr(publisher, "MONET_POOL_DIR", pool)
    monkeypatch.setattr(publisher, "COMPLEMENT", complement)
    head = tmp_path / "head.pt"; head.write_bytes(b"frozen-model")
    pca = tmp_path / "pca.npz"; pca.write_bytes(b"frozen-pca")
    inputs = [pool / "dino.npy", complement / "dino.npy"]
    np.save(inputs[0], np.zeros((2, 1536), dtype=np.float16))
    np.save(inputs[1], np.zeros((3, 1536), dtype=np.float16))
    np.save(folder / "coords.f32.npy", np.arange(10, dtype=np.float32).reshape(5, 2))
    receipt = dict(status="complete", dim=2, checkpoint=str(head), checkpoint_sha256=publisher.digest(head),
        checkpoint_sha256_16=publisher.digest(head)[:16], n_rows=5, n_pool=2, n_complement=3,
        row_layout={"pool": [0, 2], "complement": [2, 5]}, training_rows=6_000_000, input_dimensions=768,
        pca_sha256=publisher.digest(pca), source_identity={"inputs": [
            dict(path=str(p), bytes=p.stat().st_size, mtime_ns=p.stat().st_mtime_ns) for p in inputs]})
    (folder / "manifest.json").write_text(json.dumps(receipt))
    return folder, head, dict(column="dino.npy", pca=str(pca), training_rows=6_000_000), receipt


def test_dino_projection_identity_keeps_saved_pca_and_explicit_input_columns(tmp_path, monkeypatch):
    folder, head, profile, _ = projection_fixture(tmp_path, monkeypatch)
    verified = publisher.verify_projection(folder, head, 2, profile)
    assert verified["pca_model"] == profile["pca"]
    assert verified["checkpoint_sha256"] == publisher.digest(head)
    assert verified["input_paths"][0].endswith("pool/dino.npy")
    assert publisher.PROFILES["clip-4m"]["stem"] != publisher.PROFILES["dino-6m-pca768"]["stem"]


@pytest.mark.parametrize("field,value", [
    ("status", "projecting"), ("training_rows", 4_000_000), ("input_dimensions", 1536),
    ("pca_sha256", "wrong"), ("checkpoint_sha256", "wrong"), ("dim", 3),
    ("n_complement", 4), ("row_layout", {"pool": [0, 3], "complement": [3, 5]})])
def test_dino_projection_rejects_wrong_model_transform_and_layout(tmp_path, monkeypatch, field, value):
    folder, head, profile, receipt = projection_fixture(tmp_path, monkeypatch)
    receipt[field] = value
    (folder / "manifest.json").write_text(json.dumps(receipt))
    with pytest.raises(ValueError): publisher.verify_projection(folder, head, 2, profile)


def test_dino_projection_rejects_nonfinite_coordinates_and_changed_sources(tmp_path, monkeypatch):
    folder, head, profile, receipt = projection_fixture(tmp_path, monkeypatch)
    coords = np.load(folder / "coords.f32.npy"); coords[-1, -1] = np.nan
    np.save(folder / "coords.f32.npy", coords)
    with pytest.raises(ValueError, match="Nonfinite"): publisher.verify_projection(folder, head, 2, profile)
    coords[-1, -1] = 0; np.save(folder / "coords.f32.npy", coords)
    receipt["source_identity"]["inputs"][0]["mtime_ns"] += 1
    (folder / "manifest.json").write_text(json.dumps(receipt))
    with pytest.raises(ValueError, match="changed"): publisher.verify_projection(folder, head, 2, profile)


def test_12m_profile_reuses_pca_but_requires_its_own_heads_and_training_receipt(tmp_path, monkeypatch):
    profile = publisher.PROFILES["dino-12m-pca768"]
    old = publisher.PROFILES["dino-6m-pca768"]
    assert profile["pca"] == old["pca"]
    assert profile["heads"] != old["heads"] and profile["stem"] != old["stem"]
    assert profile["training_rows"] == 12_000_000
    assert Path(profile["folders"][0]).is_relative_to(publisher.DATA_ROOT / "projections")
    folder, head, fixture, receipt = projection_fixture(tmp_path, monkeypatch)
    fixture["training_rows"] = profile["training_rows"]
    with pytest.raises(ValueError, match="training identity"):
        publisher.verify_projection(folder, head, 2, fixture)
    receipt["training_rows"] = 12_000_000
    (folder / "manifest.json").write_text(json.dumps(receipt))
    assert publisher.verify_projection(folder, head, 2, fixture)["manifest"]["training_rows"] == 12_000_000


def test_projection_batches_preserve_pool_complement_boundary():
    import sys
    sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
    from project_fullcorpus_monet import batches
    assert list(batches([5, 7], 4)) == [(0, 0, 4, 0), (0, 4, 5, 4), (1, 0, 4, 5), (1, 4, 7, 9)]
    with pytest.raises(ValueError): list(batches([5, 7], 0))


def test_projection_output_cannot_overwrite_or_write_research_inputs(tmp_path, monkeypatch):
    import sys
    sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
    import project_fullcorpus_monet as project
    monkeypatch.setattr(project, "DATA_ROOT", tmp_path / "data")
    monkeypatch.setattr(project, "SANDBOX", tmp_path / "research")
    out = tmp_path / "data/projections/new-2d"
    profile = dict(folders=(str(out), "existing-3d"))
    assert project.projection_output(profile, 2) == out
    with pytest.raises(ValueError, match="fresh"): project.projection_output(profile, 3)
    out.mkdir(parents=True)
    with pytest.raises(ValueError, match="fresh"): project.projection_output(profile, 2)
    with pytest.raises(ValueError, match="dimension"): project.projection_output(profile, 4)


def test_changed_head_rejected_before_loading_checkpoint(tmp_path):
    path = tmp_path / "head.pt"; path.write_bytes(b"changed checkpoint")
    with pytest.raises(ValueError, match="checkpoint changed"):
        audit.load_head(path, "not-the-recorded-hash")


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
