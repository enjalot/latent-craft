#!/usr/bin/env python3
"""Publish row-verified MONET CLIP basemap 2D + 3D packs; never refit or touch research inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
import pandas as pd
from lsvoxel.config import DATA_ROOT, MONET_POOL_DIR, MONET_SOURCES, MONET_THUMB_URL_TEMPLATE, MONET_URLS_SHARDS_DIR
from lsvoxel.datasets.monet import MonetThumbnailSource, _gather_originals, _intern_strings
from lsvoxel.monet_thumbs import pack_thumb_ref
from lsvoxel.point_meta import write_point_meta
from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack
from lsvoxel.chunkpack.build import assign_and_build
from lsvoxel.chunkpack.streaming import convert

SANDBOX = Path("/data/latent-basemap/sandbox")
TRAIN = Path("/data2/monet/random-2m")


def training_pool_rows(pool_manifest, pool_ids):
    """Join by source shard path, then verify EVERY training image identity."""
    training = json.loads((TRAIN / "manifest.json").read_text())
    paths = pool_manifest["shards"]
    shard_index = {path: i for i, path in enumerate(paths)}
    prov = np.load(MONET_POOL_DIR / "prov_shard_idx.npy", mmap_mode="r")
    local = np.load(MONET_POOL_DIR / "prov_local_row.npy", mmap_mode="r")
    refs = pack_thumb_ref(prov.astype(np.uint32), local.astype(np.uint32))
    order = np.argsort(refs)
    sorted_refs = refs[order]
    if np.any(sorted_refs[1:] == sorted_refs[:-1]):
        raise ValueError("Duplicate source rows in pool provenance")
    rows = []
    for shard in training["shards"]:
        index = shard_index[shard["path"]]
        wanted = pack_thumb_ref(np.uint32(index), np.arange(shard["rows"], dtype=np.uint32))
        positions = np.searchsorted(sorted_refs, wanted)
        if np.any(positions >= len(sorted_refs)) or not np.array_equal(sorted_refs[positions], wanted):
            raise ValueError(f"Training shard missing pool rows: {shard['path']}")
        joined = order[positions]
        with np.load(TRAIN / "shards" / f'{shard["idx"]:04d}_meta.npz') as meta:
            if not np.array_equal(meta["id"], pool_ids[joined]):
                raise ValueError(f"Training/pool identity mismatch: {shard['path']}")
        rows.append(joined)
    result = np.concatenate(rows)
    if len(result) != training["n_rows"] or len(np.unique(result)) != len(result):
        raise ValueError("Invalid training row join")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", choices=["pool", "training"])
    parser.add_argument("--release", required=True)
    parser.add_argument("--voxels", type=int, default=512)
    parser.add_argument("--basisu", default="basisu", help="Atlas encoder executable (absolute path for services)")
    parser.add_argument("--resume", action="store_true", help="Reuse verified points/minimap stages of an unpublished release")
    args = parser.parse_args()
    if not args.release.isalnum() or args.voxels < 160 or args.voxels % 16:
        parser.error("Use an alphanumeric release and voxel count >=160 divisible by 16")
    dataset = f"monet-clip-basemap-{args.scope}-{args.release}"
    points_path = DATA_ROOT / "points" / dataset / "points.parquet"
    minimap = DATA_ROOT / "minimap" / dataset
    source = DATA_ROOT / "chunks" / f"{dataset}-{args.voxels}-source"
    output = DATA_ROOT / "chunks" / f"{dataset}-{args.voxels}-stream"
    if output.exists() or (not args.resume and any(p.exists() for p in [points_path.parent, minimap, source])):
        parser.error("Release already exists; use a fresh immutable release")
    pool_manifest = json.loads((MONET_POOL_DIR / "manifest.json").read_text())
    if args.scope == "training":
        idx = training_pool_rows(pool_manifest, np.load(MONET_POOL_DIR / "id.npy", mmap_mode="r"))
        coord_paths = [SANDBOX / f"monet-random-clip-2m{suffix}" / "champion-bs16k" / "coordinates.npy" for suffix in ["", "-3d"]]
    else:
        idx = slice(None)
        coord_paths = [SANDBOX / f"monet-clip-fullpool-proj{suffix}-20260905" / "coords.f32.npy" for suffix in ["", "-3d"]]
    shard = np.asarray(np.load(MONET_POOL_DIR / "prov_shard_idx.npy", mmap_mode="r")[idx])
    local = np.asarray(np.load(MONET_POOL_DIR / "prov_local_row.npy", mmap_mode="r")[idx])
    n = len(shard)
    for dimension, path in zip([2, 3], coord_paths):
        coords = np.load(path, mmap_mode="r")
        if coords.shape != (n, dimension):
            raise ValueError(f"Coordinate shape mismatch: {path}: {coords.shape}")
        for a in range(0, n, 1000000):
            if not np.isfinite(coords[a:a+1000000]).all(): raise ValueError(f"Nonfinite coordinates: {path}")
    print(f"Verified {n:,} row-aligned 2D / 3D points ({args.scope})", flush=True)
    if args.resume and points_path.exists():
        provenance = json.loads((points_path.parent / "provenance.json").read_text())
        for path, recorded in zip(coord_paths, provenance["coordinates"]):
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if str(path) != recorded["path"] or digest != recorded["sha256"]:
                raise ValueError("Refusing resume: coordinates changed")
        points = pd.read_parquet(points_path, columns=["row_id", "subset", "shard_idx", "local_row", "global_idx"])
        if len(points) != n or not np.array_equal(points.shard_idx, shard) or not np.array_equal(points.local_row, local):
            raise ValueError("Refusing resume: points provenance changed")
        publish_geometry(args, dataset, points_path, points, coord_paths, minimap, source, output)
        return
    sources = _intern_strings(np.asarray(np.load(MONET_POOL_DIR / "source.npy", mmap_mode="r")[idx]))
    if set(np.unique(sources)) - set(MONET_SOURCES): raise ValueError("Unknown source")
    urls, widths, heights = _gather_originals(shard, local, MONET_URLS_SHARDS_DIR)
    points = pd.DataFrame(dict(row_id=np.arange(n, dtype=np.uint32), subset=sources,
        shard_idx=shard, local_row=local, global_idx=pack_thumb_ref(shard.astype(np.uint32), local.astype(np.uint32)),
        image_url=urls.to_pandas(), image_width=widths, image_height=heights))
    points_path.parent.mkdir(parents=True)
    points.to_parquet(points_path, index=False)
    write_point_meta(points_path.parent / "point_meta.bin", urls, widths, heights)
    provenance = {"dataset": dataset, "n_points": n, "embedding": "CLIP ViT-B/32", "projection": "latent-basemap, single-seed focused 2M heads",
        "row_join": "pool provenance; training subset additionally verified by every source image id", "coordinates": []}
    for path in coord_paths:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        provenance["coordinates"].append({"path": str(path), "sha256": digest})
    (points_path.parent / "provenance.json").write_text(json.dumps(provenance, indent=2))
    publish_geometry(args, dataset, points_path, points, coord_paths, minimap, source, output)


def publish_geometry(args, dataset, points_path, points, coord_paths, minimap, source, output):
    if args.resume and (minimap / "manifest.json").exists():
        validate_minimap_pack(minimap)
    else:
        build_minimap_pack(dataset, coord_paths[0], points, minimap, dict(MONET_SOURCES))
    thumbs = MonetThumbnailSource(points)
    try:
        assign_and_build(dataset_id=dataset, points_df=points, coords3d=np.load(coord_paths[1], mmap_mode="r"),
            num_voxels=args.voxels, thumb_source=thumbs, out_dir=source, subsets=dict(MONET_SOURCES),
            thumb_url_template=MONET_THUMB_URL_TEMPLATE, umap_run="basemap-2m-head", points_table_path=points_path, wide_counts=True, basisu_bin=args.basisu)
    finally:
        thumbs.close()
    print(convert(source, output, minimap), flush=True)
    print(f"PUBLISHED {output}", flush=True)


if __name__ == "__main__":
    main()
