#!/usr/bin/env python3
"""Full-scale MONET UMAP fit, one draw arm at a time. Run with umap06dev-env's python
(has umap-learn; the lsvoxel venv deliberately doesn't depend on umap-learn, so this
script reaches into lsvoxel's src/ via sys.path rather than requiring an install into
umap06dev-env -- that env belongs to the separate basemap research program, kept
untouched. Same shape as run_umap_bl.py.

Input is the research project's already-assembled per-arm CLIP-512 substrate,
`/data2/monet/draws/{arm}-clip.f32.npy` (2,000,000 x 512 float32) — read-only, and
row-aligned with the arm's points table by construction (points-table row_id ==
substrate row == pool row idx[row_id]; see lsvoxel/datasets/monet.py).

Output: umap/monet-{arm}/umap-001/{coords2d.npy, coords3d.npy, meta.json}.

Cost note: 2M x 512 is 4 GB in RAM (the writable copy below) and a multi-hour CPU
fit — it is CPU-only by design and should not be started while the machine's cores
are already saturated by another job.

Usage: /data/latent-basemap/umap06dev-env/bin/python run_umap_monet.py <arm>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lsvoxel.config import (  # noqa: E402
    MONET_ARMS,
    monet_dataset_id,
    monet_draw_clip_path,
    umap_run_dir,
)
from lsvoxel.umap_fit import fit_umap_cpu, load_writable  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: run_umap_monet.py <arm>   (known arms: {', '.join(MONET_ARMS)})",
              file=sys.stderr)
        return 2
    arm = sys.argv[1]

    clip_path = monet_draw_clip_path(arm)
    if not clip_path.exists():
        print(f"{clip_path} missing — arm {arm!r} hasn't been assembled yet", file=sys.stderr)
        return 1

    print(f"loading {clip_path} ...", flush=True)
    # Writable float32 copy, not a memmap: a read-only memmap makes pynndescent's numba
    # signatures reject the array (documented gotcha, see lsvoxel.umap_fit.load_writable).
    X = load_writable(clip_path)
    print(f"loaded {X.shape} {X.dtype}", flush=True)

    out_dir = umap_run_dir(monet_dataset_id(arm))
    fit_umap_cpu(X, out_dir, source_path=str(clip_path))
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
