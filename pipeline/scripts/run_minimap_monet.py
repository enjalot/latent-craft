#!/usr/bin/env python3
"""Full 2D minimap pack build for one MONET draw arm. Run with the pipeline's own venv.

Same shape as run_minimap_bl.py — `build_minimap_pack` is dataset-agnostic and reads
the points table's `subset` column as its per-corpus density axis. For MONET that's
the image source (laion / coyo / synthetic-* / ...), coded by the frozen
`config.MONET_SOURCES`, so the minimap's per-corpus planes are exactly the
real-vs-synthetic / per-crawl split. 9 sources fits the pack format's 4-bit corpus
field (max 16).

Usage: .venv/bin/python scripts/run_minimap_monet.py <arm>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pandas as pd  # noqa: E402

from lsvoxel.config import (  # noqa: E402
    MONET_ARMS,
    MONET_SOURCES,
    minimap_dir,
    monet_dataset_id,
    points_table_path,
    umap_run_dir,
)
from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: run_minimap_monet.py <arm>   (known arms: {', '.join(MONET_ARMS)})",
              file=sys.stderr)
        return 2
    arm = sys.argv[1]
    dataset_id = monet_dataset_id(arm)

    points_path = points_table_path(dataset_id)
    print(f"loading {points_path} ...", flush=True)
    points_df = pd.read_parquet(points_path)

    coords2d_path = umap_run_dir(dataset_id) / "coords2d.npy"

    out_dir = minimap_dir(dataset_id)
    result = build_minimap_pack(
        dataset_id=dataset_id,
        coords2d_path=coords2d_path,
        points_df=points_df,
        out_dir=out_dir,
        subsets=dict(MONET_SOURCES),
    )
    print(f"[run_minimap_monet] build result: {result}", flush=True)

    print("[run_minimap_monet] validating ...", flush=True)
    v = validate_minimap_pack(out_dir)
    print(f"[run_minimap_monet] validate result: {v}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
