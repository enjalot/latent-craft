"""CPU UMAP fit via /data/latent-basemap/umap06dev-env — the "0.6dev" umap-learn clone.

Must be run with THAT environment's python (it has umap-learn/pynndescent/numba;
the lsvoxel venv deliberately does not depend on umap-learn — see the project plan).
Produces a 2D and a 3D fit from the same input, same random_state. These are
independent optimizations (not one fit with an axis dropped) — same-seed graph
determinism (verified in the Phase 0 smoke test) is what keeps them related.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np


def fit_umap_cpu(
    X: np.ndarray,
    out_dir: Path,
    n_components: tuple[int, ...] = (2, 3),
    n_neighbors: int = 25,
    min_dist: float = 0.0,
    metric: str = "cosine",
    seed: int = 42,
    source_path: str = "",
) -> dict:
    import umap

    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "umap_version": umap.__version__,
        "umap_env": "0.6dev clone, HEAD 67ca365 (/data/latent-basemap/umap06dev-env)",
        "device": "cpu",
        "seed": seed,
        "n_neighbors": n_neighbors,
        "min_dist": min_dist,
        "metric": metric,
        "source_path": source_path,
        "n_rows": int(X.shape[0]),
        "source_dim": int(X.shape[1]),
        "fits": {},
    }

    for nc in n_components:
        print(f"[umap_fit] fitting n_components={nc} ...", flush=True)
        t0 = time.time()
        reducer = umap.UMAP(
            n_neighbors=n_neighbors,
            min_dist=min_dist,
            n_components=nc,
            metric=metric,
            random_state=seed,
            verbose=True,
        )
        coords = reducer.fit_transform(X).astype(np.float32)
        wall = time.time() - t0
        out_name = f"coords{nc}d.npy"
        np.save(out_dir / out_name, coords)
        meta["fits"][str(nc)] = {"wall_s": wall, "out_file": out_name, "shape": list(coords.shape)}
        print(f"[umap_fit] n_components={nc} done in {wall/60:.1f} min -> {out_dir / out_name}",
              flush=True)

    (out_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta


def load_writable(path: Path, dtype=np.float32) -> np.ndarray:
    """A read-only memmap makes pynndescent's numba signatures reject the array
    (documented gotcha, same as latent-basemap's own upstream_2m_run.py) — force a
    writable, cast copy."""
    return np.array(np.load(path, mmap_mode="r"), dtype=dtype)
