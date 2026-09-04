"""voxel_proxy.bin — whole-dataset, one record per OCCUPIED voxel: the count and mean
thumbnail color every chunk's meta.bin already carries per VoxelRecord, lifted into
one small always-resident file.

proxy.bin (one record per chunk slot) gives the volume's silhouette; this gives its
shape at voxel resolution, so the client can draw every voxel of a chunk that is NOT
loaded as a flat mean-colored block (Minecraft's "distant chunks are approximated")
and stream textured chunks only in a tight ring around the camera. The per-voxel
color/count inside meta.bin is exactly what a non-resident chunk hasn't fetched,
hence the copy. Size: 12 B per occupied voxel (bl-160: 14,688 voxels -> ~172 KiB).

Layout (little-endian):
  Header (16B, same size as proxy.bin's):
    magic="LSVV" @0  version=1:u16 @4  reserved:u16 @6  n_voxels:u32 @8
    num_voxels:u16 @12 (world grid, e.g. 160)  voxels_per_chunk:u16 @14 (16)
  VoxelProxyRecord x n_voxels (12B each):
    chunk_id:u32  local_voxel_id:u16  count:u16  color_rgb:u8[3]  flags:u8
  count / color_rgb / flags are byte-for-byte the chunk's VoxelRecord fields. Pack
  construction rejects a count above 65535 rather than silently saturating it.

Records are sorted by (chunk_id, local_voxel_id) ascending — the same order as each
chunk's occupied list (count > 0, local_voxel_id ascending, which is what the
frontend's ChunkLoader builds its instances from) — so a chunk's records are one
contiguous run and the i-th record of that run is instance i of that chunk's mesh.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

MAGIC = b"LSVV"
VERSION = 1

VOXEL_PROXY_HEADER_DTYPE = np.dtype(
    [
        ("magic", "S4"),
        ("version", "<u2"),
        ("reserved", "<u2"),
        ("n_voxels", "<u4"),
        ("num_voxels", "<u2"),
        ("voxels_per_chunk", "<u2"),
    ]
)
assert VOXEL_PROXY_HEADER_DTYPE.itemsize == 16, VOXEL_PROXY_HEADER_DTYPE.itemsize

VOXEL_PROXY_RECORD_DTYPE = np.dtype(
    [
        ("chunk_id", "<u4"),
        ("local_voxel_id", "<u2"),
        ("count", "<u2"),
        ("color_rgb", "u1", (3,)),
        ("flags", "u1"),
    ]
)
assert VOXEL_PROXY_RECORD_DTYPE.itemsize == 12, VOXEL_PROXY_RECORD_DTYPE.itemsize
WIDE_PROXY_DTYPE = np.dtype([
    ('chunk_id', '<u4'), ('local_voxel_id', '<u2'), ('count', '<u4'),
    ('color_rgb', 'u1', (3,)), ('flags', 'u1'),
])


@dataclass
class VoxelProxy:
    num_voxels: int
    voxels_per_chunk: int
    records: np.ndarray  # structured array, dtype=VOXEL_PROXY_RECORD_DTYPE

    @property
    def n_voxels(self) -> int:
        return len(self.records)


def records_for_chunk(chunk_id: int, voxel_records: np.ndarray) -> np.ndarray:
    """One chunk's occupied VoxelRecords (metablob.VOXEL_RECORD_DTYPE, index ==
    local_voxel_id) as proxy records, local_voxel_id ascending — exactly the chunk's
    occupied list. Both a fresh build and a derive-from-existing-pack go through
    this, so the two paths cannot disagree about what a record holds."""
    occupied = np.flatnonzero(voxel_records["count"] > 0)
    wide = voxel_records.dtype['count'].itemsize == 4
    recs = np.zeros(len(occupied), dtype=WIDE_PROXY_DTYPE if wide else VOXEL_PROXY_RECORD_DTYPE)
    recs["chunk_id"] = chunk_id
    recs["local_voxel_id"] = occupied
    recs["count"] = voxel_records["count"][occupied]
    recs["color_rgb"] = voxel_records["color_rgb"][occupied]
    recs["flags"] = voxel_records["flags"][occupied]
    return recs


def build_voxel_proxy_records(per_chunk: list[np.ndarray]) -> np.ndarray:
    """Concatenate per-chunk runs (given in any chunk order) into the canonical
    (chunk_id, local_voxel_id)-sorted table."""
    if not per_chunk:
        return np.zeros(0, dtype=VOXEL_PROXY_RECORD_DTYPE)
    recs = np.concatenate(per_chunk)
    if recs.dtype not in (VOXEL_PROXY_RECORD_DTYPE, WIDE_PROXY_DTYPE):
        raise ValueError("per-chunk runs must use VOXEL_PROXY_RECORD_DTYPE")
    order = np.lexsort((recs["local_voxel_id"], recs["chunk_id"]))
    return recs[order]


def check_canonical_order(records: np.ndarray) -> None:
    """Raise unless records are strictly ascending by (chunk_id, local_voxel_id) —
    sorted AND free of duplicate voxels. The composite key fits int64 since
    local_voxel_id < 2**16."""
    key = records["chunk_id"].astype(np.int64) * (1 << 16) + records["local_voxel_id"]
    if len(key) > 1 and not (np.diff(key) > 0).all():
        raise ValueError(
            "records must be sorted by (chunk_id, local_voxel_id) ascending with no duplicates"
        )


def write_voxel_proxy(
    path: Path, num_voxels: int, voxels_per_chunk: int, records: np.ndarray
) -> None:
    if records.dtype not in (VOXEL_PROXY_RECORD_DTYPE, WIDE_PROXY_DTYPE):
        raise ValueError("records must use VOXEL_PROXY_RECORD_DTYPE")
    if voxels_per_chunk <= 0 or num_voxels % voxels_per_chunk != 0:
        raise ValueError(
            f"num_voxels ({num_voxels}) must be divisible by voxels_per_chunk ({voxels_per_chunk})"
        )
    check_canonical_order(records)
    if len(records):
        n_chunk_slots = (num_voxels // voxels_per_chunk) ** 3
        if int(records["chunk_id"].max()) >= n_chunk_slots:
            raise ValueError(f"chunk_id out of range for a {num_voxels}^3 world")
        if int(records["local_voxel_id"].max()) >= voxels_per_chunk**3:
            raise ValueError(f"local_voxel_id out of range for {voxels_per_chunk}^3 voxels per chunk")

    header = np.zeros(1, dtype=VOXEL_PROXY_HEADER_DTYPE)
    header["magic"] = MAGIC
    header["version"] = 2 if records.dtype == WIDE_PROXY_DTYPE else VERSION
    header["n_voxels"] = len(records)
    header["num_voxels"] = num_voxels
    header["voxels_per_chunk"] = voxels_per_chunk

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.tobytes())
        f.write(records.tobytes())


def read_voxel_proxy_header(path: Path) -> tuple[int, int, int]:
    """(num_voxels, voxels_per_chunk, n_voxels) from the 16-byte header alone —
    enough to size buffers or fill a manifest entry without reading the records."""
    header = np.fromfile(path, dtype=VOXEL_PROXY_HEADER_DTYPE, count=1)
    if len(header) != 1:
        raise ValueError(f"{path}: truncated header")
    h = header[0]
    if bytes(h["magic"]) != MAGIC:
        raise ValueError(f"{path}: bad magic {bytes(h['magic'])!r}")
    if int(h["version"]) not in (VERSION, 2):
        raise ValueError(f"{path}: unsupported version {h['version']}")
    return int(h["num_voxels"]), int(h["voxels_per_chunk"]), int(h["n_voxels"])


def read_voxel_proxy(path: Path) -> VoxelProxy:
    num_voxels, voxels_per_chunk, n_voxels = read_voxel_proxy_header(path)
    raw = np.fromfile(path, dtype=np.uint8)
    dtype = WIDE_PROXY_DTYPE if int(raw[:16].view(VOXEL_PROXY_HEADER_DTYPE)[0]['version']) == 2 else VOXEL_PROXY_RECORD_DTYPE
    expected_size = VOXEL_PROXY_HEADER_DTYPE.itemsize + n_voxels * dtype.itemsize
    if raw.shape[0] != expected_size:
        raise ValueError(
            f"{path}: size mismatch, file is {raw.shape[0]}B, header implies {expected_size}B"
        )
    records = raw[VOXEL_PROXY_HEADER_DTYPE.itemsize :].view(dtype).copy()
    check_canonical_order(records)
    return VoxelProxy(num_voxels=num_voxels, voxels_per_chunk=voxels_per_chunk, records=records)
