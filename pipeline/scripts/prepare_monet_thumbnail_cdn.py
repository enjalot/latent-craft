#!/usr/bin/env python3
"""Index an existing immutable MONET thumbnail store for direct browser/CDN ranges.

No images are rewritten. Output is only a small manifest and gzip sidecar;
publish the input shards' .blob and .offsets.u64 files under output/shards/ on
the CDN. --link-shards adds a local preview symlink, never a second corpus copy.
"""
import argparse
import gzip
import json
from pathlib import Path
import struct


def prepare(source: Path, output: Path, link_shards=False):
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents:
        raise ValueError("Output must be outside the immutable source store")
    if output.exists(): raise FileExistsError("Use a fresh immutable release")
    receipt = json.loads((source / "manifest-full.json").read_text())
    count = receipt["n_shards"]
    if count != receipt["n_shards_done"] or not 0 < count <= 65536 or receipt.get("errors"):
        raise ValueError("Thumbnail store is incomplete")
    shards, total = [], 0
    for shard in range(count):
        base = source / "shards" / f"{shard:04d}"
        if not base.with_suffix(".done").is_file(): raise ValueError(f"Shard {shard} incomplete")
        offset_path = base.with_suffix(".offsets.u64")
        size = base.with_suffix(".blob").stat().st_size
        if offset_path.stat().st_size > (65536 + 1) * 8: raise ValueError("Oversized offset table")
        data = offset_path.read_bytes()  # <= 512 KiB; one source shard at a time.
        if len(data) % 8: raise ValueError("Misaligned offset table")
        rows = len(data) // 8 - 1
        if not 0 < rows <= 65536: raise ValueError("Invalid source shard row count")
        offsets = [x[0] for x in struct.iter_unpack("<Q", data)]
        if offsets[0] != 0 or offsets[-1] != size or any(b < a for a, b in zip(offsets, offsets[1:])):
            raise ValueError(f"Invalid offsets in shard {shard}")
        if any(b - a > 1024 ** 2 for a, b in zip(offsets, offsets[1:])):
            raise ValueError("Thumbnail exceeds bounded browser range size")
        shards.append([rows, size]); total += rows
    if total != receipt["validity"]["total_rows_done"]: raise ValueError("Corpus row count mismatch")
    result = dict(version=1, encoding="monet-u64-offsets", rows=total, shards=shards)
    data = json.dumps(result, separators=(",", ":")).encode()
    output.mkdir(parents=True)
    (output / "manifest.json").write_bytes(data)
    (output / "manifest.json.gz").write_bytes(gzip.compress(data, mtime=0))
    if link_shards: (output / "shards").symlink_to(source / "shards", target_is_directory=True)
    print(json.dumps(dict(rows=total, shards=count, manifest_bytes=len(data), blob_bytes=sum(s[1] for s in shards),
        offset_bytes=sum((s[0]+1)*8 for s in shards)), indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path); parser.add_argument("output", type=Path)
    parser.add_argument("--link-shards", action="store_true")
    args = parser.parse_args(); prepare(args.source, args.output, args.link_shards)
