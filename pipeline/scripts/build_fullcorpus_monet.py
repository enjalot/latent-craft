#!/usr/bin/env python3
"""Publish the complete MONET corpus using a verified pair of basemap heads.

All research inputs are read-only. New immutable map/points/minimap releases only.
Original URL coverage is explicitly limited to the previously published pool.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from lsvoxel.config import DATA_ROOT, MONET_POOL_DIR, MONET_SOURCES, MONET_THUMBS_DIR, MONET_THUMB_URL_TEMPLATE
from lsvoxel.monet_thumbs import MonetThumbStore, pack_thumb_ref
from lsvoxel.point_meta import parse_header, _HEADER_STRUCT, MAGIC, VERSION, HEADER_BYTES, RECORD_BYTES
from lsvoxel.chunkpack.build import assign_and_build, validate_chunks
from lsvoxel.chunkpack.streaming import convert
from lsvoxel.minimap.build import build_minimap_pack, validate_minimap_pack

SANDBOX = Path("/data/latent-basemap/sandbox")
COMPLEMENT = Path("/data2/monet/pool-complement-88m")
POOL_POINTS = DATA_ROOT / "points/monet-clip-basemap-pool-20260905a"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


PROFILES = {
    "clip-4m": dict(stem="monet-clip-basemap-full-4m", embedding="CLIP ViT-B/32", head="random-4m",
        folders=("monet-clip-fullcorpus-proj-4m-20260905", "monet-clip-fullcorpus-proj-4m-3d-20260905"),
        heads=("monet-random-clip-4m", "monet-random-clip-4m-3d"), column="clip512.f32.npy", training_rows=4_000_000),
    "dino-6m-pca768": dict(stem="monet-dino-basemap-full-6m-pca768", embedding="DINOv2 ViT-g/14 · PCA-768", head="random-6m-pca768",
        folders=("fullcorpus-dino-6m-pca768-2d", "fullcorpus-dino-6m-pca768-3d"),
        heads=("monet-random-dino-6m-pca768", "monet-random-dino-6m-pca768-3d"), column="dino1536.f16.npy",
        pca="/data2/monet/random-dino-6m/pca768-model.npz", training_rows=6_000_000),
    "dino-12m-pca768": dict(stem="monet-dino-basemap-full-12m-pca768", embedding="DINOv2 ViT-g/14 · PCA-768", head="random-12m-pca768",
        folders=(str(DATA_ROOT / "projections/fullcorpus-dino-12m-pca768-2d-20260910a"), "fullcorpus-dino-12m-pca768-3d"),
        heads=("monet-random-dino-12m-pca768", "monet-random-dino-12m-pca768-3d"), column="dino1536.f16.npy",
        # The 12M training draw deliberately reuses the 6M-fitted PCA basis.
        pca="/data2/monet/random-dino-6m/pca768-model.npz", training_rows=12_000_000),
}


def verify_projection(folder, expected, dim, profile):
    manifest = json.loads((folder / "manifest.json").read_text())
    checkpoint_hash = digest(expected)
    if (manifest["checkpoint"] != str(expected) or manifest["checkpoint_sha256_16"] != checkpoint_hash[:16]
            or manifest.get("checkpoint_sha256", checkpoint_hash) != checkpoint_hash or manifest["dim"] != dim):
        raise ValueError("Projection must use the matching trained head")
    if manifest.get("status", "complete") != "complete":
        raise ValueError("Projection is not complete")
    coords = np.load(folder / "coords.f32.npy", mmap_mode="r")
    n, pool = manifest["n_rows"], manifest["n_pool"]
    if (coords.shape != (n, dim) or coords.dtype != np.float32 or manifest["n_complement"] != n-pool
            or manifest["row_layout"] != {"pool": [0, pool], "complement": [pool, n]}):
        raise ValueError("Projection shape/layout mismatch")
    for start in range(0, n, 1_000_000):
        if not np.isfinite(coords[start:start+1_000_000]).all():
            raise ValueError("Nonfinite full-corpus projection")
    inputs = [MONET_POOL_DIR / profile["column"], COMPLEMENT / profile["column"]]
    for path, count in zip(inputs, (pool, n-pool)):
        if len(np.load(path, mmap_mode="r")) != count:
            raise ValueError("Projection/source row counts differ")
    result = dict(path=str(folder / "coords.f32.npy"), sha256=digest(folder / "coords.f32.npy"),
        checkpoint=str(expected), checkpoint_sha256=checkpoint_hash, manifest=manifest)
    if profile.get("pca"):
        pca = Path(profile["pca"]); pca_hash = digest(pca)
        if dim == 2 or manifest.get("source_identity"):
            if manifest.get("training_rows") != profile["training_rows"] or manifest.get("input_dimensions") != 768 or manifest.get("pca_sha256") != pca_hash:
                raise ValueError("PCA training identity mismatch")
            recorded = manifest["source_identity"]["inputs"]
            if recorded != [dict(path=str(p), bytes=p.stat().st_size, mtime_ns=p.stat().st_mtime_ns) for p in inputs]:
                raise ValueError("DINO source columns changed since projection")
        elif manifest.get("pca_model") != str(pca):
            raise ValueError("3D projection uses another PCA model")
        result.update(input_paths=list(map(str, inputs)), pca_model=str(pca), pca_sha256=pca_hash)
    return result


def verify_inputs(profile_name="clip-4m"):
    profile = PROFILES[profile_name]
    projections = []
    for dim, folder, head in zip((2, 3), profile["folders"], profile["heads"]):
        projections.append(verify_projection(SANDBOX / folder, SANDBOX / head / "champion-bs16k/model.pt", dim, profile))
    if any(projections[0]["manifest"][key] != projections[1]["manifest"][key]
           for key in ("n_rows", "n_pool", "n_complement", "row_layout")):
        raise ValueError("2D/3D source layouts differ")
    alignment = [entry["manifest"].get("row_alignment") for entry in projections]
    if all(alignment) and alignment[0] != alignment[1]:
        raise ValueError("2D/3D source alignment receipts differ")
    pool_manifest = json.loads((MONET_POOL_DIR / "manifest.json").read_text())
    paths = json.loads((COMPLEMENT / "full_shards.json").read_text())["shards"]
    if not isinstance(paths, list) or paths[:len(pool_manifest["shards"])] != pool_manifest["shards"]:
        raise ValueError("Extended thumbnail shard order does not preserve the pool")
    thumbnail_manifest = json.loads((MONET_THUMBS_DIR / "manifest-full.json").read_text())
    if thumbnail_manifest["n_shards_done"] != len(paths) or thumbnail_manifest["errors"]:
        raise ValueError("Full thumbnail pull is incomplete")
    return projections, paths, thumbnail_manifest


def map_source_rows(shard, local, source, counts, names, shard_codes, shard_start, shard_stop):
    """Preserve arbitrary input order while rejecting invalid source addresses."""
    if shard.shape != local.shape or np.any(shard < shard_start) or np.any(shard >= shard_stop):
        raise ValueError("Source provenance outside thumbnail store")
    if np.any(local < 0) or np.any(local >= counts[shard]):
        raise ValueError("Source provenance outside thumbnail store")
    if source is not None and not np.array_equal(source, names[shard]):
        raise ValueError("Source category mismatch")
    return pack_thumb_ref(shard.astype(np.uint32), local.astype(np.uint32)), shard_codes[shard]


def build_points(folder, projections, paths):
    n = projections[0]["manifest"]["n_rows"]
    n_pool = projections[0]["manifest"]["n_pool"]
    folder.mkdir(parents=True, exist_ok=False)
    refs = np.lib.format.open_memmap(folder / "thumb_refs.npy", mode="w+", dtype="<u4", shape=(n,))
    codes = np.lib.format.open_memmap(folder / "source_codes.npy", mode="w+", dtype="u1", shape=(n,))
    failed = 0
    counts = np.zeros(len(paths), dtype=np.uint32)
    names = np.array(["-".join(path.split("/")[1:-2]) for path in paths])
    shard_codes = np.array([MONET_SOURCES[name] for name in names], dtype=np.uint8)
    for gi in range(len(paths)):
        base = MONET_THUMBS_DIR / "shards" / f"{gi:04d}"
        if not base.with_suffix(".done").exists():
            raise ValueError(f"Thumbnail shard {gi} incomplete")
        meta = json.loads(base.with_suffix(".meta.json").read_text())
        offsets = np.fromfile(base.with_suffix(".offsets.u64"), dtype="<u8")
        count = len(offsets)-1
        if meta["shard_path"] != paths[gi] or meta["n_rows"] != count or count >= 65536 or count <= 0:
            raise ValueError(f"Thumbnail identity mismatch in shard {gi}")
        if offsets[0] != 0 or np.any(offsets[1:] < offsets[:-1]) or int(offsets[-1]) != base.with_suffix(".blob").stat().st_size:
            raise ValueError(f"Invalid thumbnail offsets in shard {gi}")
        if gi >= 2015:
            # The complement's assembled source.npy is pickled Python objects.
            # Read the small, non-pickled per-shard source column instead.
            with np.load(COMPLEMENT / "light" / f"{gi:05d}.npz") as light:
                source_values = light["source"]
                if source_values.shape != (count,) or not np.all(source_values == names[gi]):
                    raise ValueError(f"Complement source identity mismatch in shard {gi}")
        failed += int(np.count_nonzero(offsets[1:] == offsets[:-1]))
        counts[gi] = count
        if (gi+1) % 1000 == 0:
            print(f"[full] verified thumbnail offsets/source metadata {gi+1}/{len(paths)}", flush=True)
    if int(counts[:2015].sum()) != n_pool or int(counts.sum()) != n:
        raise ValueError("Thumbnail and coordinate row totals differ")
    total = 0
    for root, shard_start, shard_stop, expected_n in (
        (MONET_POOL_DIR, 0, 2015, n_pool), (COMPLEMENT, 2015, len(paths), n-n_pool)):
        shard = np.load(root / "prov_shard_idx.npy", mmap_mode="r")
        local = np.load(root / "prov_local_row.npy", mmap_mode="r")
        source = np.load(root / "source.npy", mmap_mode="r") if root == MONET_POOL_DIR else None
        if not (len(shard) == len(local) == expected_n) or (source is not None and len(source) != expected_n):
            raise ValueError("Source row count mismatch")
        # The original pool is not stored in source-shard order. Preserve its
        # existing row permutation; use explicit provenance, never concatenate
        # thumbnails in shard order and assume those are projection row IDs.
        for start in range(0, expected_n, 1_000_000):
            stop = min(expected_n, start+1_000_000)
            batch_refs, batch_codes = map_source_rows(shard[start:stop], local[start:stop],
                source[start:stop] if source is not None else None, counts, names, shard_codes, shard_start, shard_stop)
            refs[total+start:total+stop] = batch_refs
            codes[total+start:total+stop] = batch_codes
        total += expected_n
    sorted_refs = np.sort(refs)
    if np.any(sorted_refs[1:] == sorted_refs[:-1]):
        raise ValueError("Duplicate source identities in the corpus")
    del sorted_refs
    # Preserve the existing pool metadata only after checking every pool identity.
    prior = pq.read_table(POOL_POINTS / "points.parquet", columns=["global_idx"])["global_idx"].to_numpy()
    if not np.array_equal(prior, refs[:n_pool]):
        raise ValueError("Existing pool original URLs use different row identities")
    refs.flush(); codes.flush()
    with pq.ParquetWriter(folder / "points.parquet", pa.schema([
        ("row_id", pa.uint32()), ("subset", pa.string()), ("global_idx", pa.uint32())]), compression="zstd") as writer:
        labels = np.array(list(MONET_SOURCES), dtype=object)
        for start in range(0, n, 1_000_000):
            stop = min(n, start+1_000_000)
            writer.write_table(pa.table(dict(row_id=np.arange(start, stop, dtype=np.uint32),
                subset=labels[codes[start:stop]], global_idx=refs[start:stop])))
    extend_pool_meta(POOL_POINTS / "point_meta.bin", folder / "point_meta.bin", n, n_pool)
    return failed


def extend_pool_meta(source, destination, n, n_pool):
    """Preserve pool URLs; explicit empty metadata for not-yet-pulled complement.

    Copy in bounded buffers; no concatenation of 100M URL strings or u32 overflow.
    The sparse zero records mean unavailable, never a fabricated original URL.
    """
    with source.open("rb") as src, destination.open("xb") as dst:
        header = parse_header(src.read(HEADER_BYTES), source.stat().st_size)
        if header.n_rows != n_pool or n < n_pool:
            raise ValueError("Pool metadata row count mismatch")
        blob_offset = HEADER_BYTES + n*RECORD_BYTES
        dst.write(_HEADER_STRUCT.pack(MAGIC, VERSION, 0, n, HEADER_BYTES, blob_offset, header.blob_bytes))
        src.seek(header.records_offset)
        remaining = n_pool*RECORD_BYTES
        while remaining:
            block = src.read(min(1024*1024, remaining))
            if not block: raise ValueError("Truncated pool metadata")
            dst.write(block); remaining -= len(block)
        dst.seek(blob_offset)
        src.seek(header.blob_offset)
        shutil.copyfileobj(src, dst, 1024*1024)


class FullThumbs:
    def __init__(self, refs):
        self.refs = refs
        self.store = MonetThumbStore()

    def open(self, row):
        return self.store.read_packed(int(self.refs[row]))

    def close(self):
        self.store.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True)
    parser.add_argument("--profile", choices=PROFILES, default="clip-4m")
    parser.add_argument("--check-heads", action="store_true", help="CPU re-inference before building; requires torch")
    parser.add_argument("--voxels", type=int, default=512)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--basisu", default="/home/enjalot/.local/bin/basisu")
    parser.add_argument("--atlas-workers", type=int, default=4)
    parser.add_argument("--reuse-atlases", type=Path, help="Read-only atlas cache from an interrupted build of this release")
    args = parser.parse_args()
    if not args.release.isalnum() or not 160 <= args.voxels <= 4096 or args.voxels % 16:
        parser.error("Alphanumeric release and voxel count 160..4096 divisible by 16 required")
    profile = PROFILES[args.profile]
    dataset = f"{profile['stem']}-{args.release}"
    folder = DATA_ROOT / "points" / dataset
    minimap = DATA_ROOT / "minimap" / dataset
    source = DATA_ROOT / "chunks" / f"{dataset}-{args.voxels}-source"
    output = DATA_ROOT / "chunks" / f"{dataset}-{args.voxels}-stream"
    if not 1 <= args.atlas_workers <= 8:
        parser.error("Atlas workers must be in 1..8")
    if args.reuse_atlases is not None:
        if args.reuse_atlases.parent.resolve() != source.parent.resolve() or not args.reuse_atlases.name.startswith(f".{source.name}.building-"):
            parser.error("Atlas reuse must be from this exact release's interrupted staging directory")
    if output.exists() or (not args.resume and any(p.exists() for p in (folder, minimap, source))):
        parser.error("Use a fresh immutable release, or --resume an unpublished build")
    projections, paths, thumbs_receipt = verify_inputs(args.profile)
    head_checks = None
    if args.check_heads:
        from verify_fullcorpus_monet import verify_heads
        head_checks = verify_heads(dict(coordinates=projections))
        print(f"[full] head checks: {head_checks}", flush=True)
    n = projections[0]["manifest"]["n_rows"]
    provenance_path = folder / "provenance.json"
    if args.resume and provenance_path.exists():
        provenance = json.loads(provenance_path.read_text())
        if provenance["coordinates"] != projections:
            raise ValueError("Cannot resume with changed research artifacts")
    else:
        failed = build_points(folder, projections, paths)
        if failed != thumbs_receipt["validity"]["total_failed_decode"]:
            raise ValueError("Thumbnail failure count differs from completion receipt")
        provenance = dict(dataset=dataset, n_points=n, embedding=profile["embedding"],
            projection=f"latent-basemap, {profile['head']} 2D and 3D heads", coordinates=projections, head_checks=head_checks,
            row_join="Full validation of every source shard/local row against thumbnail offsets and concatenated pool/complement layout",
            thumbnails=thumbs_receipt, original_urls=dict(available_for="initial pool rows only", pool_rows=projections[0]["manifest"]["n_pool"],
                complement="not downloaded; 256px thumbnail fallback", source=str(POOL_POINTS / "point_meta.bin")))
        provenance_path.write_text(json.dumps(provenance, indent=2))
    refs = np.load(folder / "thumb_refs.npy", mmap_mode="r")
    codes = np.load(folder / "source_codes.npy", mmap_mode="r")
    points = pd.DataFrame(dict(row_id=np.arange(n, dtype=np.uint32), global_idx=refs,
        subset=pd.Categorical.from_codes(codes, categories=list(MONET_SOURCES))), copy=False)
    print(f"[full] verified {n:,} rows; points ready", flush=True)
    if args.resume and (minimap / "manifest.json").exists():
        validate_minimap_pack(minimap)
    else:
        build_minimap_pack(dataset, Path(projections[0]["path"]), points, minimap, dict(MONET_SOURCES), overview_only=True)
        validate_minimap_pack(minimap)
    if args.resume and (source / "manifest.json").exists():
        validate_chunks(source)
    else:
        thumbs = FullThumbs(refs)
        try:
            result = assign_and_build(dataset_id=dataset, points_df=points, coords3d=np.load(projections[1]["path"], mmap_mode="r"),
                num_voxels=args.voxels, thumb_source=thumbs, out_dir=source, subsets=dict(MONET_SOURCES),
                thumb_url_template=MONET_THUMB_URL_TEMPLATE, umap_run=f"basemap-{profile['head']}-head", points_table_path=folder / "points.parquet",
                wide_counts=True, basisu_bin=args.basisu, atlas_workers=args.atlas_workers, reuse_atlases=args.reuse_atlases)
            print(f"[full] source built: {result}", flush=True)
        finally:
            thumbs.close()
    print(convert(source, output, minimap), flush=True)
    print(f"PUBLISHED {output}", flush=True)


if __name__ == "__main__":
    main()
