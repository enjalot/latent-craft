#!/usr/bin/env python3
"""Full chunk-pack build for BL. Run with the pipeline's own venv (has pandas/pillow/
pyarrow — no umap-learn dependency, that already ran separately).

Usage: .venv/bin/python scripts/run_chunkpack_bl.py [num_voxels] [variant_suffix]

variant_suffix names the output dir chunks/bl<variant_suffix>/ (e.g. "-160") so
multiple num_voxels builds can coexist for comparison, e.g.:
  run_chunkpack_bl.py 160 -160   -> /data/latent-scope-3d/chunks/bl-160/
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from lsvoxel.chunkpack.build import assign_and_build, validate_chunks  # noqa: E402
from lsvoxel.config import (  # noqa: E402
    BL_SUBSETS,
    DATA_ROOT,
    chunks_dir,
    points_table_path,
    umap_run_dir,
)
from lsvoxel.datasets.bl import BLThumbnailSource  # noqa: E402


def main() -> int:
    num_voxels = int(sys.argv[1]) if len(sys.argv) > 1 else 96
    variant_suffix = sys.argv[2] if len(sys.argv) > 2 else ""

    points_path = points_table_path("bl")
    print(f"loading {points_path} ...", flush=True)
    points_df = pd.read_parquet(points_path)

    umap_dir = umap_run_dir("bl")
    coords3d = np.load(umap_dir / "coords3d.npy")
    print(f"loaded points={len(points_df):,} coords3d={coords3d.shape}", flush=True)

    thumb_source = BLThumbnailSource(points_df)
    subsets = {s: i for i, s in enumerate(BL_SUBSETS)}

    out_dir = chunks_dir("bl") if not variant_suffix else DATA_ROOT / "chunks" / f"bl{variant_suffix}"
    print(f"output dir: {out_dir}", flush=True)
    result = assign_and_build(
        dataset_id=f"bl-siglip2-1m{variant_suffix}",
        points_df=points_df,
        coords3d=coords3d,
        num_voxels=num_voxels,
        thumb_source=thumb_source,
        out_dir=out_dir,
        subsets=subsets,
        thumb_url_template="{subset_name}/{local_idx:08d}.webp",
        umap_run="umap-001",
        points_table_path=points_path,
        voxels_per_chunk=16,
    )
    print(f"[run_chunkpack_bl] build result: {result}", flush=True)

    print("[run_chunkpack_bl] validating ...", flush=True)
    v = validate_chunks(out_dir)
    print(f"[run_chunkpack_bl] validate result: {v}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
