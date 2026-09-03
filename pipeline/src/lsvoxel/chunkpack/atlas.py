"""Per-chunk texture atlas: composite each occupied voxel's representative-point
thumbnail into one 2048x2048/32px-tile sheet, then encode to KTX2/Basis-Universal
(ETC1S, opaque RGB, no alpha — see the plan's open decisions #3/#4).

Atlas layout: local_voxel_id doubles as the tile index directly (16^3 == 64^2 == 4096
for the fixed 16-voxel chunk edge), so tile (col, row) = (local_voxel_id % tiles_per_side,
local_voxel_id // tiles_per_side) — no separate tile-index field is stored anywhere.
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


def build_chunk_atlas_png(
    occupied_local_ids: np.ndarray,
    representative_row_ids: np.ndarray,
    thumb_source: ThumbnailSource,
    tile_px: int = 32,
    atlas_px: int = 2048,
) -> Image.Image:
    """occupied_local_ids and representative_row_ids are parallel arrays (same length,
    one entry per occupied voxel in this chunk)."""
    if len(occupied_local_ids) != len(representative_row_ids):
        raise ValueError("occupied_local_ids and representative_row_ids must be parallel")

    tiles_per_side = atlas_px // tile_px
    if tiles_per_side * tiles_per_side * (tile_px * tile_px) != atlas_px * atlas_px:
        raise ValueError(f"atlas_px={atlas_px} must be an exact multiple of tile_px={tile_px}")

    atlas = Image.new("RGB", (atlas_px, atlas_px), BACKGROUND_RGB)
    for local_id, row_id in zip(occupied_local_ids.tolist(), representative_row_ids.tolist()):
        col = local_id % tiles_per_side
        row = local_id // tiles_per_side
        raw = thumb_source.open(row_id)
        tile = _square_crop_resize(raw, tile_px)
        atlas.paste(tile, (col * tile_px, row * tile_px))
    return atlas


def mean_tile_color(atlas: Image.Image, local_id: int, tile_px: int, tiles_per_side: int) -> tuple[int, int, int]:
    col = local_id % tiles_per_side
    row = local_id // tiles_per_side
    box = (col * tile_px, row * tile_px, (col + 1) * tile_px, (row + 1) * tile_px)
    tile = np.asarray(atlas.crop(box), dtype=np.float64)
    mean = tile.reshape(-1, 3).mean(axis=0)
    return tuple(int(round(v)) for v in mean)


def encode_ktx2(png_path: Path, out_path: Path, basisu_bin: str = "basisu") -> None:
    """ETC1S (basisu's default compression mode), with mipmaps. Requires the basisu
    CLI to be built/installed (see the plan's Phase 0 gate) — raises clearly if not."""
    resolved = shutil.which(basisu_bin) or (basisu_bin if Path(basisu_bin).exists() else None)
    if resolved is None:
        raise FileNotFoundError(
            f"basisu binary not found ({basisu_bin!r}) — build it per the plan's Phase 0 "
            "gate (github.com/BinomialLLC/basis_universal) before running atlas encoding"
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [resolved, "-ktx2", "-mipmap", str(png_path), "-output_file", str(out_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not out_path.exists():
        raise RuntimeError(
            f"basisu failed (rc={result.returncode}) for {png_path}:\n"
            f"stdout: {result.stdout[-2000:]}\nstderr: {result.stderr[-2000:]}"
        )
