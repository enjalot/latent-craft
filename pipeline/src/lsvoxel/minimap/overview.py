"""Fixed 512² one-pixel-per-bin overview; all points contribute, no point sprites.

Only five combined PNGs (z0/z1) and tiny indexes are published. Counting uses a
1 MiB u32 grid plus bounded row batches, independent of the corpus size.
"""
import json
from pathlib import Path

import numpy as np

from . import _vendored_map_pack_core as core


def overview_counts(qx, qy, batch_rows=1_000_000):
    if len(qx) != len(qy) or len(qx) >= 2**32 or batch_rows < 1:
        raise ValueError("Invalid overview row count or batch size")
    counts = np.zeros(512 * 512, dtype=np.uint32)
    for start in range(0, len(qx), batch_rows):
        x = np.asarray(qx[start:start+batch_rows], dtype=np.uint32) >> 7
        y = np.asarray(qy[start:start+batch_rows], dtype=np.uint32) >> 7
        counts += np.bincount(y * 512 + x, minlength=512 * 512).astype(np.uint32)
    return counts.reshape(512, 512)


def build_overview_density(out_dir: Path, qx, qy):
    return render_overview_density(out_dir, overview_counts(qx, qy))


def render_overview_density(out_dir: Path, counts):
    if counts.shape != (512, 512) or counts.dtype != np.uint32:
        raise ValueError("Expected a 512x512 u32 count grid")
    levels = []
    for z in [1, 0]:
        directory = out_dir / "density" / f"z{z}"
        directory.mkdir(parents=True, exist_ok=True)
        peak = float(np.log1p(counts.max()))
        tiles = {}
        for y in range(1 << z):
            for x in range(1 << z):
                tile = counts[y*256:(y+1)*256, x*256:(x+1)*256]
                n = int(tile.sum(dtype=np.uint64))
                if not n:
                    continue
                core.render_png(tile, directory / f"{x}_{y}.png", peak)
                tiles[f"{x}_{y}"] = {"n": n, "corpora": []}
        (directory / "index.json").write_text(json.dumps(dict(z=z, tiles_per_side=1 << z,
            bin_bytes=0, png_log_peak=peak, tiles=tiles, encoding="combined-png-only")))
        levels.append(dict(z=z, tiles_per_side=1 << z, bins_per_side=256 << z,
            tiles_written=len(tiles), planes_written=0, png_log_peak=peak,
            total_count=int(counts.sum(dtype=np.uint64))))
        if z:
            counts = counts.reshape(256, 2, 256, 2).sum(axis=(1, 3), dtype=np.uint32)
    return {"levels": list(reversed(levels))}
