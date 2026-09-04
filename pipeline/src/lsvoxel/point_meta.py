"""point_meta.bin — whole-dataset, per-row original-image metadata (URL + pixel
size), readable with the stdlib alone.

The app's lightbox shows the full-resolution original of a point on demand. Neither
dataset's originals are on this box: BL's live on Flickr, MONET's crawl sources at
the source site (see the `image_url` / `image_width` / `image_height` columns the
dataset modules add to each points table). The lookup happens in
`scripts/data_server.py`, which runs under `/usr/bin/python3` with no
numpy/pandas/pyarrow (the same constraint `monet_thumbs.py` lives under), and it
happens once per lightbox open — one row out of 1–2M. A fixed-width record table plus
a byte blob answers that with two `pread`s and nothing resident, the same shape as the
MONET thumbnail store. It is NOT shipped to the client (a 2M-row table is ~250 MB);
the client asks the server for one row at a time via `GET /meta/<points_id>/<row_id>`.

Row i of the file is row_id i of the points table it was built from — the same frozen
row-order contract as everything else under `points/<id>/` (see `points_table.py`).
Rebuild it whenever the table is rebuilt: `scripts/build_point_meta.py <points_id>`.

Layout (little-endian; every offset is from the start of the file unless it says
otherwise). FROZEN at version 1: a layout change bumps `VERSION`, and the reader
refuses a version or flag it doesn't know rather than guessing.

  Header, 32 B:
    magic          char[4]  @0   "LSVM"
    version        u16      @4   1
    flags          u16      @6   0  (reserved; non-zero is rejected)
    n_rows         u32      @8
    records_offset u32      @12  32 (== HEADER_BYTES)
    blob_offset    u64      @16  records_offset + 12 * n_rows
    blob_bytes     u64      @24

  Record x n_rows, 12 B each, index == row_id:
    url_offset     u32      @0   byte offset INTO THE BLOB (not into the file)
    url_len        u16      @4   0 == no url
    width          u16      @6   0 == unknown; clamped at 65535
    height         u16      @8   ditto
    reserved       u16      @10  0

  Blob, blob_bytes B: every row's URL as UTF-8, concatenated in row order — so
  url_offset is non-decreasing and row i's bytes are blob[url_offset : url_offset+url_len].

`point_meta.json` is written beside the `.bin` (n_rows, n_with_url, bytes, sha256)
for humans and the data catalog; the reader trusts only the header.

**stdlib only on the reader path.** numpy and pyarrow are imported inside the writer
functions, never at module level, so `scripts/data_server.py` can import
`PointMetaStore` under the system python.
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
import threading
from pathlib import Path

MAGIC = b"LSVM"
VERSION = 1
HEADER_BYTES = 32
RECORD_BYTES = 12

#: `<4s H H I I Q Q` — magic, version, flags, n_rows, records_offset, blob_offset, blob_bytes
_HEADER_STRUCT = struct.Struct("<4sHHIIQQ")
#: `<I H H H H` — url_offset, url_len, width, height, reserved
_RECORD_STRUCT = struct.Struct("<IHHHH")
assert _HEADER_STRUCT.size == HEADER_BYTES, _HEADER_STRUCT.size
assert _RECORD_STRUCT.size == RECORD_BYTES, _RECORD_STRUCT.size

#: u16 ceilings the writer enforces (url_len) or clamps to (width/height).
MAX_URL_BYTES = 0xFFFF
MAX_DIM = 0xFFFF


# ---------------------------------------------------------------------------
# Reader (stdlib)
# ---------------------------------------------------------------------------


class PointMetaHeader:
    """The validated 32-byte header of one file."""

    __slots__ = ("n_rows", "records_offset", "blob_offset", "blob_bytes")

    def __init__(self, n_rows: int, records_offset: int, blob_offset: int, blob_bytes: int):
        self.n_rows = n_rows
        self.records_offset = records_offset
        self.blob_offset = blob_offset
        self.blob_bytes = blob_bytes

    @property
    def file_bytes(self) -> int:
        return self.blob_offset + self.blob_bytes


def parse_header(raw: bytes, file_size: int | None = None, name: str = "point_meta.bin") -> PointMetaHeader:
    """Validate the header bytes (and, if given, the file size against them).

    Every field that can be cross-checked is: a truncated file, a swapped-in
    different format, or a future layout all fail here rather than on a lookup that
    reads garbage offsets.
    """
    if len(raw) < HEADER_BYTES:
        raise ValueError(f"{name}: truncated header ({len(raw)} of {HEADER_BYTES} bytes)")
    magic, version, flags, n_rows, records_offset, blob_offset, blob_bytes = _HEADER_STRUCT.unpack(
        raw[:HEADER_BYTES]
    )
    if magic != MAGIC:
        raise ValueError(f"{name}: bad magic {magic!r}")
    if version != VERSION:
        raise ValueError(f"{name}: unsupported version {version}")
    if flags != 0:
        raise ValueError(f"{name}: unknown flags 0x{flags:04x}")
    if records_offset != HEADER_BYTES:
        raise ValueError(f"{name}: records_offset {records_offset} != {HEADER_BYTES}")
    if blob_offset != records_offset + RECORD_BYTES * n_rows:
        raise ValueError(
            f"{name}: blob_offset {blob_offset} != records_offset + {RECORD_BYTES} * n_rows"
        )
    header = PointMetaHeader(n_rows, records_offset, blob_offset, blob_bytes)
    if file_size is not None and file_size != header.file_bytes:
        raise ValueError(
            f"{name}: size mismatch, file is {file_size} B, header implies {header.file_bytes} B"
        )
    return header


def read_point_meta_header(path: Path) -> PointMetaHeader:
    """Header alone — enough to know n_rows or size buffers without touching records."""
    path = Path(path)
    with open(path, "rb") as f:
        raw = f.read(HEADER_BYTES)
    return parse_header(raw, path.stat().st_size, path.name)


class PointMetaStore:
    """Random access into one `point_meta.bin`: `lookup(row_id)`.

    Built for the data server's `/meta` route — one call per interactive request
    from arbitrary handler threads — and for verification scripts. The file's fd is
    opened once and held for the store's lifetime; reads are positional (`os.pread`)
    and therefore thread-safe by construction. One lock still covers each lookup so
    `close()` can never pull the fd out from under a `pread` in another thread; the
    two reads are page-cache hits once warm, so holding it across them costs nothing
    measurable.

    The header is validated on open (magic, version, flags, offsets, and file size),
    so a store that opened will not read past the file on any in-range row.
    """

    def __init__(self, path: Path):
        self._path = Path(path)
        self._fd = os.open(self._path, os.O_RDONLY)
        try:
            st = os.fstat(self._fd)
            self._header = parse_header(os.pread(self._fd, HEADER_BYTES, 0), st.st_size, self._path.name)
            self._inode = (st.st_dev, st.st_ino)
        except Exception:
            os.close(self._fd)
            self._fd = -1
            raise
        self._lock = threading.Lock()

    # -- public API --------------------------------------------------------

    @property
    def path(self) -> Path:
        return self._path

    @property
    def n_rows(self) -> int:
        return self._header.n_rows

    def lookup(self, row_id: int) -> dict:
        """`{"url": str | None, "width": int, "height": int}` for one row.

        `IndexError` for a row_id outside `[0, n_rows)` — that's a caller bug or a
        stale client, and the route turns it into a 404. A record whose URL span
        runs past the blob is a corrupt file and raises `ValueError` instead.
        """
        row_id = int(row_id)
        if not 0 <= row_id < self._header.n_rows:
            raise IndexError(f"row_id {row_id} out of range (file has {self._header.n_rows} rows)")
        with self._lock:
            if self._fd < 0:
                raise ValueError(f"{self._path.name}: store is closed")
            raw = os.pread(self._fd, RECORD_BYTES, self._header.records_offset + RECORD_BYTES * row_id)
            if len(raw) != RECORD_BYTES:
                raise OSError(f"{self._path.name}: short read of record {row_id}")
            url_offset, url_len, width, height, _reserved = _RECORD_STRUCT.unpack(raw)
            data = b""
            if url_len:
                if url_offset + url_len > self._header.blob_bytes:
                    raise ValueError(
                        f"{self._path.name}: record {row_id} url span "
                        f"[{url_offset}, {url_offset + url_len}) exceeds blob of "
                        f"{self._header.blob_bytes} B"
                    )
                data = os.pread(self._fd, url_len, self._header.blob_offset + url_offset)
                if len(data) != url_len:
                    raise OSError(f"{self._path.name}: short read of url for record {row_id}")
        return {
            "url": data.decode("utf-8") if url_len else None,
            "width": width,
            "height": height,
        }

    def is_current(self) -> bool:
        """False once the file at `path` is no longer the one this store opened —
        i.e. after a rebuild replaced it via rename. A long-running server checks
        this (one `stat`) to reopen instead of serving the old inode forever."""
        try:
            st = os.stat(self._path)
        except OSError:
            return False
        return (st.st_dev, st.st_ino) == self._inode

    def close(self) -> None:
        with self._lock:
            if self._fd >= 0:
                try:
                    os.close(self._fd)
                finally:
                    self._fd = -1

    def __enter__(self) -> "PointMetaStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Writer (numpy + pyarrow, imported lazily)
# ---------------------------------------------------------------------------


def encode_urls(urls):
    """`(url_offset:u32[n], url_len:u16[n], blob:u8[blob_bytes])` for a column of
    URLs, without touching rows one at a time.

    Goes through pyarrow's string layout, which IS this format's (an int offsets
    array over one concatenated UTF-8 buffer): a parquet column read with pyarrow is
    already in it, and anything else (a pandas Series, a list of `str | None`) is
    converted by `pa.array` in C. Nulls and empty strings both become a zero-length
    span, so "no url" has exactly one encoding — `url_len == 0`.
    """
    import numpy as np
    import pyarrow as pa
    import pyarrow.compute as pc

    if isinstance(urls, pa.ChunkedArray):
        arr = urls.combine_chunks()
    elif isinstance(urls, pa.Array):
        arr = urls
    else:
        arr = pa.array(urls, type=pa.large_string())
    # large_string for one code path (int64 offsets whatever the input width);
    # fill_null rebuilds the buffers so every null slot is a zero-length span —
    # the Arrow spec leaves a null slot's span undefined, which we can't have in a
    # blob that claims to be "the URLs, concatenated".
    arr = pc.fill_null(pc.cast(arr, pa.large_string()), "")
    n = len(arr)
    _validity, offsets_buf, data_buf = arr.buffers()
    offsets = np.frombuffer(offsets_buf, dtype=np.int64)[arr.offset : arr.offset + n + 1]
    data = np.frombuffer(data_buf, dtype=np.uint8) if data_buf is not None else np.zeros(0, np.uint8)
    blob = data[offsets[0] : offsets[-1]]  # a sliced array's data may start past 0
    url_offset = offsets[:-1] - offsets[0]
    url_len = np.diff(offsets)

    if n and url_len.max() > MAX_URL_BYTES:
        worst = int(url_len.argmax())
        raise ValueError(
            f"url at row {worst} is {int(url_len[worst])} bytes; url_len is u16 "
            f"(max {MAX_URL_BYTES}) — refusing to truncate a URL"
        )
    if len(blob) >= 2**32:
        raise ValueError(f"url blob is {len(blob)} bytes; url_offset is u32")
    return url_offset.astype(np.uint32), url_len.astype(np.uint16), blob


def _dims_u16(values, n: int, name: str):
    """Pixel dimensions as u16: NaN/None -> 0 (unknown), negatives -> 0, > 65535 clamped."""
    import numpy as np

    arr = np.asarray(values)
    if arr.shape != (n,):
        raise ValueError(f"{name} has shape {arr.shape}, expected ({n},)")
    if arr.dtype.kind not in "iu":
        arr = np.nan_to_num(arr.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(arr, 0, MAX_DIM).astype(np.uint16)


def write_point_meta(path: Path, urls, widths, heights) -> dict:
    """Write `point_meta.bin` (atomically) and its `point_meta.json` sidecar;
    returns the sidecar's contents.

    `urls` is anything `encode_urls` accepts, in row_id order; `widths`/`heights`
    are int-like arrays of the same length (0 == unknown).
    """
    import numpy as np

    path = Path(path)
    url_offset, url_len, blob = encode_urls(urls)
    n = len(url_len)
    width = _dims_u16(widths, n, "widths")
    height = _dims_u16(heights, n, "heights")

    records = np.zeros(
        n,
        dtype=np.dtype(
            [
                ("url_offset", "<u4"),
                ("url_len", "<u2"),
                ("width", "<u2"),
                ("height", "<u2"),
                ("reserved", "<u2"),
            ]
        ),
    )
    assert records.dtype.itemsize == RECORD_BYTES
    records["url_offset"] = url_offset
    records["url_len"] = url_len
    records["width"] = width
    records["height"] = height

    header = _HEADER_STRUCT.pack(
        MAGIC, VERSION, 0, n, HEADER_BYTES, HEADER_BYTES + RECORD_BYTES * n, len(blob)
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    digest = hashlib.sha256()
    total = 0
    try:
        with open(tmp, "wb") as f:
            for chunk in (header, records.tobytes(), blob.tobytes()):
                f.write(chunk)
                digest.update(chunk)
                total += len(chunk)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()

    summary = {
        "format": MAGIC.decode("ascii"),
        "version": VERSION,
        "n_rows": int(n),
        "n_with_url": int(np.count_nonzero(url_len)),
        "bytes": int(total),
        "sha256": digest.hexdigest(),
    }
    sidecar = path.with_suffix(".json")
    sidecar_tmp = sidecar.with_name(sidecar.name + ".tmp")
    sidecar_tmp.write_text(json.dumps(summary, indent=1) + "\n")
    os.replace(sidecar_tmp, sidecar)
    return summary
