"""3D frame-fitting for the voxel explorer: percentile-trimmed extent + cubify.

Generalizes ``~/code/latent-basemap/experiments/mappack/map_pack.py``'s
``robust_extent``/``squarify``/``compute_frame`` (2D tile-pack frame logic)
from 2 axes to 3. This is a deliberate departure from latent-scope's own
exact-min/max normalization convention: a single outlier point should not be
able to collapse the rest of a UMAP embedding into a corner of voxel space, so
coordinates are trimmed to a percentile window per axis, padded a little, then
the two shorter axes are grown so the frame is a cube (equal spans on all
three axes) before being handed to ``normalize_to_cube`` and, downstream,
``voxel.make_voxels``.
"""
from __future__ import annotations

import numpy as np


def robust_extent_3d(
    coords: np.ndarray,
    extent_pct: tuple[float, float] = (0.1, 99.9),
    pad_frac: float = 0.02,
) -> list[float]:
    """[x0, x1, y0, y1, z0, z1] — per-axis percentile + pad.

    # generalized from map_pack.py's robust_extent/squarify, see that file for the 2D original
    ``coords`` is (N, 3).
    """
    coords = np.asarray(coords)
    lo, hi = extent_pct
    extent: list[float] = []
    for axis in range(3):
        a0, a1 = np.percentile(coords[:, axis], [lo, hi])
        pad = pad_frac * (a1 - a0) or 1.0
        extent.extend([float(a0 - pad), float(a1 + pad)])
    return extent


def cubify(extent: list[float]) -> list[float]:
    """Grow the two shorter axes about their center so all three spans are equal.

    # generalized from map_pack.py's robust_extent/squarify, see that file for the 2D original
    Takes/returns [x0, x1, y0, y1, z0, z1].
    """
    x0, x1, y0, y1, z0, z1 = extent
    spans = (x1 - x0, y1 - y0, z1 - z0)
    side = max(spans)
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    return [
        cx - side / 2, cx + side / 2,
        cy - side / 2, cy + side / 2,
        cz - side / 2, cz + side / 2,
    ]


def compute_frame_3d(
    coords: np.ndarray,
    extent_pct: tuple[float, float] = (0.1, 99.9),
    pad_frac: float = 0.02,
) -> dict:
    """``robust_extent_3d`` -> ``cubify``, mirroring map_pack.py's ``compute_frame``.

    # generalized from map_pack.py's robust_extent/squarify, see that file for the 2D original
    Returns a dict shaped to drop straight into a manifest.json's
    ``"world.frame"`` field.
    """
    raw = robust_extent_3d(coords, extent_pct=extent_pct, pad_frac=pad_frac)
    return {
        "extent": cubify(raw),
        "raw_extent": raw,
        "method": "robust_percentile_cubify",
        "extent_pct": list(extent_pct),
        "pad_frac": pad_frac,
    }


def normalize_to_cube(coords: np.ndarray, extent: list[float]) -> np.ndarray:
    """Per-axis affine map of ``extent`` -> [-1, 1]^3.

    Since ``extent`` is already cubic (equal spans on all 3 axes after
    ``cubify()``), this preserves aspect ratio. Does NOT clip out-of-range
    points — ``make_voxels``' own ``_bin()`` clips at the index step, clipping
    twice would be redundant/confusing.
    """
    coords = np.asarray(coords, dtype=np.float64)
    x0, x1, y0, y1, z0, z1 = extent
    lo = np.array([x0, y0, z0], dtype=np.float64)
    hi = np.array([x1, y1, z1], dtype=np.float64)
    return (coords - lo) / (hi - lo) * 2.0 - 1.0
