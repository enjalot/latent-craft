"""point_meta.bin: the frozen byte layout, writer/reader round trip (including rows
with no URL and non-ASCII URLs), the header guards, and the stdlib-only reader path
the data server depends on. All synthetic, no /data access."""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pytest

from lsvoxel.point_meta import (
    HEADER_BYTES,
    MAX_URL_BYTES,
    RECORD_BYTES,
    PointMetaStore,
    encode_urls,
    read_point_meta_header,
    write_point_meta,
)

SRC = Path(__file__).resolve().parents[1] / "src"


def test_round_trip_small_table_and_byte_layout(tmp_path):
    urls = [
        "http://farm4.staticflickr.com/3695/11065397824_12600ec1e8_o.jpg",
        None,  # no url
        "",  # empty == no url, same encoding as None
        "https://例え.テスト/画像/ünïcödé.jpg",  # non-ASCII, multi-byte utf-8
        "https://i.pinimg.com/736x/4f/15/32/4f1532cc1381a3f49c58a4a0970fd5bc.jpg",
    ]
    widths = [1539, 0, 7, 70000, 65535]  # 70000 clamps to 65535
    heights = [2565, 0, 9, 3, 1]
    path = tmp_path / "point_meta.bin"
    summary = write_point_meta(path, urls, widths, heights)

    encoded = [(u or "").encode("utf-8") for u in urls]
    blob = b"".join(encoded)
    raw = path.read_bytes()
    n = len(urls)
    assert len(raw) == HEADER_BYTES + RECORD_BYTES * n + len(blob)

    # header at the frozen offsets
    assert raw[0:4] == b"LSVM"
    assert int.from_bytes(raw[4:6], "little") == 1  # version
    assert int.from_bytes(raw[6:8], "little") == 0  # flags
    assert int.from_bytes(raw[8:12], "little") == n  # n_rows
    assert int.from_bytes(raw[12:16], "little") == 32  # records_offset
    assert int.from_bytes(raw[16:24], "little") == 32 + 12 * n  # blob_offset
    assert int.from_bytes(raw[24:32], "little") == len(blob)  # blob_bytes
    assert raw[32 + 12 * n :] == blob

    # records: url_offset u32 @0, url_len u16 @4, width u16 @6, height u16 @8, reserved @10
    offset = 0
    for i in range(n):
        rec = raw[32 + 12 * i : 32 + 12 * (i + 1)]
        assert int.from_bytes(rec[0:4], "little") == offset, f"row {i} url_offset"
        assert int.from_bytes(rec[4:6], "little") == len(encoded[i]), f"row {i} url_len"
        assert int.from_bytes(rec[6:8], "little") == min(widths[i], 65535)
        assert int.from_bytes(rec[8:10], "little") == min(heights[i], 65535)
        assert int.from_bytes(rec[10:12], "little") == 0
        offset += len(encoded[i])

    header = read_point_meta_header(path)
    assert (header.n_rows, header.blob_offset, header.blob_bytes) == (n, 32 + 12 * n, len(blob))

    with PointMetaStore(path) as store:
        assert store.n_rows == n
        assert store.lookup(0) == {"url": urls[0], "width": 1539, "height": 2565}
        assert store.lookup(1) == {"url": None, "width": 0, "height": 0}
        assert store.lookup(2) == {"url": None, "width": 7, "height": 9}, "empty string reads as no url"
        assert store.lookup(3) == {"url": urls[3], "width": 65535, "height": 3}
        assert store.lookup(4)["url"] == urls[4]
        assert store.lookup(np.uint32(4))["url"] == urls[4], "numpy ints are fine as row ids"
        with pytest.raises(IndexError):
            store.lookup(n)
        with pytest.raises(IndexError):
            store.lookup(-1)
        with pytest.raises(IndexError):
            store.lookup(10**9)
    with pytest.raises(ValueError, match="closed"):
        store.lookup(0)

    # sidecar
    sidecar = json.loads((tmp_path / "point_meta.json").read_text())
    assert sidecar == summary
    assert sidecar["n_rows"] == n
    assert sidecar["n_with_url"] == 3
    assert sidecar["bytes"] == len(raw)
    assert sidecar["sha256"] == hashlib.sha256(raw).hexdigest()
    assert not (tmp_path / "point_meta.bin.tmp").exists()


def test_encode_urls_accepts_arrow_input_including_slices_and_chunks():
    """The builder feeds the parquet column straight in (arrow), and a sliced or
    chunked array must not leak its buffer offset into url_offset."""
    values = ["aa", None, "bbb", "", "cccc"]
    full = pa.array(values)
    expected_lens = [2, 0, 3, 0, 4]

    for arr in (full, full.slice(1, 4), pa.chunked_array([full.slice(0, 2), full.slice(2, 3)])):
        start = 1 if isinstance(arr, pa.Array) and arr.offset else 0
        url_offset, url_len, blob = encode_urls(arr)
        exp = expected_lens[start:]
        assert url_len.tolist() == exp
        assert url_offset.tolist() == np.cumsum([0] + exp[:-1]).tolist()
        assert bytes(blob) == "".join(v or "" for v in values[start:]).encode()
        assert url_offset.dtype == np.uint32 and url_len.dtype == np.uint16


def test_reader_rejects_bad_magic_version_flags_and_truncation(tmp_path):
    path = tmp_path / "point_meta.bin"
    write_point_meta(path, ["http://x/1", None, "http://x/3"], [1, 2, 3], [4, 5, 6])
    good = bytearray(path.read_bytes())
    bad = tmp_path / "bad.bin"

    bad.write_bytes(b"LSVV" + bytes(good[4:]))
    with pytest.raises(ValueError, match="bad magic"):
        PointMetaStore(bad)
    with pytest.raises(ValueError, match="bad magic"):
        read_point_meta_header(bad)

    v2 = bytearray(good)
    v2[4:6] = (2).to_bytes(2, "little")
    bad.write_bytes(bytes(v2))
    with pytest.raises(ValueError, match="unsupported version"):
        PointMetaStore(bad)

    flags = bytearray(good)
    flags[6:8] = (1).to_bytes(2, "little")
    bad.write_bytes(bytes(flags))
    with pytest.raises(ValueError, match="unknown flags"):
        PointMetaStore(bad)

    bad.write_bytes(bytes(good[:-4]))  # blob truncated
    with pytest.raises(ValueError, match="size mismatch"):
        PointMetaStore(bad)

    bad.write_bytes(bytes(good[:16]))  # not even a header
    with pytest.raises(ValueError, match="truncated"):
        PointMetaStore(bad)

    # a record whose span runs past the blob: rejected at lookup, never read
    overrun = bytearray(good)
    overrun[32 + 4 : 32 + 6] = (500).to_bytes(2, "little")  # row 0 url_len
    bad.write_bytes(bytes(overrun))
    with PointMetaStore(bad) as store:
        with pytest.raises(ValueError, match="exceeds blob"):
            store.lookup(0)
        assert store.lookup(2)["url"] == "http://x/3"


def test_writer_refuses_a_url_wider_than_u16(tmp_path):
    with pytest.raises(ValueError, match="u16"):
        write_point_meta(tmp_path / "point_meta.bin", ["x" * (MAX_URL_BYTES + 1)], [0], [0])
    # exactly the ceiling is fine
    write_point_meta(tmp_path / "point_meta.bin", ["x" * MAX_URL_BYTES], [0], [0])
    with PointMetaStore(tmp_path / "point_meta.bin") as store:
        assert len(store.lookup(0)["url"]) == MAX_URL_BYTES


def test_writer_rejects_dimension_length_mismatch(tmp_path):
    with pytest.raises(ValueError, match="widths"):
        write_point_meta(tmp_path / "point_meta.bin", ["a", "b"], [1], [1, 2])


def test_writer_and_reader_agree_on_100k_random_rows(tmp_path):
    rng = np.random.default_rng(7)
    n = 100_000
    alphabet = np.array(list("abcdefghijklmnopqrstuvwxyz0123456789/_-.éü日本"))
    lengths = rng.integers(0, 120, size=n)
    lengths[rng.random(n) < 0.15] = 0  # 15% no url (None), some are "" via length 0
    chars = rng.choice(alphabet, size=int(lengths.sum()))
    bounds = np.cumsum(lengths)
    urls = []
    start = 0
    for i, end in enumerate(bounds.tolist()):
        if end == start:
            urls.append(None if i % 2 else "")
        else:
            urls.append("https://h/" + "".join(chars[start:end]))
        start = end
    widths = rng.integers(0, 80_000, size=n)  # some above the u16 clamp
    heights = rng.integers(-5, 70_000, size=n).astype(np.float64)  # negatives + floats
    heights[rng.random(n) < 0.01] = np.nan  # unknown

    path = tmp_path / "point_meta.bin"
    summary = write_point_meta(path, urls, widths, heights)
    assert summary["n_rows"] == n
    assert summary["n_with_url"] == sum(1 for u in urls if u)

    exp_w = np.clip(widths, 0, 65535)
    exp_h = np.clip(np.nan_to_num(heights, nan=0.0), 0, 65535).astype(np.int64)
    with PointMetaStore(path) as store:
        assert store.n_rows == n
        for i in range(n):
            rec = store.lookup(i)
            assert rec["url"] == (urls[i] or None), i
            assert rec["width"] == int(exp_w[i]), i
            assert rec["height"] == int(exp_h[i]), i


def test_is_current_notices_a_rebuild(tmp_path):
    path = tmp_path / "point_meta.bin"
    write_point_meta(path, ["a"], [1], [1])
    with PointMetaStore(path) as store:
        assert store.is_current()
        write_point_meta(path, ["b"], [2], [2])  # tmp + rename: new inode
        assert not store.is_current()
        assert store.lookup(0)["url"] == "a", "an open store keeps reading the file it opened"
    with PointMetaStore(path) as store:
        assert store.lookup(0)["url"] == "b"


def test_reader_imports_and_reads_without_numpy_pandas_pyarrow(tmp_path):
    """The data server runs under a python with none of those installed. Blocking
    the imports in a subprocess proves the reader path never touches them."""
    path = tmp_path / "point_meta.bin"
    write_point_meta(path, ["https://例え.テスト/画像.jpg", None], [640, 0], [480, 0])
    code = f"""
import sys, json
for name in ("numpy", "pandas", "pyarrow"):
    sys.modules[name] = None  # makes `import <name>` raise ImportError
sys.path.insert(0, {str(SRC)!r})
from lsvoxel.point_meta import PointMetaStore, read_point_meta_header
h = read_point_meta_header({str(path)!r})
with PointMetaStore({str(path)!r}) as s:
    print(json.dumps([h.n_rows, s.lookup(0), s.lookup(1)], ensure_ascii=False))
"""
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == [
        2,
        {"url": "https://例え.テスト/画像.jpg", "width": 640, "height": 480},
        {"url": None, "width": 0, "height": 0},
    ]
