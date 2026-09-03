#!/usr/bin/env python3
"""Phase 0 smoke test for lsvoxel's UMAP fit step.

Runs on /data/latent-basemap/umap06dev-env's python (the "0.6dev" umap-learn clone),
CPU only. Two things to establish before committing to the full 1,080,814-row x 1152-dim
BL fit:

  1. Wall-clock at this dimensionality. The only proven CPU timing on this machine is
     upstream_2m_run.py's 2M-row x 384-dim MiniLM fit; BL is 1152-dim (3x), so timing
     needs a fresh empirical read, not an assumption.
  2. Same-seed determinism: that two separate umap.UMAP(random_state=42).fit_transform()
     calls (n_components=2 and n_components=3) on the SAME input produce the SAME KNN
     graph internally (verified indirectly: nearest-neighbor membership of a probe point
     should match between the two fits, since UMAP exposes the fitted graph).

Usage: /data/latent-basemap/umap06dev-env/bin/python smoke_umap06dev.py [N_SUBSAMPLE]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

SUBSTRATE = Path("/data/latent-basemap/substrates/bl-siglip2-1m/substrate.f16.npy")
OUT = Path("/data/latent-scope-3d/umap/bl/smoke-test")


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50_000
    seed = 42
    OUT.mkdir(parents=True, exist_ok=True)

    print(f"loading {n:,} rows from {SUBSTRATE} ...", flush=True)
    full = np.load(SUBSTRATE, mmap_mode="r")
    rng = np.random.default_rng(seed)
    idx = np.sort(rng.choice(full.shape[0], size=n, replace=False))
    # writable f32 copy — a read-only memmap makes pynndescent's numba signatures
    # reject it (documented gotcha, same as upstream_2m_run.py's own comment)
    X = np.array(full[idx], dtype=np.float32)
    print(f"subsample shape={X.shape} dtype={X.dtype}", flush=True)

    import umap
    print(f"umap-learn {umap.__version__} (0.6dev clone, HEAD 67ca365)", flush=True)

    results = {}
    for n_components in (2, 3):
        t0 = time.time()
        reducer = umap.UMAP(
            n_neighbors=25,
            min_dist=0.0,
            n_components=n_components,
            metric="cosine",
            random_state=seed,
            verbose=True,
        )
        coords = reducer.fit_transform(X)
        wall = time.time() - t0
        np.save(OUT / f"coords{n_components}d.npy", coords.astype(np.float32))
        # graph_ is the fuzzy simplicial set (sparse CSR) UMAP builds internally;
        # dump probe-point neighbor indices to check same-seed graph consistency
        probe = 0
        row = reducer.graph_[probe].toarray().ravel()
        neighbor_ids = np.argsort(-row)[:10].tolist()
        results[n_components] = {
            "wall_s": wall,
            "coords_shape": list(coords.shape),
            "probe_point": probe,
            "probe_top10_neighbors": neighbor_ids,
        }
        print(f"n_components={n_components}: {wall:.1f}s, "
              f"probe neighbors={neighbor_ids}", flush=True)

    same_graph = results[2]["probe_top10_neighbors"] == results[3]["probe_top10_neighbors"]
    print(f"\nsame-seed graph consistency (2D vs 3D probe neighbors match): {same_graph}")

    est_full_2d_s = results[2]["wall_s"] * (1_080_814 / n) ** 1.15  # UMAP is superlinear-ish
    est_full_3d_s = results[3]["wall_s"] * (1_080_814 / n) ** 1.15
    print(f"rough full-1.08M-row estimate (superlinear extrapolation, treat as a "
          f"ceiling not a promise): 2D~{est_full_2d_s/60:.0f}min 3D~{est_full_3d_s/60:.0f}min")

    (OUT / "smoke_result.json").write_text(json.dumps({
        "n_subsample": n,
        "seed": seed,
        "n_neighbors": 25,
        "min_dist": 0.0,
        "metric": "cosine",
        "umap_version": umap.__version__,
        "results": results,
        "same_seed_graph_consistent": same_graph,
        "rough_full_scale_estimate_min": {
            "2d": est_full_2d_s / 60,
            "3d": est_full_3d_s / 60,
        },
    }, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
