"""Per-chunk KTX2 atlases.

Legacy packs use a fixed 2048x2048 sheet where ``local_voxel_id`` is the tile index.
New packs store occupied voxels densely, in ascending local-id order, in the smallest
power-of-two square that fits them. The frontend already constructs instances in that
same order, so no extra mapping field is needed in ``meta.bin``.
"""
from __future__ import annotations

import io
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

from ..datasets.base import ThumbnailSource

BACKGROUND_RGB = (16, 16, 24)  # sentinel fill for empty tiles; VoxelRecord.count==0
                                 # is authoritative for "no real tile here", the shader
                                 # never needs to sample alpha to detect this


def _square_crop_resize(raw_bytes: bytes, tile_px: int) -> Image.Image:
    """Center-crop to the shorter side, then resize to (tile_px, tile_px) — the plan's
    recommended default over letterbox/stretch, since letterbox bars would be very
    visible at 32px."""
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im.resize((tile_px, tile_px), Image.LANCZOS)


def _build_atlas_png(
    occupied_local_ids: np.ndarray,
    representative_row_ids: np.ndarray,
    thumb_source: ThumbnailSource,
    tile_indices: np.ndarray,
    tile_px: int,
    tiles_per_side: int,
) -> tuple[Image.Image, int]:
    """Shared compositor. ``tile_indices`` chooses where each parallel row lands.

    Returns ``(atlas, n_blank)``. A ``ThumbnailSource`` may return empty bytes
    for a point whose image isn't available — MONET's packed store does that for a
    shard that hasn't been pulled yet and for a row whose source image failed to
    decode (BL's never does; its thumbnails are always present). Those tiles are
    SKIPPED, keeping the atlas background color, and counted: a build against a
    partially-populated thumbnail store should report how many voxels came out blank,
    not silently look successful. Everything else about the chunk (voxel records,
    point ids, mean tile color) stays correct, so such a pack is usable and can be
    rebuilt once the store completes.
    """
    if not (len(occupied_local_ids) == len(representative_row_ids) == len(tile_indices)):
        raise ValueError("local ids, representative ids, and tile indices must be parallel")
    if tiles_per_side <= 0 or tile_px <= 0:
        raise ValueError("tiles_per_side and tile_px must be positive")
    if len(tile_indices) and int(tile_indices.max()) >= tiles_per_side**2:
        raise ValueError("tile index does not fit in atlas")

    atlas_px = tiles_per_side * tile_px
    atlas = Image.new("RGB", (atlas_px, atlas_px), BACKGROUND_RGB)
    n_blank = 0
    for row_id, tile_index in zip(representative_row_ids.tolist(), tile_indices.tolist()):
        raw = thumb_source.open(row_id)
        if not raw:
            n_blank += 1
            continue
        col = tile_index % tiles_per_side
        row = tile_index // tiles_per_side
        tile = _square_crop_resize(raw, tile_px)
        atlas.paste(tile, (col * tile_px, row * tile_px))
    return atlas, n_blank


def build_chunk_atlas_png(
    occupied_local_ids: np.ndarray,
    representative_row_ids: np.ndarray,
    thumb_source: ThumbnailSource,
    tile_px: int = 32,
    atlas_px: int = 2048,
) -> tuple[Image.Image, int]:
    """Build the legacy dense-local-id layout (kept for compatibility/tests)."""
    if atlas_px % tile_px:
        raise ValueError(f"atlas_px={atlas_px} must be an exact multiple of tile_px={tile_px}")
    return _build_atlas_png(
        occupied_local_ids,
        representative_row_ids,
        thumb_source,
        occupied_local_ids,
        tile_px,
        atlas_px // tile_px,
    )


def compact_tiles_per_side(n_tiles: int, max_tiles_per_side: int) -> int:
    """Smallest power-of-two square side that fits ``n_tiles``."""
    if n_tiles <= 0:
        raise ValueError("a chunk atlas must contain at least one occupied voxel")
    needed = int(np.ceil(np.sqrt(n_tiles)))
    side = 1 << (needed - 1).bit_length()
    if side > max_tiles_per_side:
        raise ValueError(f"{n_tiles} tiles do not fit in {max_tiles_per_side}x{max_tiles_per_side}")
    return side


def build_compact_chunk_atlas_png(
    occupied_local_ids: np.ndarray,
    representative_row_ids: np.ndarray,
    thumb_source: ThumbnailSource,
    tile_px: int = 32,
    max_atlas_px: int = 2048,
) -> tuple[Image.Image, int, int]:
    """Build an occupied-order atlas and return ``(image, n_blank, tiles_side)``."""
    if max_atlas_px % tile_px:
        raise ValueError(
            f"max_atlas_px={max_atlas_px} must be an exact multiple of tile_px={tile_px}"
        )
    tiles_per_side = compact_tiles_per_side(len(occupied_local_ids), max_atlas_px // tile_px)
    image, n_blank = _build_atlas_png(
        occupied_local_ids,
        representative_row_ids,
        thumb_source,
        np.arange(len(occupied_local_ids), dtype=np.int64),
        tile_px,
        tiles_per_side,
    )
    return image, n_blank, tiles_per_side


def mean_tile_color(atlas: Image.Image, tile_index: int, tile_px: int, tiles_per_side: int) -> tuple[int, int, int]:
    col = tile_index % tiles_per_side
    row = tile_index // tiles_per_side
    box = (col * tile_px, row * tile_px, (col + 1) * tile_px, (row + 1) * tile_px)
    tile = np.asarray(atlas.crop(box), dtype=np.float64)
    mean = tile.reshape(-1, 3).mean(axis=0)
    return tuple(int(round(v)) for v in mean)


def encode_ktx2(png_path: Path, out_path: Path, basisu_bin: str = "basisu") -> None:
    """Encode one opaque, level-0 ETC1S texture. Atlas mips cross tile boundaries,
    are never sampled by the frontend, and used to add 33% to decoded storage."""
    resolved = shutil.which(basisu_bin) or (basisu_bin if Path(basisu_bin).exists() else None)
    if resolved is None:
        raise FileNotFoundError(
            f"basisu binary not found ({basisu_bin!r}) — build it per the plan's Phase 0 "
            "gate (github.com/BinomialLLC/basis_universal) before running atlas encoding"
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [resolved, "-ktx2", str(png_path), "-output_file", str(out_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not out_path.exists():
        raise RuntimeError(
            f"basisu failed (rc={result.returncode}) for {png_path}:\n"
            f"stdout: {result.stdout[-2000:]}\nstderr: {result.stderr[-2000:]}"
        )
