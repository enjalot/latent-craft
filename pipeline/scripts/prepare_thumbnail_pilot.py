#!/usr/bin/env python3
"""Prepare a reproducible, small MONET range-serving and 128px quality pilot.

Originals are linked, never rewritten. Only selected shards are resized.
The manifest records checksums, costs, and exact source IDs for comparisons.
"""
import argparse
import errno
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import random
import struct
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from lsvoxel.thumbnail_quality import resize_thumbnail


def build_shard(args):
    source, output, shard, rows, blob_bytes = args
    started = time.monotonic()
    name = f"{shard:04d}"
    original, resized = output / "256", output / "128"
    source_offsets = (source / "shards" / f"{name}.offsets.u64").read_bytes()
    offsets = [v[0] for v in struct.iter_unpack("<Q", source_offsets)]
    if len(offsets) != rows + 1 or offsets[0] != 0 or offsets[-1] != blob_bytes:
        raise ValueError("Source shard identity mismatch")
    for suffix in ("blob", "offsets.u64"):
        # A same-filesystem link keeps disk use small without dangling pilot paths.
        source_path = (source / "shards" / f"{name}.{suffix}").resolve()
        try: os.link(source_path, original / f"{name}.{suffix}")
        except OSError as error:
            if error.errno != errno.EXDEV: raise
            (original / f"{name}.{suffix}").symlink_to(source_path)
    position, samples, failed, valid = 0, [], 0, 0
    sample_rows = set(random.Random(shard).sample(range(rows), min(rows, 64)))
    with (source / "shards" / f"{name}.blob").open("rb") as src, (resized / f"{name}.blob").open("wb") as dst, (resized / f"{name}.offsets.u64").open("wb") as idx:
        idx.write(struct.pack("<Q", 0))
        for row, (start, end) in enumerate(zip(offsets, offsets[1:])):
            if not 0 <= end - start <= 1024**2: raise ValueError("Unbounded source span")
            raw = src.read(end - start)
            if len(raw) != end - start: raise ValueError("Truncated source blob")
            data = resize_thumbnail(raw) if raw else b""
            failed += not bool(raw); valid += bool(raw)
            if raw and row in sample_rows:
                samples.append({"ref": (shard << 16) | row, "shard": name, "row": row,
                    "256": {"start": start, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
                    "128": {"start": position, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}})
            dst.write(data); position += len(data); idx.write(struct.pack("<Q", position))
    result = {"name": name, "rows": rows, "valid": valid, "missing": failed, "seconds": time.monotonic() - started,
        "256": {"bytes": blob_bytes}, "128": {"bytes": position}, "samples": samples}
    for size in ("256", "128"):
        result[size]["files"] = []
        for suffix in ("blob", "offsets.u64"):
            path = output / size / f"{name}.{suffix}"
            with path.open("rb") as f: digest = hashlib.file_digest(f, "sha256").hexdigest()
            result[size]["files"].append({"path": path.relative_to(output).as_posix(), "bytes": path.stat().st_size, "sha256": digest})
    print(json.dumps({"shard": name, "rows": rows, "256_bytes": blob_bytes, "128_bytes": position, "seconds": result["seconds"]}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--shards", type=int, default=8)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.shards <= 12 or not 1 <= args.workers <= 8: raise ValueError("Pilot must stay small")
    source = args.source.resolve(); output = args.output.resolve()
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest.get("encoding") != "monet-u64-offsets": raise ValueError("Expected verified CDN manifest")
    selected = sorted(random.Random(20260908).sample(range(len(manifest["shards"])), args.shards))
    source_bytes = sum(manifest["shards"][i][1] for i in selected)
    if source_bytes > 1024**3: raise ValueError("Pilot originals exceed 1 GiB")
    output.mkdir(parents=True, exist_ok=False)
    for size in ("128", "256"): (output / size).mkdir()
    started = time.monotonic()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        shards = list(pool.map(build_shard, [(source, output, i, *manifest["shards"][i]) for i in selected]))
    rows = sum(s["rows"] for s in shards)
    sizes = {size: sum(s[size]["bytes"] for s in shards) for size in ("128", "256")}
    result = {"version": 1, "seed": 20260908, "rows": rows, "source_rows": manifest["rows"],
        "source_blob_bytes": sum(s[1] for s in manifest["shards"]), "quality": 80, "method": 4,
        "note": f"128px longest side, Lanczos, RGB WebP q80. Re-encoded from existing lossy 256px thumbnails, not original images. {len(shards)} uniformly sampled source shards; extrapolation is an estimate, not a full-corpus measurement.",
        "seconds": time.monotonic() - started, "image_bytes": sizes,
        "extrapolated_128_blob_bytes": round(sum(s[1] for s in manifest["shards"]) * sizes["128"] / sizes["256"]),
        "shards": {s["name"]: {"rows": s["rows"], "valid": s["valid"], "missing": s["missing"], "256": s["256"]["bytes"], "128": s["128"]["bytes"]} for s in shards},
        "files": [f for s in shards for size in ("128", "256") for f in s[size]["files"]],
        "samples": [sample for s in shards for sample in s["samples"]]}
    (output / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k:v for k,v in result.items() if k not in ("shards", "files", "samples")}, indent=2))


if __name__ == "__main__": main()
