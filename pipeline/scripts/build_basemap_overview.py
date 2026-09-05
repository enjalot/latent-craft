#!/usr/bin/env python3
"""Prove the compact heatmap against every projected row, without thumbnail dependencies.

Produces a preview, not a playable dataset or a replacement for the ranged spatial
index. Frame estimation uses a bounded deterministic sample; bin counts use ALL rows.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
from lsvoxel.minimap import _vendored_map_pack_core as core
from lsvoxel.minimap.overview import overview_counts, render_overview_density


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("coordinates",type=Path);parser.add_argument("output",type=Path)
    args=parser.parse_args()
    if args.output.exists(): parser.error("Use a fresh output directory")
    coords=np.load(args.coordinates,mmap_mode="r")
    if coords.ndim != 2 or coords.shape[1] != 2 or not 0 < len(coords) < 2**32:
        parser.error("Expected nonempty N x 2 coordinates with N < 2^32")
    started=time.monotonic()
    frame=core.compute_frame(coords,sample_rows=1_000_000)
    counts=np.zeros((512,512),dtype=np.uint32)
    for start in range(0,len(coords),1_000_000):
        batch=coords[start:start+1_000_000]
        if not np.isfinite(batch).all(): raise ValueError(f"Nonfinite coordinates near row {start}")
        qx,qy=core.quantize(batch,frame["extent"])
        counts += overview_counts(qx,qy)
    if int(counts.sum(dtype=np.uint64)) != len(coords): raise ValueError("Count conservation failed")
    args.output.mkdir(parents=True)
    density=render_overview_density(args.output,counts)
    core.render_png(counts,args.output / "overview.png",float(np.log1p(counts.max())))
    with args.coordinates.open("rb") as stream: digest=hashlib.file_digest(stream,"sha256").hexdigest()
    stats=dict(coordinates=str(args.coordinates),sha256=digest,points=len(coords),frame=frame,
        bins=512**2,count_grid_bytes=counts.nbytes,rgba_canvas_bytes=512**2*4,
        occupied_bins=int(np.count_nonzero(counts)),max_bin_count=int(counts.max()),
        density_bytes=sum(p.stat().st_size for p in (args.output / "density").rglob("*") if p.is_file()),
        z1_png_bytes=sum(p.stat().st_size for p in (args.output / "density/z1").glob("*.png")),
        levels=density["levels"],wall_seconds=round(time.monotonic()-started,2))
    (args.output / "receipt.json").write_text(json.dumps(stats,indent=2))
    print(json.dumps(stats,indent=2))


if __name__ == "__main__": main()
