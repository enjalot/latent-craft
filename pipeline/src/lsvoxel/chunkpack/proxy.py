"""proxy.bin — whole-dataset, dense over ALL chunk slots including empty ones, so it
represents the full volume silhouette. Always-resident on the client; rendered
everywhere so teleporting/flying never shows a blank cube while real chunks stream in.

Layout:
  Header (16B): magic="LSVP", version=1, chunks_per_axis, reserved(8B)
  ProxyRecord x chunks_per_axis**3 (12B, indexed by chunk_id, row-major x-fastest,
                                    same convention as voxel.chunk_id_of):
    color_rgb:u8[3]  density_log2:u8  n_points:u32  n_occupied_voxels:u16  reserved:u16
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

MAGIC = b"LSVP"
VERSION = 1

PROXY_HEADER_DTYPE = np.dtype(
    [
        ("magic", "S4"),
        ("version", "<u2"),
        ("chunks_per_axis", "<u2"),
        ("reserved", "V8"),
    ]
)
assert PROXY_HEADER_DTYPE.itemsize == 16, PROXY_HEADER_DTYPE.itemsize

PROXY_RECORD_DTYPE = np.dtype(
    [
        ("color_rgb", "u1", (3,)),
        ("density_log2", "u1"),
        ("n_points", "<u4"),
        ("n_occupied_voxels", "<u2"),
        ("reserved", "<u2"),
    ]
)
assert PROXY_RECORD_DTYPE.itemsize == 12, PROXY_RECORD_DTYPE.itemsize


def build_proxy_records(
    chunks_per_axis: int,
    chunk_ids: np.ndarray,
    chunk_color_rgb: np.ndarray,
    chunk_n_points: np.ndarray,
    chunk_n_occupied_voxels: np.ndarray,
) -> np.ndarray:
    """Scatter per-chunk aggregates (indexed by arbitrary chunk_id values, sparse —
    only occupied chunks need be passed in) into the dense chunks_per_axis**3 table.
    Empty chunk slots stay all-zero (color black, density_log2=0, n_points=0)."""
    n_total = chunks_per_axis**3
    recs = np.zeros(n_total, dtype=PROXY_RECORD_DTYPE)
    recs["color_rgb"][chunk_ids] = chunk_color_rgb
    recs["n_points"][chunk_ids] = chunk_n_points
    recs["n_occupied_voxels"][chunk_ids] = chunk_n_occupied_voxels
    with np.errstate(divide="ignore"):
        log2 = np.floor(np.log2(chunk_n_points.astype(np.float64) + 1)).clip(0, 255)
    recs["density_log2"][chunk_ids] = log2.astype(np.uint8)
    return recs


def write_proxy(path: Path, chunks_per_axis: int, records: np.ndarray) -> None:
    if records.dtype != PROXY_RECORD_DTYPE:
        raise ValueError("records must use PROXY_RECORD_DTYPE")
    if len(records) != chunks_per_axis**3:
        raise ValueError(
            f"expected {chunks_per_axis**3} records (chunks_per_axis**3), got {len(records)}"
        )
    header = np.zeros(1, dtype=PROXY_HEADER_DTYPE)
    header["magic"] = MAGIC
    header["version"] = VERSION
    header["chunks_per_axis"] = chunks_per_axis

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.tobytes())
        f.write(records.tobytes())


def read_proxy(path: Path) -> tuple[int, np.ndarray]:
    raw = np.fromfile(path, dtype=np.uint8)
    header = raw[: PROXY_HEADER_DTYPE.itemsize].view(PROXY_HEADER_DTYPE)[0]
    if bytes(header["magic"]) != MAGIC:
        raise ValueError(f"{path}: bad magic {bytes(header['magic'])!r}")
    chunks_per_axis = int(header["chunks_per_axis"])
    records = raw[PROXY_HEADER_DTYPE.itemsize :].view(PROXY_RECORD_DTYPE).copy()
    expected = chunks_per_axis**3
    if len(records) != expected:
        raise ValueError(f"{path}: expected {expected} records, got {len(records)}")
    return chunks_per_axis, records
