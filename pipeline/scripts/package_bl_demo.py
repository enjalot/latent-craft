#!/usr/bin/env python3
"""Package a static BL demo release; keep source images and old releases intact."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import shutil
import struct
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
import pyarrow.parquet as pq
from lsvoxel.chunkpack.streaming import convert

ROOT = Path("/data/latent-craft/releases/bl-20260907a")
SOURCE = Path("/data/latent-scope-3d")
SUBSETS = ["covers", "medium", "embellishments", "plates"]


def main():
    if (ROOT / "release.json").exists():
        raise RuntimeError("Release already complete; select a new immutable ROOT before rebuilding")
    ROOT.mkdir(parents=True, exist_ok=True)
    pack = ROOT / "chunks/bl-siglip2-160-stream-20260907a"
    if not (pack / "manifest.json").exists():
        print(convert(SOURCE / "chunks/bl-160-source-20260907a", pack, SOURCE / "minimap/bl"), flush=True)
    points = ROOT / "points/bl"; points.mkdir(parents=True, exist_ok=True)
    for name in ["point_meta.bin", "point_meta.json"]: shutil.copyfile(SOURCE / "points/bl" / name, points / name)
    thumbs = ROOT / "thumbs/bl"; thumbs.mkdir(parents=True, exist_ok=True)
    table = pq.read_table(SOURCE / "points/bl/points.parquet", columns=["subset", "global_idx", "thumb_path"])
    names = np.array(table["subset"].to_pylist()); ids = table["global_idx"].to_numpy(); paths = np.array(table["thumb_path"].to_pylist())
    manifest = dict(version=1, shard_rows=2048, subsets={})
    for name in SUBSETS:
        folder = thumbs / name; folder.mkdir(exist_ok=True)
        order = np.flatnonzero(names == name); order = order[np.argsort(ids[order])]
        assert np.array_equal(ids[order], np.arange(len(order)))
        records = np.zeros((len(order), 2), dtype="<u4"); sizes = []
        for start in range(0, len(order), 2048):
            target = folder / f"{start // 2048:05d}.blob"
            # These are exclusively task-owned release artifacts. A resumed
            # pack deterministically replaces its own incomplete shard only.
            with target.open("wb") as stream:
                for row in order[start:start+2048]:
                    payload = (Path("/data/images/british-library-book-images/thumbs") / paths[row]).read_bytes()
                    if not payload or len(payload) > 1024**2: raise ValueError(f"Invalid thumbnail size at {row}")
                    records[ids[row]] = stream.tell(), len(payload)
                    stream.write(payload)
                sizes.append(stream.tell())
            if start % 65536 == 0: print(name, start, "/", len(order), flush=True)
        records.tofile(folder / "offsets.bin")
        manifest["subsets"][name] = dict(count=len(order), sizes=sizes)
    (thumbs / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    # The manifest is published last; no source vectors/private filesystem paths.
    files = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.name == "release.json": continue
        with path.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files.append(dict(path=str(path.relative_to(ROOT)), bytes=path.stat().st_size, sha256=digest))
    (ROOT / "release.json").write_text(json.dumps(dict(version=1, dataset="bl-160", rows=1080814,
        model="google/siglip2-so400m-patch16-256", source="https://huggingface.co/datasets/biglam/british-library-book-images",
        files=files, bytes=sum(f["bytes"] for f in files)), indent=2))
    print("Packaged", len(files), "files", sum(f["bytes"] for f in files), "bytes", flush=True)


if __name__ == "__main__": main()
