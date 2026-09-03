"""2D minimap pack builder — same byte contract `mapviewer/` already knows how
to load (density/z{z}/{x}_{y}.{corpus}.u32, points/{lod.bin,xy_id.bin,
tile_index.u64}), built from this project's coords2d.npy + points table
instead of latent-basemap's multi-corpus text substrate.

`corpus` here is BL's `subset` (covers/medium/embellishments/plates), so
per-subset density toggling stays available in a viewer, same as map_pack.py's
original per-text-corpus design. Packed point ids reuse the SAME `row_id`
used everywhere else in this project (chunk pack, point_index.bin,
row_to_voxel.bin) — `packed = subset_code << 28 | row_id`.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from . import _vendored_map_pack_core as core


def build_minimap_pack(
    dataset_id: str,
    coords2d_path: Path,
    points_df: pd.DataFrame,
    out_dir: Path,
    subsets: dict[str, int],
    corpus_column: str = "subset",
    seed: int = 0,
) -> dict:
    n = len(points_df)
    row_ids = points_df["row_id"].to_numpy()
    if not np.array_equal(row_ids, np.arange(n, dtype=row_ids.dtype)):
        raise ValueError("points_df must be dense, row_id-ordered (0..N-1, no gaps)")
    if n >= (1 << core.ID_BITS):
        raise ValueError(f"{n} rows exceeds the {core.ID_BITS}-bit packed id field")

    coords = np.load(coords2d_path, mmap_mode="r")
    if coords.ndim != 2 or coords.shape[1] != 2:
        raise ValueError(f"{coords2d_path}: expected (N, 2), got {coords.shape}")
    if len(coords) != n:
        raise ValueError(f"coords2d has {len(coords)} rows, points_df has {n}")

    for stale in ("density", "points"):
        stale_dir = out_dir / stale
        if stale_dir.exists():
            import shutil

            shutil.rmtree(stale_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    corpus_series = points_df[corpus_column].map(subsets)
    if corpus_series.isna().any():
        missing = points_df.loc[corpus_series.isna(), corpus_column].unique().tolist()
        raise ValueError(f"{corpus_column} value(s) not in subsets mapping: {missing}")
    corpus = corpus_series.to_numpy(dtype=np.int64)
    n_corpora = int(corpus.max()) + 1
    if n_corpora > 16:
        raise ValueError("more than 16 corpora does not fit the 4-bit corpus field")

    print("[minimap] computing frame ...", flush=True)
    frame = core.compute_frame(coords)
    max_zoom = core.choose_max_zoom(n)
    print(f"[minimap] N={n:,} Z={max_zoom} extent={frame['extent']}", flush=True)

    qx, qy = core.quantize(coords, frame["extent"])
    packed = ((corpus.astype(np.uint32) << np.uint32(core.ID_BITS)) | row_ids.astype(np.uint32)).astype(
        np.uint32
    )

    t0 = time.time()
    dens = core.build_density(out_dir, qx, qy, corpus, n_corpora, max_zoom)
    t_density = time.time() - t0
    print(f"[minimap] density {t_density:.1f}s", flush=True)

    tile_id, key = core.sort_key(qx, qy, max_zoom)
    t0 = time.time()
    pts = core.build_points(out_dir, qx, qy, packed, tile_id, key, max_zoom)
    order = pts.pop("order")
    tile_counts = pts.pop("tile_counts")
    del order, key
    t_points = time.time() - t0

    t0 = time.time()
    lod = core.build_lod(out_dir, qx, qy, packed, tile_id, max_zoom, dens["finest_counts"], seed)
    t_lod = time.time() - t0
    print(f"[minimap] points {t_points:.1f}s lod {t_lod:.1f}s", flush=True)

    counts_by_corpus = np.bincount(corpus, minlength=n_corpora)
    inv_subsets = {v: k for k, v in subsets.items()}
    manifest = {
        "pack_format_version": core.PACK_FORMAT_VERSION,
        "dataset_id": dataset_id,
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "n_points": int(n),
        "source_coordinates": {"path": str(coords2d_path), **core.file_entry(coords2d_path)},
        "corpus_codes": {str(v): k for k, v in subsets.items()},
        "corpus_counts": {str(c): int(counts_by_corpus[c]) for c in range(n_corpora)},
        "frame": frame,
        "quantization": {
            "levels": core.QUANT_LEVELS,
            "bits": 16,
            "formula": "q = clip(floor((v - lo) / (hi - lo) * 65536), 0, 65535)",
            "x_axis": "left-to-right over extent[0..1]",
            "y_axis": "top-to-bottom, measured downward from extent[3]",
            "bin_from_q": "bin_z = q >> (16 - (8 + z))",
        },
        "tiles": {
            "scheme": "square grid over the squared trimmed-core extent",
            "tile_bins": core.TILE_BINS,
            "max_zoom": max_zoom,
            "zoom_rule": "smallest z with (256*2^z)^2 >= N, capped at 5",
            "tile_id": "row-major, ty * 2^z + tx, y-down",
            "levels": dens["levels"],
        },
        "points": {
            **pts,
            "sort": "primary key = finest-level tile id (row-major); "
            "secondary = Morton interleave of the in-tile 8-bit bin coords",
            "record": "x:u16, y:u16, packed:u32 (little-endian, 8 B, no padding)",
            "packed": f"corpus << {core.ID_BITS} | row_id",
            "nonempty_tiles": int((tile_counts > 0).sum()),
        },
        "lod": {
            **lod,
            "record": "x:u16, y:u16, packed:u32, min_zoom:u8 (9 B, no padding)",
            "order": "min_zoom, then finest tile id",
            "sampling": "density-stratified: per-finest-bin cap chosen so the "
            "total hits min(N/4, 2M); min_zoom from nested per-level caps",
            "seed": seed,
        },
        "text": {"text_available": False, "reason": "image dataset, no text sidecar"},
        "timings_s": {"density": round(t_density, 1), "points": round(t_points, 1), "lod": round(t_lod, 1)},
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))

    return {
        "manifest_path": out_dir / "manifest.json",
        "n_points": n,
        "max_zoom": max_zoom,
        "n_corpora": n_corpora,
        "subsets": inv_subsets,
    }


def validate_minimap_pack(out_dir: Path) -> dict:
    """Re-derive point/tile counts from the pack alone and cross-check against
    the manifest — mirrors chunkpack.manifest.validate_manifest's approach."""
    manifest = json.loads((out_dir / "manifest.json").read_text())
    max_zoom = manifest["tiles"]["max_zoom"]
    n_points = manifest["n_points"]

    xy_id_path = out_dir / "points" / "xy_id.bin"
    xy_id = np.fromfile(xy_id_path, dtype=core.POINT_DTYPE)
    if len(xy_id) != n_points:
        raise ValueError(f"xy_id.bin has {len(xy_id)} points, manifest says {n_points}")

    tile_index = np.fromfile(out_dir / "points" / "tile_index.u64", dtype="<u8")
    expected_n_tiles = (1 << max_zoom) ** 2
    if len(tile_index) != expected_n_tiles + 1:
        raise ValueError(f"tile_index.u64 has {len(tile_index)} entries, expected {expected_n_tiles + 1}")
    if int(tile_index[-1]) != len(xy_id) * core.POINT_DTYPE.itemsize:
        raise ValueError("tile_index.u64's final offset doesn't match xy_id.bin's size")

    lod = np.fromfile(out_dir / "points" / "lod.bin", dtype=core.LOD_DTYPE)
    if len(lod) != manifest["lod"]["n_points"]:
        raise ValueError(f"lod.bin has {len(lod)} points, manifest says {manifest['lod']['n_points']}")

    # spot-check: every density tile file referenced in a level's index.json exists
    # and is exactly TILE_BINS^2 * 4 bytes
    for level in manifest["tiles"]["levels"]:
        z = level["z"]
        idx = json.loads((out_dir / "density" / f"z{z}" / "index.json").read_text())
        for tile_key, tile_meta in idx["tiles"].items():
            for c in tile_meta["corpora"]:
                p = out_dir / "density" / f"z{z}" / f"{tile_key}.{c}.u32"
                if not p.is_file():
                    raise FileNotFoundError(p)
                if p.stat().st_size != core.TILE_BINS * core.TILE_BINS * 4:
                    raise ValueError(f"{p}: unexpected size {p.stat().st_size}")

    return {"status": "ok", "n_points": n_points, "max_zoom": max_zoom}
