#!/usr/bin/env python3
"""Read-only full-row identity/count audit of a published MONET streaming pack."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
from lsvoxel.chunkpack import metablob
from lsvoxel.chunkpack.manifest import validate_manifest
from lsvoxel.chunkpack.pointindex import POINT_INDEX_DTYPE
from lsvoxel.chunkpack.row_to_voxel import ROW_TO_VOXEL_DTYPE
from lsvoxel.chunkpack.assign import assign_points_to_chunks
from lsvoxel.frame import normalize_to_cube
from lsvoxel.minimap._vendored_map_pack_core import quantize


def load_head(path, expected_hash):
    """Load only the supported local architecture, with a pinned checkpoint."""
    with Path(path).open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected_hash:
            raise ValueError("Projection checkpoint changed")
    import torch
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    if (checkpoint["architecture"] != "residual_bottleneck" or checkpoint["input_dim"] not in (512, 768)
            or checkpoint["n_components"] not in (2, 3)):
        raise ValueError("Unexpected projection model architecture")
    architecture = Path(__file__).resolve().parents[3] / "latent-basemap/basemap/pumap/parametric_umap/models/mlp.py"
    spec = importlib.util.spec_from_file_location("full_map_mlp", architecture)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    head = module.ResidualBottleneckMLP(checkpoint["input_dim"], checkpoint["hidden_dim"], checkpoint["n_components"],
        checkpoint["n_layers"], checkpoint["neck_fraction"])
    head.load_state_dict(checkpoint["model_state_dict"], strict=True)
    return head.eval(), checkpoint


def verify_heads(provenance):
    """Reproduce samples from both halves with the actual checkpoint architecture."""
    import torch
    torch.set_num_threads(2)
    errors = {}
    for entry in provenance["coordinates"]:
        head, checkpoint = load_head(entry["checkpoint"], entry["checkpoint_sha256"])
        dim = checkpoint["n_components"]
        input_dim = checkpoint["input_dim"]
        coords = np.load(entry["path"], mmap_mode="r")
        pca = None
        if entry.get("pca_model"):
            with Path(entry["pca_model"]).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != entry["pca_sha256"]:
                    raise ValueError("Projection PCA model changed")
            with np.load(entry["pca_model"]) as model:
                pca = (torch.from_numpy(model["mean"].copy()), torch.from_numpy(model["components"].copy()))
            if pca[0].shape != (1536,) or pca[1].shape != (1536, input_dim):
                raise ValueError("Invalid PCA dimensions")
        paths = entry.get("input_paths", [f"/data2/monet/{name}/clip512.f32.npy" for name in ("pool-20m", "pool-complement-88m")])
        offset = 0
        for name, path in zip(("pool-20m", "pool-complement-88m"), paths):
            vectors = np.load(path, mmap_mode="r")
            sample = np.linspace(0, len(vectors)-1, 64, dtype=np.int64)
            with torch.inference_mode():
                inputs = torch.from_numpy(np.array(vectors[sample], dtype=np.float32))
                if pca is not None:
                    inputs = torch.nn.functional.normalize((inputs - pca[0]) @ pca[1], dim=1)
                predicted = head(inputs).numpy()
            error = float(np.abs(predicted - coords[offset+sample]).max())
            if not np.isfinite(error) or error > 1e-3:
                raise ValueError(f"{dim}D {name} projections do not reproduce: {error}")
            errors[f"{dim}d_{name}_max_error"] = error
            offset += len(vectors)
        if offset != len(coords):
            raise ValueError("Projection/substrate row counts differ")
    return errors


def verify(pack, points):
    manifest = json.loads((pack / "manifest.json").read_text())
    provenance = json.loads((points / "provenance.json").read_text())
    for entry in provenance["coordinates"]:
        if entry.get("sha256"):
            with Path(entry["path"]).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != entry["sha256"]:
                    raise ValueError("Source coordinates changed after publication")
    validate_manifest(pack)
    n = manifest["point_source"]["n_points"]
    if manifest["dataset_id"] != provenance["dataset"] or n != provenance["n_points"]:
        raise ValueError("Release identity mismatch")
    point_dtype = np.dtype([("local_idx", "<u4"), ("subset_code", "u1")]) if manifest["point_index"].get("encoding") == "point-u32-u8" else POINT_INDEX_DTYPE
    index = np.memmap(pack / "point_index.bin", dtype=point_dtype, mode="r")
    if manifest["row_to_voxel"].get("encoding") == "voxel-u32":
        packed = np.memmap(pack / "row_to_voxel.bin", dtype="<u4", mode="r")
        # Audit-side expansion only; the browser never allocates these arrays.
        rv = np.empty(len(packed), dtype=ROW_TO_VOXEL_DTYPE)
        for start in range(0, len(packed), 1_000_000):
            part = packed[start:start+1_000_000]
            rv["chunk_id"][start:start+len(part)] = part >> 12
            rv["local_voxel_id"][start:start+len(part)] = part & 4095
    else:
        rv = np.memmap(pack / "row_to_voxel.bin", dtype=ROW_TO_VOXEL_DTYPE, mode="r")
    refs = np.load(points / "thumb_refs.npy", mmap_mode="r")
    codes = np.load(points / "source_codes.npy", mmap_mode="r")
    row_xy = np.memmap(pack / "row_xy.bin", dtype="<u2", mode="r", shape=(n, 2))
    coords2, coords3 = [np.load(c["path"], mmap_mode="r") for c in provenance["coordinates"]]
    frame2 = json.loads((pack / "minimap.json").read_text())["frame"]["extent"]
    world = manifest["world"]
    for start in range(0, n, 1_000_000):
        stop = min(n, start+1_000_000)
        sl = slice(start, stop)
        np.testing.assert_array_equal(index["local_idx"][sl], refs[sl])
        np.testing.assert_array_equal(index["subset_code"][sl], codes[sl])
        assignment = assign_points_to_chunks(normalize_to_cube(coords3[sl], world["frame"]["extent"]),
            world["num_voxels"], world["voxels_per_chunk"])
        for name in ("chunk_id", "local_voxel_id"):
            np.testing.assert_array_equal(rv[name][sl], assignment[name])
        qx, qy = quantize(coords2[sl], frame2)
        np.testing.assert_array_equal(row_xy[sl, 0], qx)
        np.testing.assert_array_equal(row_xy[sl, 1], qy)
    seen = np.zeros(n, dtype=bool)
    largest_voxel = occupied = total = 0
    for entry in manifest["chunks"]:
        meta = metablob.read_chunk_meta(pack / entry["meta_path"])
        records, rows = meta.voxel_records, meta.point_ids
        if len(rows) != entry["n_points"] or np.any(rows >= n) or np.any(seen[rows]) or len(np.unique(rows)) != len(rows):
            raise ValueError("Duplicate/out-of-range/missing postings")
        seen[rows] = True
        np.testing.assert_array_equal(rv["chunk_id"][rows], np.full(len(rows), entry["chunk_id"], dtype=np.uint32))
        expected_local = np.repeat(np.arange(len(records), dtype=np.uint16), records["count"].astype(np.int64))
        np.testing.assert_array_equal(rv["local_voxel_id"][rows], expected_local)
        for local in np.flatnonzero(records["count"]):
            record = records[local]
            start, count = int(record["point_offset"]), int(record["count"])
            ids = rows[start:start+count]
            if len(ids) != count or np.any(ids[1:] <= ids[:-1]) or record["repr_row_id"] not in ids:
                raise ValueError("Invalid representative or posting order")
        total += len(rows)
        occupied += int(np.count_nonzero(records["count"]))
        largest_voxel = max(largest_voxel, int(records["count"].max()))
    if total != n or not seen.all():
        raise ValueError("Postings do not cover the full corpus exactly once")
    spatial_dtype = np.dtype([("x", "<u2"), ("y", "<u2"), ("row", "<u4"),
        ("chunk", "<u4"), ("local", "<u2"), ("corpus", "u1"), ("pad", "u1")])
    spatial = np.memmap(pack / "spatial.bin", dtype=spatial_dtype, mode="r")
    if len(spatial) != n:
        raise ValueError("Spatial record count mismatch")
    seen.fill(False)
    for start in range(0, n, 1_000_000):
        batch = spatial[start:start+1_000_000]
        rows = batch["row"]
        if np.any(rows >= n) or np.any(seen[rows]) or len(np.unique(rows)) != len(rows):
            raise ValueError("Duplicate/out-of-range spatial rows")
        seen[rows] = True
        for field, expected in (("x", row_xy[rows, 0]), ("y", row_xy[rows, 1]),
                ("chunk", rv["chunk_id"][rows]), ("local", rv["local_voxel_id"][rows]), ("corpus", codes[rows])):
            np.testing.assert_array_equal(batch[field], expected)
    directory = json.loads((pack / "spatial.json").read_text())
    cursor = 0
    for start, count, x0, y0, x1, y1 in directory["pages"]:
        if start != cursor or not 0 < count <= 4096:
            raise ValueError("Invalid spatial page range")
        batch = spatial[start:start+count]
        if [x0, y0, x1, y1] != [int(batch["x"].min()), int(batch["y"].min()), int(batch["x"].max()), int(batch["y"].max())]:
            raise ValueError("Spatial page bounds mismatch")
        cursor += count
    if cursor != n or not seen.all():
        raise ValueError("Spatial pages do not cover all rows")
    hierarchy = json.loads((pack / "hierarchy.json").read_text())
    brick_dtype = np.dtype([("xyz", "<u2", (3,)), ("representative", "<u2"), ("count", "<u4"), ("color", "u1", (4,))])
    bricks = np.memmap(pack / "bricks.bin", dtype=brick_dtype, mode="r")
    for node in hierarchy["nodes"]:
        for level in node["levels"]:
            start = level["offset"]//16
            if int(bricks["count"][start:start+level["count"]].sum(dtype=np.uint64)) != node["count"]:
                raise ValueError("Proxy refinement loses counts")
    if hierarchy["tree"][0]["count"] != n:
        raise ValueError("Hierarchy root count mismatch")
    report = dict(dataset=manifest["dataset_id"], points=n, occupied_voxels=occupied, chunks=len(manifest["chunks"]),
        max_voxel_count=largest_voxel, atlas_bytes=sum(c["atlas_bytes"] for c in manifest["chunks"]),
        pack_bytes=sum(p.stat().st_size for p in pack.rglob("*") if p.is_file()),
        density_bytes=sum(p.stat().st_size for p in (pack / "density").rglob("*") if p.is_file()),
        full_row_joins_verified=True, postings_exactly_once=True, spatial_rows_exactly_once=True, proxy_counts_conserved=True)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", type=Path)
    parser.add_argument("points", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--check-heads", action="store_true", help="Also reproduce sampled projections on CPU (requires torch)")
    args = parser.parse_args()
    report = verify(args.pack, args.points)
    if args.check_heads:
        report["head_checks"] = verify_heads(json.loads((args.points / "provenance.json").read_text()))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
