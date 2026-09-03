"""MONET thumbnail plumbing: the packed (shard_idx, local_row) reference, the
blob+offsets store, and the atlas builder's tolerance of missing thumbnails.

All synthetic — no /data2 access — so this runs anywhere and in milliseconds.
"""
from __future__ import annotations

import struct

import numpy as np
import pytest
from PIL import Image

from lsvoxel.chunkpack.atlas import BACKGROUND_RGB, build_chunk_atlas_png
from lsvoxel.monet_thumbs import (
    THUMB_REF_STRIDE,
    MonetThumbStore,
    pack_thumb_ref,
    unpack_thumb_ref,
)


def test_pack_unpack_round_trip_scalars():
    # corners of the real domain: 2,015 pool shards (max index 2014), <=10,000 rows
    # per shard (max local row 9,999)
    cases = [(0, 0), (0, 9999), (2014, 0), (2014, 9999), (1, 1), (1007, 5000)]
    for shard_idx, local_row in cases:
        packed = pack_thumb_ref(shard_idx, local_row)
        assert packed < 2**32, "packed ref must fit point_index.bin's local_idx:u32"
        assert unpack_thumb_ref(packed) == (shard_idx, local_row)


def test_pack_unpack_round_trip_vectorized():
    """The points-table build packs 2M rows at once; that must be the same function
    (and the same answer) as the server's per-request unpack."""
    rng = np.random.default_rng(0)
    shard_idx = rng.integers(0, 2015, size=10_000, dtype=np.int64)
    local_row = rng.integers(0, 10_000, size=10_000, dtype=np.int64)

    packed = pack_thumb_ref(shard_idx, local_row)
    assert packed.max() < 2**32
    back_shard, back_local = unpack_thumb_ref(packed)
    assert np.array_equal(back_shard, shard_idx)
    assert np.array_equal(back_local, local_row)

    # elementwise agreement with the scalar path, not just self-consistency
    for i in (0, 1, 500, 9999):
        assert int(packed[i]) == pack_thumb_ref(int(shard_idx[i]), int(local_row[i]))


def test_pack_rejects_out_of_range():
    with pytest.raises(ValueError):
        pack_thumb_ref(0, THUMB_REF_STRIDE)  # local_row wider than 16 bits
    with pytest.raises(ValueError):
        pack_thumb_ref(-1, 0)
    with pytest.raises(ValueError):
        pack_thumb_ref(0, -1)
    with pytest.raises(ValueError):
        pack_thumb_ref(np.array([0, THUMB_REF_STRIDE]), np.array([0, 0]))


def _write_shard(shards_dir, shard_idx: int, blobs: list[bytes], done: bool = True) -> None:
    """Write one shard in the exact layout scripts/pull_pool_thumbs256.py produces."""
    shards_dir.mkdir(parents=True, exist_ok=True)
    base = shards_dir / f"{shard_idx:04d}"
    offsets = [0]
    for b in blobs:
        offsets.append(offsets[-1] + len(b))
    base.with_suffix(".blob").write_bytes(b"".join(blobs))
    base.with_suffix(".offsets.u64").write_bytes(
        b"".join(struct.pack("<Q", o) for o in offsets)
    )
    if done:
        base.with_suffix(".done").touch()


def test_store_reads_spans_and_degrades(tmp_path):
    shards_dir = tmp_path / "shards"
    # row 1 is a decode failure during the pull: zero-length span, dense offsets
    _write_shard(shards_dir, 0, [b"AAAA", b"", b"CCCCCC"])
    _write_shard(shards_dir, 7, [b"seven"], done=False)  # still being written

    store = MonetThumbStore(shards_dir, max_open_shards=2)
    try:
        assert store.read(0, 0) == b"AAAA"
        assert store.read(0, 2) == b"CCCCCC"
        assert store.read(0, 1) == b"", "decode-failed row must read as empty, not raise"
        assert store.read(7, 0) == b"", "a shard without .done must read as empty, not raise"
        assert store.read(999, 0) == b"", "an absent shard must read as empty, not raise"
        assert store.read_packed(pack_thumb_ref(0, 2)) == b"CCCCCC"
        with pytest.raises(IndexError):
            store.read(0, 3)  # past the shard's rows: a provenance bug, must be loud
    finally:
        store.close()


def test_store_fd_cache_is_bounded(tmp_path):
    """2,015 shards x 2 fds would blow the process fd limit — the cache is an LRU."""
    shards_dir = tmp_path / "shards"
    for i in range(6):
        _write_shard(shards_dir, i, [bytes([65 + i]) * 4])

    store = MonetThumbStore(shards_dir, max_open_shards=2)
    try:
        for i in range(6):
            assert store.read(i, 0) == bytes([65 + i]) * 4
            assert len(store._open) <= 2
        # an evicted shard still reads correctly (it just reopens)
        assert store.read(0, 0) == b"AAAA"
    finally:
        store.close()


class _PartialThumbnailSource:
    """Every other row has no thumbnail — the shape of a partially-pulled store."""

    def open(self, row_id: int) -> bytes:
        if row_id % 2:
            return b""
        import io

        rng = np.random.default_rng(row_id)
        arr = (rng.random((40, 30, 3)) * 255).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="PNG")
        return buf.getvalue()


def test_atlas_skips_and_counts_empty_thumbnails():
    local_ids = np.arange(8, dtype=np.int64)
    row_ids = np.arange(8, dtype=np.int64)

    atlas, n_blank = build_chunk_atlas_png(
        local_ids, row_ids, _PartialThumbnailSource(), tile_px=32, atlas_px=2048
    )
    assert n_blank == 4, "one blank per empty thumbnail, reported not swallowed"

    tiles_per_side = 2048 // 32
    for local_id in local_ids.tolist():
        col, row = local_id % tiles_per_side, local_id // tiles_per_side
        box = (col * 32, row * 32, (col + 1) * 32, (row + 1) * 32)
        pixels = np.asarray(atlas.crop(box))
        is_background = bool((pixels.reshape(-1, 3) == np.array(BACKGROUND_RGB)).all())
        assert is_background == bool(local_id % 2), (
            f"tile {local_id}: skipped tiles must keep the atlas background, "
            "painted tiles must not"
        )


def test_atlas_all_thumbnails_present_reports_zero_blanks():
    """The BL path is unaffected: a source that always returns bytes reports 0."""

    class _AlwaysPresent:
        def open(self, row_id: int) -> bytes:
            import io

            buf = io.BytesIO()
            Image.new("RGB", (24, 16), (200, 30, 30)).save(buf, format="PNG")
            return buf.getvalue()

    local_ids = np.arange(4, dtype=np.int64)
    atlas, n_blank = build_chunk_atlas_png(
        local_ids, local_ids, _AlwaysPresent(), tile_px=32, atlas_px=2048
    )
    assert n_blank == 0
    assert np.asarray(atlas.crop((0, 0, 32, 32))).reshape(-1, 3).mean(axis=0)[0] > 100
