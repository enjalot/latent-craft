"""Voxel-index conventions for the 3D UMAP explorer.

``make_voxels`` is ported byte-identical from latent-scope's
``origin/feature/3d`` branch (``latentscope/scripts/scope.py::make_voxels``,
frozen convention, lock-in tested there at commit ``956d567``). Do not
"improve" or re-derive it — any change here breaks voxel<->minecraft<->city
alignment per that repo's own ARCHITECTURE.md §2.4.

``voxel_bins``, ``chunk_id_of``, and ``local_voxel_id`` are new additions
needed for chunk-pack assembly (grouping the voxel grid into
``voxels_per_chunk``-sized chunks for streaming). They are not ported from
anywhere, but they keep the same row-major, x-fastest indexing convention one
level up (chunk grid) and one level down (local slot within a chunk).
"""
from __future__ import annotations

import numpy as np


def make_voxels(x, y, z, num_voxels=32):
    """Map normalized [-1, 1] x/y/z coords to a flat 3D voxel index.

    FROZEN cell-index convention. Row-major with x fastest, cubic grid:
        bin(c, n) = clip(floor((c + 1) / 2 * n), 0, n - 1)
        idx       = (z_bin * n + y_bin) * n + x_bin
    """
    def _bin(c, n):
        b = np.floor((c + 1) / 2 * n).astype(int)
        return np.clip(b, 0, n - 1)

    x_bin = _bin(x, num_voxels)
    y_bin = _bin(y, num_voxels)
    z_bin = _bin(z, num_voxels)
    return (z_bin * num_voxels + y_bin) * num_voxels + x_bin


def voxel_bins(x, y, z, num_voxels) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-axis bin indices (0..num_voxels-1) for normalized [-1, 1] x/y/z coords.

    Exposes the ``x_bin``/``y_bin``/``z_bin`` that ``make_voxels`` computes
    internally (same ``bin(c, n) = clip(floor((c + 1) / 2 * n), 0, n - 1)``
    formula), since chunk assignment needs the per-axis bins separately rather
    than the flattened voxel index that ``make_voxels`` returns.
    """
    def _bin(c, n):
        b = np.floor((np.asarray(c, dtype=np.float64) + 1) / 2 * n).astype(int)
        return np.clip(b, 0, n - 1)

    x_bin = _bin(x, num_voxels)
    y_bin = _bin(y, num_voxels)
    z_bin = _bin(z, num_voxels)
    return x_bin, y_bin, z_bin


def chunk_id_of(vx, vy, vz, num_voxels, voxels_per_chunk=16) -> np.ndarray:
    """Flat chunk index for per-axis voxel bins (as returned by ``voxel_bins``).

    Groups the ``num_voxels**3`` voxel grid into ``voxels_per_chunk**3``-voxel
    chunks::

        cx, cy, cz = vx // voxels_per_chunk, vy // ..., vz // ...
        G          = num_voxels // voxels_per_chunk   (chunks per axis)
        chunk_id   = (cz * G + cy) * G + cx

    Same row-major, x-fastest convention as ``make_voxels``, one level up the
    hierarchy (chunk grid instead of voxel grid). ``num_voxels`` must be evenly
    divisible by ``voxels_per_chunk``.
    """
    if num_voxels % voxels_per_chunk != 0:
        raise ValueError(
            f"num_voxels ({num_voxels}) must be divisible by voxels_per_chunk "
            f"({voxels_per_chunk})"
        )
    g = num_voxels // voxels_per_chunk
    cx = np.asarray(vx) // voxels_per_chunk
    cy = np.asarray(vy) // voxels_per_chunk
    cz = np.asarray(vz) // voxels_per_chunk
    return (cz * g + cy) * g + cx


def local_voxel_id(vx, vy, vz, voxels_per_chunk=16) -> np.ndarray:
    """Flat local-slot index (0..voxels_per_chunk**3 - 1) within a chunk.

    ::

        lx, ly, lz = vx % voxels_per_chunk, vy % ..., vz % ...
        local_id   = (lz * voxels_per_chunk + ly) * voxels_per_chunk + lx

    Same row-major, x-fastest convention as ``make_voxels``/``chunk_id_of``,
    one level down (position within the chunk rather than the chunk itself).

    This value doubles as the atlas tile index: with the default
    ``voxels_per_chunk=16``, ``16**3 == 64**2 == 4096``, so
    ``(tile_x, tile_y) = (local_id % 64, local_id // 64)`` in a 64x64-tile
    atlas — that reshaping into 2D tile coordinates happens in the
    atlas-building module, not here; this function only needs to produce the
    correct flat 0..4095 slot.
    """
    lx = np.asarray(vx) % voxels_per_chunk
    ly = np.asarray(vy) % voxels_per_chunk
    lz = np.asarray(vz) % voxels_per_chunk
    return (lz * voxels_per_chunk + ly) * voxels_per_chunk + lx
