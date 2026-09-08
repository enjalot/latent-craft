#!/usr/bin/env python3
"""Publish a complete, verified 128px release to immutable R2 object names.

No bucket/DNS/IAM changes, overwrites, corpus recompression or deletion. A dry
run is the default; --publish enables uploads. The manifest is uploaded last.
"""
import argparse
import base64
from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import hashlib
import json
import mimetypes
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from lsvoxel.thumbnail_release import MAX_RELEASE_BYTES, atomic_json, validate_source


def load_connection(path):
    if path.stat().st_mode & 0o077:
        raise ValueError("R2 credential file must be private (chmod 600)")
    config = json.loads(path.read_text())
    if not re.fullmatch(r"[a-fA-F0-9]{32}", config.get("account_id", "")):
        raise ValueError("Invalid R2 account")
    import boto3
    from botocore.config import Config
    client = boto3.client("s3", endpoint_url=f'https://{config["account_id"]}.r2.cloudflarestorage.com',
        aws_access_key_id=config["access_key_id"], aws_secret_access_key=config["secret_access_key"], region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"}, max_pool_connections=8,
            connect_timeout=15, read_timeout=120, request_checksum_calculation="when_required", response_checksum_validation="when_required"))
    return client, config


def checked_upload(client, bucket, key, path, expected_sha, expected_bytes):
    from botocore.exceptions import ClientError
    sha, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        while block := stream.read(1024**2):
            sha.update(block); md5.update(block)
        if path.stat().st_size != expected_bytes or sha.hexdigest() != expected_sha:
            raise ValueError(f"Local artifact changed: {path.name}")
        try:
            existing = client.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response["Error"]["Code"] not in ("404", "NoSuchKey", "NotFound"):
                raise
        else:
            if existing["ContentLength"] != expected_bytes or existing.get("Metadata", {}).get("sha256") != expected_sha or existing.get("ContentEncoding"):
                raise FileExistsError(f"Refusing to overwrite a different or encoded object: {key}")
            return "existing"
        if expected_bytes > 5 * 1024**3:
            raise ValueError("Thumbnail object exceeds the single-PUT limit")
        stream.seek(0)
        client.put_object(Bucket=bucket, Key=key, Body=stream, ContentLength=expected_bytes, IfNoneMatch="*",
            ContentMD5=base64.b64encode(md5.digest()).decode(), Metadata={"sha256": expected_sha},
            ContentType=mimetypes.guess_type(key)[0] or "application/octet-stream",
            CacheControl="public, max-age=31536000, immutable" + ("" if key.endswith(".json") else ", no-transform"))
    result = client.head_object(Bucket=bucket, Key=key)
    if result["ContentLength"] != expected_bytes or result.get("Metadata", {}).get("sha256") != expected_sha or result.get("ContentEncoding"):
        raise ValueError(f"Remote verification failed: {key}")
    return "uploaded"


def artifacts(root):
    progress = json.loads((root / "progress.json").read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    validate_source(manifest)
    if progress["state"] != "complete" or progress["completed_rows"] != manifest["rows"] or manifest.get("thumbnail_size") != 128:
        raise ValueError("Release is not a complete 128px corpus")
    if manifest["rows"] != 103816750 or len(manifest["shards"]) != 10880:
        raise ValueError("Refusing a partial or unexpected MONET corpus")
    result = []
    for i, (rows, size) in enumerate(manifest["shards"]):
        receipt = json.loads((root / "receipts" / f"{i:04d}.json").read_text())
        if receipt["shard"] != i or receipt["rows"] != rows or receipt["build_identity"] != manifest["build_identity"]:
            raise ValueError("Receipt identity mismatch")
        for suffix, expected in (("blob", size), ("offsets.u64", (rows+1)*8)):
            path = root / "shards" / f"{i:04d}.{suffix}"
            item = receipt["files"][suffix]
            if path.stat().st_size != expected or item["bytes"] != expected:
                raise ValueError("Receipt byte size mismatch")
            result.append((path, item["sha256"], expected))
    if sum(item[2] for item in result) > MAX_RELEASE_BYTES:
        raise ValueError("Release exceeds 400 GiB publication bound")
    return result


def follow_upload(root, client, config, prefix, workers):
    """Upload atomic completed shards while encoding continues; manifest last."""
    build = json.loads((root / "build.json").read_text())
    build_identity = hashlib.sha256(json.dumps(build, sort_keys=True).encode()).hexdigest()
    source_json = (Path(build["source"]) / "manifest.json").read_bytes()
    if hashlib.sha256(source_json).hexdigest() != build["source_manifest_sha256"]:
        raise ValueError("Source manifest changed")
    source = json.loads(source_json)
    validate_source(source)
    if source["rows"] != 103816750 or len(source["shards"]) != 10880 or build["size"] != 128:
        raise ValueError("Not the approved full 128px MONET build")
    state = dict(state="uploading", files_total=2*len(source["shards"])+1, files_done=0, bytes_done=0, prefix=prefix, bucket=config["bucket"])
    seen, queue, pending = set(), deque(), set()
    planned_bytes = 0
    def upload(item):
        path, digest, size = item
        checked_upload(client, config["bucket"], f"{prefix}/{path.relative_to(root).as_posix()}", path, digest, size)
        return size
    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            try:
                while True:
                    progress = json.loads((root / "progress.json").read_text())
                    if progress["state"] == "failed":
                        raise ValueError("Local conversion failed; no manifest will be published")
                    for path in (root / "receipts").iterdir():
                        if not re.fullmatch(r"\d{4,5}\.json", path.name) or path.name in seen:
                            continue
                        receipt = json.loads(path.read_text())
                        shard = int(path.stem)
                        if not 0 <= shard < len(source["shards"]):
                            raise ValueError("Unexpected completed shard")
                        rows, source_bytes = source["shards"][shard]
                        if (receipt["shard"], receipt["rows"], receipt["source_bytes"], receipt["build_identity"]) != (shard, rows, source_bytes, build_identity):
                            raise ValueError("Completed shard identity mismatch")
                        for suffix in ("blob", "offsets.u64"):
                            item = receipt["files"][suffix]
                            file = root / "shards" / f"{shard:04d}.{suffix}"
                            if file.stat().st_size != item["bytes"] or not 0 <= item["bytes"] <= 5*1024**3:
                                raise ValueError("Completed artifact size mismatch")
                            if suffix == "offsets.u64" and item["bytes"] != (rows+1)*8:
                                raise ValueError("Completed offset table row mismatch")
                            planned_bytes += item["bytes"]
                            if planned_bytes > MAX_RELEASE_BYTES:
                                raise ValueError("Release exceeds 400 GiB publication bound")
                            queue.append((file, item["sha256"], item["bytes"]))
                        seen.add(path.name)
                    while queue and len(pending) < workers*2:
                        pending.add(pool.submit(upload, queue.popleft()))
                    if pending:
                        ready, pending = wait(pending, timeout=5, return_when=FIRST_COMPLETED)
                        for future in ready:
                            state["bytes_done"] += future.result()
                            state["files_done"] += 1
                        state["state"] = "uploading"
                    elif progress["state"] == "complete":
                        if len(seen) != len(source["shards"]):
                            raise ValueError("Completed build lacks all shard receipts")
                        artifacts(root)  # Full-corpus row, manifest and receipt preflight.
                        manifest = root / "manifest.json"
                        with manifest.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
                        checked_upload(client, config["bucket"], f"{prefix}/manifest.json", manifest, digest, manifest.stat().st_size)
                        state.update(state="complete", files_done=state["files_total"])
                        break
                    else:
                        state["state"] = "waiting for converted shards"
                        time.sleep(5)
                    state["updated_at"] = time.time()
                    atomic_json(root / "upload-progress.json", state)
            finally:
                for future in pending: future.cancel()
    except BaseException as error:
        state.update(state="failed", error=type(error).__name__)
        raise
    finally:
        state["updated_at"] = time.time()
        atomic_json(root / "upload-progress.json", state)
    return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--prefix", default="monet/thumbs/full-128-20260908a")
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/latent-craft/r2.json")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--follow", action="store_true", help="Upload completed shards while conversion runs; requires --publish")
    args = parser.parse_args()
    root = args.root.resolve()
    if not re.fullmatch(r"monet/thumbs/full-128-[a-z0-9-]+", args.prefix) or not 1 <= args.workers <= 8:
        raise ValueError("Invalid immutable prefix or concurrency")
    if args.follow:
        if not args.publish: parser.error("--follow requires explicit --publish")
        import fcntl
        with (root / ".upload.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            client, config = load_connection(args.config)
            print(json.dumps(follow_upload(root, client, config, args.prefix, args.workers)), flush=True)
        raise SystemExit(0)
    files = artifacts(root)
    print(json.dumps(dict(files=len(files)+1, bytes=sum(f[2] for f in files), prefix=args.prefix, publish=args.publish)), flush=True)
    if args.publish:
        import fcntl
        with (root / ".upload.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            client, config = load_connection(args.config)
            state = dict(state="uploading", files_total=len(files)+1, files_done=0, bytes_done=0,
                prefix=args.prefix, bucket=config["bucket"])
            atomic_json(root / "upload-progress.json", state)
            def upload(item):
                path, digest, size = item
                return checked_upload(client, config["bucket"], f"{args.prefix}/{path.relative_to(root).as_posix()}", path, digest, size), size
            try:
                with ThreadPoolExecutor(max_workers=args.workers) as pool:
                    remaining = iter(files)
                    pending = {pool.submit(upload, item) for item in [next(remaining, None) for _ in range(args.workers*2)] if item is not None}
                    try:
                        while pending:
                            ready, pending = wait(pending, return_when=FIRST_COMPLETED)
                            for future in ready:
                                disposition, size = future.result()
                                state["files_done"] += 1; state["bytes_done"] += size
                                atomic_json(root / "upload-progress.json", state)
                                if state["files_done"] % 64 == 0: print(json.dumps(state), flush=True)
                                item = next(remaining, None)
                                if item is not None: pending.add(pool.submit(upload, item))
                    finally:
                        for future in pending: future.cancel()
                manifest_path = root / "manifest.json"
                with manifest_path.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
                checked_upload(client, config["bucket"], f"{args.prefix}/manifest.json", manifest_path, digest, manifest_path.stat().st_size)
                state.update(state="complete", files_done=len(files)+1)
            except BaseException as error:
                state.update(state="failed", error=type(error).__name__)
                raise
            finally:
                atomic_json(root / "upload-progress.json", state)
            print(json.dumps(state), flush=True)
