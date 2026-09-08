#!/usr/bin/env python3
"""Upload only a checksum-verified <=2 GiB pilot to its dedicated Modal Volume."""
import argparse
import hashlib
import json
from pathlib import Path
import modal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    if len(manifest["shards"]) > 12 or sum(f["bytes"] for f in manifest["files"]) > 2*1024**3:
        raise ValueError("Refusing a full-corpus upload through the pilot tool")
    for item in manifest["files"]:
        path = Path(item["path"])
        if path.is_absolute() or ".." in path.parts: raise ValueError("Unsafe pilot path")
        with (root / path).open("rb") as stream:
            if (root / path).stat().st_size != item["bytes"] or hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                raise ValueError("Pilot checksum mismatch")
    volume = modal.Volume.from_name("latent-craft-thumbnail-pilot", create_if_missing=True, version=2)
    with volume.batch_upload() as batch:
        for item in manifest["files"]:
            batch.put_file(root / item["path"], f'/pilot-20260908/{item["path"]}')
        batch.put_file(root / "manifest.json", "/pilot-20260908/manifest.json")
    print(json.dumps({"volume": "latent-craft-thumbnail-pilot", "files": len(manifest["files"])+1,
        "bytes": sum(f["bytes"] for f in manifest["files"])+(root / "manifest.json").stat().st_size}))


if __name__ == "__main__": main()
