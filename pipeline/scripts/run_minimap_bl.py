#!/usr/bin/env python3
"""Full minimap pack build for BL. Run with the pipeline's own venv.

Usage: .venv/bin/python scripts/run_minimap_bl.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pandas as pd  # noqa: E402

from lsvoxel.config import BL_SUBSETS, minimap_dir, points_table_path, umap_run_dir  # noqa: E402
from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack  # noqa: E402


def main() -> int:
    points_path = points_table_path("bl")
    print(f"loading {points_path} ...", flush=True)
    points_df = pd.read_parquet(points_path)

    coords2d_path = umap_run_dir("bl") / "coords2d.npy"
    subsets = {s: i for i, s in enumerate(BL_SUBSETS)}

    out_dir = minimap_dir("bl")
    result = build_minimap_pack(
        dataset_id="bl-siglip2-1m",
        coords2d_path=coords2d_path,
        points_df=points_df,
        out_dir=out_dir,
        subsets=subsets,
    )
    print(f"[run_minimap_bl] build result: {result}", flush=True)

    print("[run_minimap_bl] validating ...", flush=True)
    v = validate_minimap_pack(out_dir)
    print(f"[run_minimap_bl] validate result: {v}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
