#!/usr/bin/env python3
"""Full-scale BL UMAP fit. Run with umap06dev-env's python (has umap-learn; the
lsvoxel venv deliberately doesn't depend on umap-learn, so this script reaches into
lsvoxel's src/ via sys.path rather than requiring an install into umap06dev-env --
that env belongs to the separate basemap research program, kept untouched.

Usage: /data/latent-basemap/umap06dev-env/bin/python run_umap_bl.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lsvoxel.config import BL_SUBSTRATE, umap_run_dir  # noqa: E402
from lsvoxel.umap_fit import fit_umap_cpu, load_writable  # noqa: E402


def main() -> int:
    print(f"loading {BL_SUBSTRATE} ...", flush=True)
    X = load_writable(BL_SUBSTRATE)
    print(f"loaded {X.shape} {X.dtype}", flush=True)
    out_dir = umap_run_dir("bl")
    fit_umap_cpu(X, out_dir, source_path=str(BL_SUBSTRATE))
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
