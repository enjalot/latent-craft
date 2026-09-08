"""Byte-exact reader/writer for one chunk's meta.bin — the pipeline<->frontend
contract described in the project plan's Phase 4 section. Every field here must stay
in lockstep with that spec; if you change a layout, update the plan too.

Layout:
  Header (32B): magic="LSV1", version=1, chunk_id, n_voxel_records=4096,
                n_points, voxel_grid_n=16, atlas_tile_px=32, reserved(10B)
  VoxelRecord x n_voxel_records (16B each, ALWAYS present, local_voxel_id 0..N-1):
    count:u16  point_offset:u32  color_rgb:u8[3]  flags:u8  repr_row_id:u32  reserved:u16
  point_ids:u32[n_points] — flattened, grouped by local_voxel_id ascending,
                             row_id ascending within a voxel
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"LSV1"
VERSION = 1
FLAG_HAS_ATLAS_TILE = 1 << 0
EMPTY_REPR_ROW_ID = 0xFFFFFFFF

HEADER_DTYPE = np.dtype(
    [
        ("magic", "S4"),
        ("version", "<u2"),
        ("chunk_id", "<u4"),
        ("n_voxel_records", "<u4"),
        ("n_points", "<u4"),
        ("voxel_grid_n", "<u2"),
        ("atlas_tile_px", "<u2"),
        ("reserved", "V10"),
    ]
)
assert HEADER_DTYPE.itemsize == 32, HEADER_DTYPE.itemsize

VOXEL_RECORD_DTYPE = np.dtype(
    [
        ("count", "<u2"),
        ("point_offset", "<u4"),
        ("color_rgb", "u1", (3,)),
        ("flags", "u1"),
        ("repr_row_id", "<u4"),
        ("reserved", "<u2"),
    ]
)
assert VOXEL_RECORD_DTYPE.itemsize == 16, VOXEL_RECORD_DTYPE.itemsize
WIDE_VOXEL_RECORD_DTYPE = np.dtype([
    ('count', '<u4'), ('point_offset', '<u4'), ('color_rgb', 'u1', (3,)),
    ('flags', 'u1'), ('repr_row_id', '<u4'),
])
SPARSE_VOXEL_RECORD_DTYPE = np.dtype([("local", "<u2"), ("record", WIDE_VOXEL_RECORD_DTYPE)])


@dataclass
class ChunkMeta:
    chunk_id: int
    voxel_grid_n: int
    atlas_tile_px: int
    voxel_records: np.ndarray  # structured array, dtype=VOXEL_RECORD_DTYPE
    point_ids: np.ndarray  # uint32[n_points]

    @property
    def n_voxel_records(self) -> int:
        return len(self.voxel_records)

    @property
    def n_points(self) -> int:
        return len(self.point_ids)


def new_voxel_records(n: int, wide: bool = False) -> np.ndarray:
    """An all-empty VoxelRecord table (count=0, repr_row_id=EMPTY_REPR_ROW_ID)."""
    recs = np.zeros(n, dtype=WIDE_VOXEL_RECORD_DTYPE if wide else VOXEL_RECORD_DTYPE)
    recs["repr_row_id"] = EMPTY_REPR_ROW_ID
    return recs


def write_chunk_meta(path: Path, meta: ChunkMeta) -> None:
    if meta.point_ids.dtype != np.uint32:
        raise ValueError(f"point_ids must be uint32, got {meta.point_ids.dtype}")
    wide = meta.voxel_records.dtype == WIDE_VOXEL_RECORD_DTYPE
    if not wide and meta.voxel_records.dtype != VOXEL_RECORD_DTYPE:
        raise ValueError("voxel_records must use VOXEL_RECORD_DTYPE")

    header = np.zeros(1, dtype=HEADER_DTYPE)
    header["magic"] = MAGIC
    header["version"] = 2 if wide else VERSION
    header["chunk_id"] = meta.chunk_id
    header["n_voxel_records"] = meta.n_voxel_records
    header["n_points"] = meta.n_points
    header["voxel_grid_n"] = meta.voxel_grid_n
    header["atlas_tile_px"] = meta.atlas_tile_px

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.tobytes())
        f.write(meta.voxel_records.tobytes())
        if not wide:
            f.write(meta.point_ids.tobytes())
    if wide:
        meta.point_ids.tofile(path.with_name('postings.bin'))


def read_chunk_meta(path: Path) -> ChunkMeta:
    raw = np.fromfile(path, dtype=np.uint8)
    if len(raw) < 32:
        raise ValueError("Truncated metadata header")
    header = raw[: HEADER_DTYPE.itemsize].view(HEADER_DTYPE)[0]
    if bytes(header["magic"]) != MAGIC:
        raise ValueError(f"{path}: bad magic {bytes(header['magic'])!r}")
    sparse = int(header['version']) == 3
    wide = int(header['version']) >= 2
    if int(header["version"]) not in (VERSION, 2, 3):
        raise ValueError(f"{path}: unsupported version {header['version']}")

    n_voxel_records = int(header["n_voxel_records"])
    n_points = int(header["n_points"])
    off = HEADER_DTYPE.itemsize
    if sparse:
        count = int(raw[22:26].view("<u4")[0])
        if n_voxel_records != int(header["voxel_grid_n"]) ** 3 or n_voxel_records > 65536 or count > n_voxel_records:
            raise ValueError("Invalid sparse voxel grid")
        vrec_bytes = count * SPARSE_VOXEL_RECORD_DTYPE.itemsize
        if len(raw) != off + vrec_bytes:
            raise ValueError("Sparse metadata size mismatch")
        stored = raw[off:].view(SPARSE_VOXEL_RECORD_DTYPE)
        ids = stored["local"]
        if np.any(ids >= n_voxel_records) or np.any(ids[1:] <= ids[:-1]) or np.any(stored["record"]["count"] == 0):
            raise ValueError("Invalid sparse voxel IDs/counts")
        voxel_records = new_voxel_records(n_voxel_records, wide=True)
        voxel_records[ids] = stored["record"]
    else:
        vrec_bytes = n_voxel_records * VOXEL_RECORD_DTYPE.itemsize
        voxel_records = raw[off : off + vrec_bytes].view(WIDE_VOXEL_RECORD_DTYPE if wide else VOXEL_RECORD_DTYPE).copy()
    off += vrec_bytes
    point_ids_bytes = n_points * 4
    if wide:
        posting_path = path.with_name('postings.bin')
        if posting_path.stat().st_size != point_ids_bytes:
            raise ValueError('postings size mismatch')
        point_ids = np.memmap(posting_path, dtype='<u4', mode='r') if n_points else np.zeros(0, dtype='<u4')
    else:
        point_ids = raw[off : off + point_ids_bytes].view("<u4").copy()
        off += point_ids_bytes

    expected_size = off
    if raw.shape[0] != expected_size:
        raise ValueError(
            f"{path}: size mismatch, file is {raw.shape[0]}B, header implies {expected_size}B"
        )

    return ChunkMeta(
        chunk_id=int(header["chunk_id"]),
        voxel_grid_n=int(header["voxel_grid_n"]),
        atlas_tile_px=int(header["atlas_tile_px"]),
        voxel_records=voxel_records,
        point_ids=point_ids,
    )
