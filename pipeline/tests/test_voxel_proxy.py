"""voxel_proxy.bin: the frozen byte layout, canonical (chunk_id, local_voxel_id)
ordering, round-trip through the writer/reader, and the guards that keep a file from
ever meaning something other than "each chunk's occupied list, in order"."""
from __future__ import annotations

import numpy as np
import pytest

from lsvoxel.chunkpack import metablob
from lsvoxel.chunkpack.voxel_proxy import (
    VOXEL_PROXY_HEADER_DTYPE,
    VOXEL_PROXY_RECORD_DTYPE,
    build_voxel_proxy_records,
    read_voxel_proxy,
    read_voxel_proxy_header,
    records_for_chunk,
    write_voxel_proxy,
)


def _chunk_table(rng: np.random.Generator, n_occupied: int) -> tuple[np.ndarray, np.ndarray]:
    """A 16^3 VoxelRecord table with n_occupied random voxels filled the way
    build.assign_and_build fills them; returns (table, occupied local ids ascending)."""
    recs = metablob.new_voxel_records(16**3)
    lids = np.sort(rng.choice(16**3, size=n_occupied, replace=False))
    recs["count"][lids] = rng.integers(1, 65536, size=n_occupied)
    recs["point_offset"][lids] = np.cumsum(recs["count"][lids]) - recs["count"][lids]
    recs["color_rgb"][lids] = rng.integers(0, 256, size=(n_occupied, 3))
    recs["flags"][lids] = metablob.FLAG_HAS_ATLAS_TILE
    recs["repr_row_id"][lids] = rng.integers(0, 1_000_000, size=n_occupied)
    return recs, lids


def test_records_for_chunk_is_the_occupied_list_in_order():
    rng = np.random.default_rng(0)
    table, lids = _chunk_table(rng, 300)
    # count saturates at 65535 in meta.bin; a saturated voxel must pass through as-is
    table["count"][lids[0]] = 65535

    recs = records_for_chunk(7, table)
    assert recs.dtype == VOXEL_PROXY_RECORD_DTYPE
    assert recs["local_voxel_id"].tolist() == lids.tolist()
    assert (recs["chunk_id"] == 7).all()
    assert np.array_equal(recs["count"], table["count"][lids])
    assert int(recs["count"][0]) == 65535
    assert np.array_equal(recs["color_rgb"], table["color_rgb"][lids])
    assert np.array_equal(recs["flags"], table["flags"][lids])
    # empty chunk -> empty run, still the right dtype
    assert len(records_for_chunk(3, metablob.new_voxel_records(16**3))) == 0


def test_round_trip_and_byte_layout(tmp_path):
    rng = np.random.default_rng(1)
    # chunk order deliberately scrambled: the builder owns the canonical sort
    runs = []
    expected_by_chunk = {}
    for cid, n_occ in ((5, 40), (0, 12), (999, 1), (17, 250)):
        table, lids = _chunk_table(rng, n_occ)
        runs.append(records_for_chunk(cid, table))
        expected_by_chunk[cid] = (table, lids)
    records = build_voxel_proxy_records(runs)
    n = sum(len(r) for r in runs)
    assert len(records) == n
    assert records["chunk_id"].tolist() == sorted(records["chunk_id"].tolist())
    for cid, (table, lids) in expected_by_chunk.items():
        run = records[records["chunk_id"] == cid]
        assert run["local_voxel_id"].tolist() == lids.tolist()
        assert np.array_equal(run["count"], table["count"][lids])
        assert np.array_equal(run["color_rgb"], table["color_rgb"][lids])

    path = tmp_path / "voxel_proxy.bin"
    write_voxel_proxy(path, 160, 16, records)

    # header at the frozen offsets, 16 bytes, records immediately after
    raw = path.read_bytes()
    assert len(raw) == 16 + 12 * n
    assert raw[0:4] == b"LSVV"
    assert int.from_bytes(raw[4:6], "little") == 1  # version
    assert int.from_bytes(raw[6:8], "little") == 0  # reserved
    assert int.from_bytes(raw[8:12], "little") == n  # n_voxels
    assert int.from_bytes(raw[12:14], "little") == 160  # num_voxels
    assert int.from_bytes(raw[14:16], "little") == 16  # voxels_per_chunk
    assert VOXEL_PROXY_HEADER_DTYPE.itemsize == 16
    assert VOXEL_PROXY_RECORD_DTYPE.itemsize == 12
    # first record: chunk_id u32 @0, local_voxel_id u16 @4, count u16 @6, rgb @8, flags @11
    first = records[0]
    rec0 = raw[16:28]
    assert int.from_bytes(rec0[0:4], "little") == int(first["chunk_id"])
    assert int.from_bytes(rec0[4:6], "little") == int(first["local_voxel_id"])
    assert int.from_bytes(rec0[6:8], "little") == int(first["count"])
    assert list(rec0[8:11]) == first["color_rgb"].tolist()
    assert rec0[11] == int(first["flags"])

    assert read_voxel_proxy_header(path) == (160, 16, n)
    vp = read_voxel_proxy(path)
    assert (vp.num_voxels, vp.voxels_per_chunk, vp.n_voxels) == (160, 16, n)
    assert np.array_equal(vp.records, records)


def test_empty_dataset_round_trips(tmp_path):
    path = tmp_path / "voxel_proxy.bin"
    write_voxel_proxy(path, 96, 16, build_voxel_proxy_records([]))
    assert path.stat().st_size == 16
    assert read_voxel_proxy(path).n_voxels == 0


def test_writer_rejects_disorder_duplicates_and_out_of_range(tmp_path):
    rng = np.random.default_rng(2)
    table, _ = _chunk_table(rng, 20)
    records = build_voxel_proxy_records([records_for_chunk(1, table), records_for_chunk(2, table)])
    path = tmp_path / "voxel_proxy.bin"

    with pytest.raises(ValueError, match="sorted"):
        write_voxel_proxy(path, 160, 16, records[::-1].copy())
    dup = np.concatenate([records[:1], records])
    with pytest.raises(ValueError, match="duplicates"):
        write_voxel_proxy(path, 160, 16, dup)
    # chunk 2 doesn't exist in a 16^3 world (one chunk slot)
    with pytest.raises(ValueError, match="chunk_id out of range"):
        write_voxel_proxy(path, 16, 16, records)
    with pytest.raises(ValueError, match="divisible"):
        write_voxel_proxy(path, 100, 16, records)
    with pytest.raises(ValueError, match="VOXEL_PROXY_RECORD_DTYPE"):
        write_voxel_proxy(path, 160, 16, np.zeros(3, dtype=np.uint8))


def test_reader_rejects_bad_magic_truncation_and_disorder(tmp_path):
    rng = np.random.default_rng(3)
    table, _ = _chunk_table(rng, 20)
    records = build_voxel_proxy_records([records_for_chunk(1, table), records_for_chunk(2, table)])
    path = tmp_path / "voxel_proxy.bin"
    write_voxel_proxy(path, 160, 16, records)
    good = bytearray(path.read_bytes())

    bad = tmp_path / "bad.bin"
    bad.write_bytes(b"LSVP" + bytes(good[4:]))
    with pytest.raises(ValueError, match="bad magic"):
        read_voxel_proxy(bad)

    bad.write_bytes(bytes(good[:-12]))
    with pytest.raises(ValueError, match="size mismatch"):
        read_voxel_proxy(bad)

    bad.write_bytes(bytes(good[:8]))
    with pytest.raises(ValueError, match="truncated"):
        read_voxel_proxy_header(bad)

    # records swapped on disk: a file that skipped the writer's guard is still refused
    swapped = bytearray(good)
    swapped[16:28], swapped[28:40] = good[28:40], good[16:28]
    bad.write_bytes(bytes(swapped))
    with pytest.raises(ValueError, match="sorted"):
        read_voxel_proxy(bad)
