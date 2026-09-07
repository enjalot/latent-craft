#!/usr/bin/env python3
"""Package only the measured BL search finalists; outputs are immutable artifacts.

The full float32 truth index, source vectors and unselected experiment tables
are never included. Runtime files are individually hashed for Space startup.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment", type=Path, default=Path("/data/latent-craft/experiments/bl-search-20260907b"))
    parser.add_argument("--output", type=Path, default=Path("/data/latent-craft/releases/bl-search-20260907b"))
    parser.add_argument("--base-url", default="https://storage.googleapis.com/fun-data/latent-craft/bl/search-20260907b")
    args = parser.parse_args(); out, source = args.output, args.experiment
    out.mkdir(parents=True, exist_ok=False)
    shutil.copytree(source / "text-model", out / "text-model")
    table = "lance-f16-sq8"
    shutil.copytree(source / "lance" / f"{table}.lance", out / "lance" / f"{table}.lance")
    shutil.copyfile(source / "faiss-sq8.index", out / "faiss-sq8.index")
    pack = Path("/data/latent-craft/releases/bl-20260907a/chunks/bl-siglip2-160-stream-20260907a")
    for name in ["point_index.bin", "row_to_voxel.bin"]: shutil.copyfile(pack / name, out / name)
    np.save(out / "text-check.npy", np.load(source / "queries.npy")[0])
    config = dict(dataset="bl-160", release="bl-20260907a", backends={
        "faiss": dict(nprobes=128), "sq8": dict(table=table, metric="cosine", nprobes=256, refine=4)})
    (out / "service.json").write_text(json.dumps(config, indent=2) + "\n")
    files = []
    for path in sorted(out.rglob("*")):
        if not path.is_file(): continue
        with path.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files.append(dict(path=path.relative_to(out).as_posix(), bytes=path.stat().st_size, sha256=digest))
    manifest = dict(version=1, base_url=args.base_url, files=files)
    (out / "assets.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(dict(output=str(out), files=len(files), bytes=sum(item["bytes"] for item in files))))


if __name__ == "__main__": main()
