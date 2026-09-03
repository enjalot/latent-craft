"""MONET packed-thumbnail store — the ONE place that knows how a MONET point's
thumbnail is addressed, and the one place the packed reference is encoded/decoded.

Two things live here:

1. **The packed thumbnail reference** (`pack_thumb_ref` / `unpack_thumb_ref`).
   MONET thumbnails aren't files, they're byte ranges inside per-shard blobs, so a
   point needs *two* numbers to locate its image: the pool's HF shard index and the
   row within that shard (`pool-20m/prov_shard_idx[r]`, `prov_local_row[r]`). But the
   pipeline↔frontend contract (`chunkpack/pointindex.py`'s `point_index.bin`) has
   exactly one u32 field per point for this — `local_idx`, fed from the points table's
   `global_idx` column. So the pair is packed into that single u32:

       packed = shard_idx * 65536 + local_row        (== shard_idx << 16 | local_row)

   Both halves fit: the pool has 2,015 shards (max index 2014) and at most 10,000 rows
   per shard (max local row 9,999), so the packed value maxes out around 1.32e8 — well
   inside u32. `pack_thumb_ref` validates both halves rather than silently wrapping.

   This packing is decoded in exactly two places, both of which import from here:
   `datasets/monet.py` (build-time round-trip assertion) and
   `scripts/data_server.py`'s `/thumbs/monet/<packed>.webp` route (serve time).

2. **`MonetThumbStore`**, the reader for the blob+offsets store that
   `scripts/pull_pool_thumbs256.py` writes:

       shards/{shard_idx:04d}.blob         concatenated 256px WEBP bytes, HF row order
       shards/{shard_idx:04d}.offsets.u64  n_rows+1 cumulative byte offsets (uint64 LE)
       shards/{shard_idx:04d}.done         written last; absence == shard not usable yet

   Lookup: `offsets[local_row : local_row+2]` gives the byte range in `.blob`. A row
   whose source image failed to decode has a ZERO-LENGTH span, and a shard that hasn't
   been pulled yet has no files at all — both degrade to `b""` (a blank atlas tile / a
   404) rather than an exception, which is what lets a chunk-pack build run against a
   partially-populated store.

**stdlib only, on purpose.** `scripts/data_server.py` runs under `/usr/bin/python3`
(see its systemd unit), which has no numpy — so this module reads spans with
`os.pread` + `struct` instead of `np.memmap`. That also makes reads positional and
therefore thread-safe by construction, which the server's `ThreadingHTTPServer` needs,
and keeps memory flat (no per-shard offsets array resident: 2,015 shards x 80 KB would
be 160 MB of offsets alone).
"""
from __future__ import annotations

import os
import struct
import threading
from collections import OrderedDict
from pathlib import Path

from .config import MONET_THUMBS_SHARDS_DIR

#: Rows per HF shard is capped at 10,000, so 16 bits is enough for `local_row`
#: with room to spare. Changing this INVALIDATES every built `point_index.bin`.
THUMB_REF_LOCAL_ROW_BITS = 16
THUMB_REF_STRIDE = 1 << THUMB_REF_LOCAL_ROW_BITS  # 65536

#: Bytes per entry in a `.offsets.u64` file.
_OFFSET_BYTES = 8
#: How many shards keep their file descriptors open at once. Two fds per shard, and
#: the pool has 2,015 shards — opening them all would blow past the usual 1024 fd
#: limit, so the cache is a plain LRU.
DEFAULT_MAX_OPEN_SHARDS = 128


def pack_thumb_ref(shard_idx, local_row):
    """`(shard_idx, local_row)` -> the single u32 stored as `global_idx` / `local_idx`.

    Works elementwise on numpy arrays as well as on plain ints (arithmetic only), so
    the 2M-row points-table build and a single server request use the same function.
    """
    if _any_out_of_range(local_row, 0, THUMB_REF_STRIDE):
        raise ValueError(
            f"local_row must be in [0, {THUMB_REF_STRIDE}) to pack into "
            f"{THUMB_REF_LOCAL_ROW_BITS} bits"
        )
    if _any_out_of_range(shard_idx, 0, 1 << (32 - THUMB_REF_LOCAL_ROW_BITS)):
        raise ValueError(
            f"shard_idx must be in [0, {1 << (32 - THUMB_REF_LOCAL_ROW_BITS)}) to pack "
            "into the upper half of a u32"
        )
    return shard_idx * THUMB_REF_STRIDE + local_row


def unpack_thumb_ref(packed):
    """The inverse of `pack_thumb_ref`. Also elementwise-safe on numpy arrays."""
    if _any_out_of_range(packed, 0, 1 << 32):
        raise ValueError("packed thumb ref must be in [0, 2**32)")
    return divmod(packed, THUMB_REF_STRIDE)


def _any_out_of_range(value, lo: int, hi: int) -> bool:
    """Range check that works for a python int and for a numpy array alike, without
    importing numpy (this module has to stay stdlib-only — see the module docstring)."""
    bad = (value < lo) | (value >= hi)
    any_ = getattr(bad, "any", None)
    return bool(any_()) if any_ is not None else bool(bad)


class _OpenShard:
    __slots__ = ("blob_fd", "offsets_fd", "n_rows")

    def __init__(self, blob_fd: int, offsets_fd: int, n_rows: int):
        self.blob_fd = blob_fd
        self.offsets_fd = offsets_fd
        self.n_rows = n_rows


class MonetThumbStore:
    """Random access into the packed thumbnail store, with cached file descriptors.

    Built for two very different callers with the same requirements (don't reopen a
    file per lookup, don't hold 2,015 shards open, never raise on a shard that hasn't
    been pulled yet): the chunk-pack atlas builder (one call per occupied voxel, up to
    hundreds of thousands per build) and the data server's thumbnail route (one call
    per interactive request, from arbitrary handler threads).

    Thread-safety: one lock covers the whole `read`, so a shard can never be evicted
    and its fds closed while another thread is mid-`pread` on them. The reads
    themselves are two `pread`s against the page cache — microseconds once warm — so
    holding the lock across them costs far less than the bookkeeping to avoid it.
    """

    def __init__(
        self,
        shards_dir: Path = MONET_THUMBS_SHARDS_DIR,
        max_open_shards: int = DEFAULT_MAX_OPEN_SHARDS,
    ):
        self._dir = Path(shards_dir)
        self._max_open = max(1, int(max_open_shards))
        self._open: "OrderedDict[int, _OpenShard]" = OrderedDict()
        self._lock = threading.Lock()

    # -- public API --------------------------------------------------------

    def is_shard_ready(self, shard_idx: int) -> bool:
        """True once `pull_pool_thumbs256.py` has finished this shard (`.done` marker
        plus both data files present)."""
        base = self._dir / f"{int(shard_idx):04d}"
        return (
            base.with_suffix(".done").exists()
            and base.with_suffix(".blob").exists()
            and base.with_suffix(".offsets.u64").exists()
        )

    def read(self, shard_idx: int, local_row: int) -> bytes:
        """Thumbnail bytes for one pool row, or `b""` when there aren't any.

        `b""` means one of: the shard hasn't been pulled yet, or the row's source
        image failed to decode during the pull (recorded as a zero-length span). Both
        are expected states while the pull job is still running, so neither raises.

        A `local_row` outside the shard's row count DOES raise — that's a points-table
        / provenance inconsistency, not a missing thumbnail, and silently returning
        blank would hide it.
        """
        with self._lock:
            shard = self._acquire(int(shard_idx))
            if shard is None:
                return b""
            if not 0 <= local_row < shard.n_rows:
                raise IndexError(
                    f"shard {shard_idx}: local_row {local_row} out of range "
                    f"(shard has {shard.n_rows} rows)"
                )
            raw = os.pread(shard.offsets_fd, 2 * _OFFSET_BYTES, local_row * _OFFSET_BYTES)
            if len(raw) != 2 * _OFFSET_BYTES:
                raise OSError(f"shard {shard_idx}: short read of offsets at row {local_row}")
            start, end = struct.unpack("<2Q", raw)
            if end <= start:
                return b""  # decode-failed row: dense offsets, zero-length span
            data = os.pread(shard.blob_fd, end - start, start)
            if len(data) != end - start:
                raise OSError(
                    f"shard {shard_idx}: short read of blob at row {local_row} "
                    f"({len(data)} of {end - start} bytes)"
                )
            return data

    def read_packed(self, packed: int) -> bytes:
        """`read()` addressed by the packed u32 (see `pack_thumb_ref`)."""
        shard_idx, local_row = unpack_thumb_ref(int(packed))
        return self.read(shard_idx, local_row)

    def close(self) -> None:
        with self._lock:
            while self._open:
                _, shard = self._open.popitem()
                self._close_shard(shard)

    # -- internals ---------------------------------------------------------

    def _acquire(self, shard_idx: int) -> _OpenShard | None:
        """Cached fds for a shard, opening it if needed. None == not available yet.

        Misses are not cached: shards keep completing while a build or the server is
        running, so a shard that wasn't ready a minute ago may be ready now. The cost
        of a miss is a couple of `stat`s.
        """
        shard = self._open.get(shard_idx)
        if shard is not None:
            self._open.move_to_end(shard_idx)
            return shard
        if not self.is_shard_ready(shard_idx):
            return None

        base = self._dir / f"{shard_idx:04d}"
        offsets_path = base.with_suffix(".offsets.u64")
        n_offsets, remainder = divmod(offsets_path.stat().st_size, _OFFSET_BYTES)
        if remainder or n_offsets < 1:
            raise ValueError(f"{offsets_path}: not a whole number of u64 offsets")

        blob_fd = os.open(base.with_suffix(".blob"), os.O_RDONLY)
        try:
            offsets_fd = os.open(offsets_path, os.O_RDONLY)
        except OSError:
            os.close(blob_fd)
            raise

        shard = _OpenShard(blob_fd, offsets_fd, n_offsets - 1)
        self._open[shard_idx] = shard
        while len(self._open) > self._max_open:
            _, evicted = self._open.popitem(last=False)
            self._close_shard(evicted)
        return shard

    @staticmethod
    def _close_shard(shard: _OpenShard) -> None:
        for fd in (shard.blob_fd, shard.offsets_fd):
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self) -> "MonetThumbStore":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
