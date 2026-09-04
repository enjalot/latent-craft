#!/usr/bin/env python3
"""Full chunk-pack build for one MONET draw arm. Run with the pipeline's own venv
(has pandas/pillow/pyarrow — no umap-learn dependency, that already ran separately).

Same shape as run_chunkpack_bl.py: `assign_and_build` is dataset-agnostic, so all this
script does is hand it MONET's points table, coords, thumbnail source, subset codes and
thumbnail URL template.

Two MONET-specific notes:
  * `subsets` is `config.MONET_SOURCES` — the FROZEN 9-source mapping, not something
    derived from the arm's own sources, so `subset_code` means the same thing in every
    arm's pack.
  * `thumb_url_template` is `monet/{local_idx}.webp`, resolved by the data server's
    dynamic route (MONET thumbnails are byte ranges in packed blobs, not files) —
    `local_idx` is the packed (shard_idx, local_row) ref from the points table's
    `global_idx`. See lsvoxel/monet_thumbs.py.

If the thumbnail store is still being pulled, voxels whose representative point isn't
available yet get a blank atlas tile and the build reports the count (`n_blank_tiles`)
rather than failing — but a pack built that way should be rebuilt once the pull
finishes.

Usage: .venv/bin/python scripts/run_chunkpack_monet.py <arm> [num_voxels] [variant_suffix]

variant_suffix names the output dir chunks/monet-<arm><variant_suffix>/ (e.g. "-160"),
same convention as run_chunkpack_bl.py, so a higher-resolution pack can be built next to
the default one instead of over it. The points table and UMAP fit are per ARM (resolution
only changes the binning), so those are always read from the un-suffixed dataset.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from lsvoxel.chunkpack.build import assign_and_build, validate_chunks  # noqa: E402
from lsvoxel.config import (  # noqa: E402
    MONET_ARMS,
    MONET_SOURCES,
    MONET_THUMB_URL_TEMPLATE,
    chunks_dir,
    monet_dataset_id,
    points_table_path,
    umap_run_dir,
)
from lsvoxel.datasets.monet import MonetThumbnailSource  # noqa: E402


def main() -> int:
    if len(sys.argv) < 2:
        print(
            f"usage: run_chunkpack_monet.py <arm> [num_voxels]   (known arms: {', '.join(MONET_ARMS)})",
            file=sys.stderr,
        )
        return 2
    arm = sys.argv[1]
    num_voxels = int(sys.argv[2]) if len(sys.argv) > 2 else 96
    variant_suffix = sys.argv[3] if len(sys.argv) > 3 else ""
    dataset_id = monet_dataset_id(arm)
    pack_id = f"{dataset_id}{variant_suffix}"

    points_path = points_table_path(dataset_id)
    print(f"loading {points_path} ...", flush=True)
    points_df = pd.read_parquet(points_path)

    umap_dir = umap_run_dir(dataset_id)
    coords3d = np.load(umap_dir / "coords3d.npy")
    print(f"loaded points={len(points_df):,} coords3d={coords3d.shape}", flush=True)

    thumb_source = MonetThumbnailSource(points_df)

    out_dir = chunks_dir(pack_id)
    print(f"output dir: {out_dir} (num_voxels={num_voxels})", flush=True)
    result = assign_and_build(
        dataset_id=pack_id,
        points_df=points_df,
        coords3d=coords3d,
        num_voxels=num_voxels,
        thumb_source=thumb_source,
        out_dir=out_dir,
        subsets=dict(MONET_SOURCES),
        thumb_url_template=MONET_THUMB_URL_TEMPLATE,
        umap_run="umap-001",
        points_table_path=points_path,
        voxels_per_chunk=16,
    )
    print(f"[run_chunkpack_monet] build result: {result}", flush=True)

    print("[run_chunkpack_monet] validating ...", flush=True)
    v = validate_chunks(out_dir)
    print(f"[run_chunkpack_monet] validate result: {v}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
