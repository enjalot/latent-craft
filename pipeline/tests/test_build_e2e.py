"""End-to-end smoke test for chunkpack.build.assign_and_build on synthetic data —
cheap correctness check before pointing the pipeline at the real ~1M-row dataset.
One build (its basisu encode dominates the ~10 s) feeds every test here; tests that
need to mutate a pack copy it first."""
from __future__ import annotations

import io
import json
import shutil
import struct
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from PIL import Image

from lsvoxel.chunkpack.build import assign_and_build, derive_voxel_proxy, validate_chunks
from lsvoxel.chunkpack.atlas import compact_tiles_per_side
from lsvoxel.chunkpack.manifest import file_entry
from lsvoxel.chunkpack.metablob import read_chunk_meta
from lsvoxel.chunkpack.pointindex import read_point_index
from lsvoxel.chunkpack.proxy import read_proxy
from lsvoxel.chunkpack.row_to_voxel import read_row_to_voxel
from lsvoxel.chunkpack.voxel_proxy import read_voxel_proxy


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


pytestmark = pytest.mark.skipif(not _has_basisu(), reason="basisu binary not installed")


@pytest.fixture(scope="module")
def pack(tmp_path_factory):
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

    tmp_path = tmp_path_factory.mktemp("build")
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
    manifest = json.loads((out_dir / "manifest.json").read_text())
    chunk_by_id = {c["chunk_id"]: c for c in manifest["chunks"]}
    metas = {cid: read_chunk_meta(out_dir / c["meta_path"]) for cid, c in chunk_by_id.items()}
    return SimpleNamespace(
        n=n, points_df=points_df, subsets=subsets, out_dir=out_dir, result=result,
        manifest=manifest, chunk_by_id=chunk_by_id, metas=metas,
    )


def test_assign_and_build_synthetic(pack):
    n, out_dir, result = pack.n, pack.out_dir, pack.result
    assert result["n_points"] == n
    assert result["n_chunks"] > 0
    assert (out_dir / "manifest.json").exists()
    assert pack.manifest["atlas"]["layout"] == "compact-occupied-v1"
    for chunk in pack.manifest["chunks"]:
        side = chunk["atlas_tiles_per_side"]
        assert side == compact_tiles_per_side(chunk["n_occupied_voxels"], 64)
        assert chunk["atlas_size_px"] == side * pack.manifest["atlas"]["tile_px"]
        # KTX2 levelCount is the u32 at byte offset 40. Atlases deliberately
        # carry level 0 only; lower mips cross tile boundaries and are unused.
        raw = (out_dir / chunk["atlas_path"]).read_bytes()
        assert struct.unpack_from("<I", raw, 40)[0] == 1

    # validate_chunks re-derives every byte count/hash and must agree
    v = validate_chunks(out_dir)
    assert v["status"] == "ok"
    assert v["n_chunks"] == result["n_chunks"]
    assert v["n_voxels"] == result["n_occupied_voxels"]

    # point_index.bin: dense by row_id, subset_code/local_idx round-trip
    pidx = read_point_index(out_dir / "point_index.bin")
    assert len(pidx) == n
    expected_subset_code = pack.points_df["subset"].map(pack.subsets).to_numpy(dtype=np.uint8)
    assert np.array_equal(pidx["subset_code"], expected_subset_code)
    assert np.array_equal(pidx["local_idx"], pack.points_df["global_idx"].to_numpy(dtype=np.uint32))

    # row_to_voxel.bin: dense by row_id, every chunk_id referenced actually exists
    # in the manifest, and every (chunk_id, local_voxel_id) has nonzero count in
    # that chunk's meta.bin
    r2v = read_row_to_voxel(out_dir / "row_to_voxel.bin")
    assert len(r2v) == n

    for row_id in range(n):
        cid = int(r2v["chunk_id"][row_id])
        lid = int(r2v["local_voxel_id"][row_id])
        assert cid in pack.chunk_by_id, f"row {row_id} references unknown chunk {cid}"
        meta = pack.metas[cid]
        rec = meta.voxel_records[lid]
        assert rec["count"] > 0, f"row {row_id} maps to an empty voxel record"
        # this row's row_id must actually appear in that voxel's point_ids slice
        off = int(rec["point_offset"])
        cnt = int(rec["count"])
        assert row_id in meta.point_ids[off : off + cnt].tolist()

    # proxy.bin: dense over the full chunk grid, and the occupied entries' point
    # counts sum to n (every point accounted for exactly once)
    chunks_per_axis, proxy_records = read_proxy(out_dir / "proxy.bin")
    assert chunks_per_axis == pack.manifest["world"]["chunks_per_axis"]
    assert len(proxy_records) == chunks_per_axis**3
    assert int(proxy_records["n_points"].astype(np.uint64).sum()) == n

    # every meta.bin's point_ids array is internally consistent: grouped by
    # local_voxel_id ascending, row_id ascending within a voxel, and every
    # occupied voxel's point_offset/count slice matches its own local_voxel_id group
    for cid, meta in pack.metas.items():
        occupied = np.flatnonzero(meta.voxel_records["count"] > 0)
        assert len(occupied) == pack.chunk_by_id[cid]["n_occupied_voxels"]
        for lid in occupied.tolist():
            rec = meta.voxel_records[lid]
            off, cnt = int(rec["point_offset"]), int(rec["count"])
            sl = meta.point_ids[off : off + cnt]
            assert (np.diff(sl.astype(np.int64)) > 0).all(), "row_ids within a voxel must be strictly ascending"


def test_voxel_proxy_mirrors_every_chunks_occupied_list(pack):
    """voxel_proxy.bin: one record per occupied voxel in each chunk's occupied-list
    order, carrying meta.bin's count/color/flags; its counts sum to n like proxy.bin's;
    the manifest entry sits right after row_to_voxel and knows n_voxels."""
    manifest = pack.manifest
    vp = read_voxel_proxy(pack.out_dir / "voxel_proxy.bin")
    assert (vp.num_voxels, vp.voxels_per_chunk) == (32, 16)
    assert vp.n_voxels == pack.result["n_occupied_voxels"]
    assert vp.n_voxels == sum(c["n_occupied_voxels"] for c in manifest["chunks"])
    assert int(vp.records["count"].astype(np.uint64).sum()) == pack.n

    entry = manifest["voxel_proxy"]
    assert entry["path"] == "voxel_proxy.bin"
    assert entry["n_voxels"] == vp.n_voxels
    assert entry["bytes"] == 16 + 12 * vp.n_voxels == (pack.out_dir / "voxel_proxy.bin").stat().st_size
    keys = list(manifest)
    assert keys[keys.index("row_to_voxel") + 1] == "voxel_proxy"
    assert manifest["format_version"] == 1

    for cid, meta in pack.metas.items():
        occupied = np.flatnonzero(meta.voxel_records["count"] > 0)
        run = vp.records[vp.records["chunk_id"] == cid]
        assert run["local_voxel_id"].tolist() == occupied.tolist()
        assert np.array_equal(run["count"], meta.voxel_records["count"][occupied])
        assert np.array_equal(run["color_rgb"], meta.voxel_records["color_rgb"][occupied])
        assert np.array_equal(run["flags"], meta.voxel_records["flags"][occupied])
    # no records for chunks the manifest doesn't list
    assert set(np.unique(vp.records["chunk_id"]).tolist()) == set(pack.chunk_by_id)


def test_derive_voxel_proxy_reproduces_the_build_and_is_idempotent(pack, tmp_path):
    """A pack built without voxel_proxy.bin (the pre-existing /data packs) gets the
    byte-identical file and the same manifest entry from derive_voxel_proxy, and
    re-running changes nothing."""
    copy = tmp_path / "pack"
    shutil.copytree(pack.out_dir, copy)
    built_bytes = (copy / "voxel_proxy.bin").read_bytes()
    built_entry = pack.manifest["voxel_proxy"]

    (copy / "voxel_proxy.bin").unlink()
    stale = {k: v for k, v in pack.manifest.items() if k != "voxel_proxy"}
    (copy / "manifest.json").write_text(json.dumps(stale, indent=1))
    with pytest.raises(KeyError, match="voxel_proxy"):
        validate_chunks(copy)

    r = derive_voxel_proxy(copy)
    assert r["n_voxels"] == built_entry["n_voxels"]
    assert (copy / "voxel_proxy.bin").read_bytes() == built_bytes
    derived = json.loads((copy / "manifest.json").read_text())
    assert derived["voxel_proxy"] == built_entry
    # only the added key differs, and it lands in the same position as a fresh build's
    assert list(derived) == list(pack.manifest)
    assert {k: v for k, v in derived.items() if k != "voxel_proxy"} == stale
    assert validate_chunks(copy)["n_voxels"] == built_entry["n_voxels"]

    before = (copy / "manifest.json").read_bytes()
    derive_voxel_proxy(copy)
    assert (copy / "manifest.json").read_bytes() == before
    assert (copy / "voxel_proxy.bin").read_bytes() == built_bytes
    assert not (copy / "voxel_proxy.bin.tmp").exists()
    assert not (copy / "manifest.json.tmp").exists()


def test_validate_catches_voxel_proxy_that_disagrees_with_meta(pack, tmp_path):
    """The deep check, beyond bytes/sha256: a voxel_proxy.bin whose manifest entry
    is self-consistent but whose records don't match the chunks' meta.bin is refused."""
    copy = tmp_path / "pack"
    shutil.copytree(pack.out_dir, copy)
    manifest = json.loads((copy / "manifest.json").read_text())
    path = copy / "voxel_proxy.bin"

    raw = bytearray(path.read_bytes())
    raw[16 + 6] ^= 0x01  # first record's count, low byte
    path.write_bytes(bytes(raw))
    with pytest.raises(ValueError, match="sha256"):
        validate_chunks(copy)

    # re-hash so bytes/sha pass; only the meta cross-check can catch it now
    manifest["voxel_proxy"] = {**manifest["voxel_proxy"], **file_entry(path, copy)}
    (copy / "manifest.json").write_text(json.dumps(manifest, indent=1))
    with pytest.raises(ValueError, match="differ from its meta.bin"):
        validate_chunks(copy)

    # one record dropped, header updated to match, re-hashed: the file is
    # self-consistent, so only the manifest's n_voxels cross-check can catch it
    raw = raw[:-12]
    raw[8:12] = (manifest["voxel_proxy"]["n_voxels"] - 1).to_bytes(4, "little")
    path.write_bytes(bytes(raw))
    manifest["voxel_proxy"] = {**manifest["voxel_proxy"], **file_entry(path, copy)}
    (copy / "manifest.json").write_text(json.dumps(manifest, indent=1))
    with pytest.raises(ValueError, match="n_voxels"):
        validate_chunks(copy)
