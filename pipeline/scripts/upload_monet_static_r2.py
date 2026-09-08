#!/usr/bin/env python3
"""Publish the audited CLIP map, minimap and shared URL table to R2.

Uses immutable conditional PUTs. No thumbnails, source embeddings, search
weights, credentials, or repository files are included in this staging list.
"""
import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
from pathlib import Path

from upload_thumbnail_release_r2 import checked_upload, load_connection
from lsvoxel.thumbnail_release import atomic_json

PACK = "monet-clip-basemap-full-4m-20260906a-512-web-20260908b"
MINIMAP = "monet-clip-basemap-full-4m-20260906a"
METADATA = "points/monet-clip-basemap-pool-20260905a/point_meta.bin"
PREFIX = "monet/20260908b"
IDENTITY = "ca437bba419cc933455eefbf2af0b797657addce8b2d886db574e7f8f94d6c5f"


def plan(data):
    manifest = json.loads((data / "chunks" / PACK / "manifest.json").read_text())
    if manifest["row_to_voxel"]["sha256"] != IDENTITY:
        raise ValueError("Map belongs to another release")
    if (data / METADATA).stat().st_size != 1887424406:
        raise ValueError("Shared URL table size mismatch")
    files = []
    allowed = {".json", ".bin", ".u64", ".png", ".webp", ".ktx2"}
    for directory in (data / "chunks" / PACK, data / "minimap" / MINIMAP):
        for path in sorted(directory.rglob("*")):
            if path.is_file() and path.suffix in allowed:
                files.append(path)
    files.append(data / METADATA)
    if not files or sum(path.stat().st_size for path in files) > 10 * 1024**3:
        raise ValueError("Static publication exceeds its 10 GiB bound")
    # Root manifests come last, after their binary children exist.
    roots = [data / "chunks" / PACK / "manifest.json", data / "minimap" / MINIMAP / "manifest.json"]
    return [p for p in files if p not in roots], roots


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("/data/latent-scope-3d"))
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/latent-craft/r2.json")
    parser.add_argument("--state", type=Path, default=Path("/data/latent-craft/ops/monet-static-upload.json"))
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        raise ValueError("Invalid upload concurrency")
    files, roots = plan(args.data)
    state = dict(state="planned", files_total=len(files)+len(roots), files_done=0,
        bytes_total=sum(p.stat().st_size for p in files+roots), bytes_done=0, prefix=PREFIX)
    print(json.dumps(state), flush=True)
    if args.publish:
        import fcntl
        args.state.parent.mkdir(parents=True, exist_ok=True)
        with args.state.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            client, config = load_connection(args.config)
            def upload(path):
                with path.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
                size = path.stat().st_size
                checked_upload(client, config["bucket"], f"{PREFIX}/{path.relative_to(args.data).as_posix()}", path, digest, size)
                return size
            state["state"] = "uploading"
            atomic_json(args.state, state)
            try:
                with ThreadPoolExecutor(max_workers=args.workers) as pool:
                    remaining = iter(files)
                    pending = {pool.submit(upload, path) for path in [next(remaining, None) for _ in range(args.workers*2)] if path is not None}
                    try:
                        while pending:
                            ready, pending = wait(pending, return_when=FIRST_COMPLETED)
                            for future in ready:
                                state["bytes_done"] += future.result(); state["files_done"] += 1
                                atomic_json(args.state, state)
                                if state["files_done"] % 128 == 0: print(json.dumps(state), flush=True)
                                path = next(remaining, None)
                                if path is not None: pending.add(pool.submit(upload, path))
                    finally:
                        for future in pending: future.cancel()
                for path in roots:
                    state["bytes_done"] += upload(path); state["files_done"] += 1
                state["state"] = "complete"
            except BaseException as error:
                state.update(state="failed", error=type(error).__name__)
                raise
            finally:
                atomic_json(args.state, state)
            print(json.dumps(state), flush=True)
