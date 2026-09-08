"""Resumable 128px release builder; source IDs, row order and missing spans survive.

Each shard has atomic output files and a checksum receipt. A public manifest is
written only after every shard has completed. No input files are ever modified.
"""
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
from multiprocessing import get_context
from pathlib import Path
import shutil
import struct
import time

import PIL
from PIL import features
from .thumbnail_quality import resize_thumbnail

MAX_SPAN = 1024**2
MAX_RELEASE_BYTES = 400 * 1024**3


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path: Path, value):
    temporary = path.with_name(path.name + ".partial")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.replace(path)


def digest_file(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate_source(manifest):
    if manifest.get("version") != 1 or manifest.get("encoding") != "monet-u64-offsets":
        raise ValueError("Expected a verified MONET thumbnail manifest")
    shards = manifest.get("shards")
    if not isinstance(shards, list) or not 0 < len(shards) <= 65536:
        raise ValueError("Invalid shard list")
    for entry in shards:
        if not isinstance(entry, list) or len(entry) != 2 or any(type(v) is not int for v in entry):
            raise ValueError("Invalid source shard")
        if not 0 < entry[0] <= 65536 or not 0 <= entry[1] <= entry[0] * MAX_SPAN:
            raise ValueError("Unbounded source shard")
    if sum(s[0] for s in shards) != manifest.get("rows"):
        raise ValueError("Source row count mismatch")


def validate_receipt(output, shard, rows, source_bytes, identity):
    path = output / "receipts" / f"{shard:04d}.json"
    if not path.exists():
        return None
    receipt = json.loads(path.read_text())
    if (receipt["shard"], receipt["rows"], receipt["source_bytes"], receipt["build_identity"]) != (shard, rows, source_bytes, identity):
        raise ValueError(f"Shard {shard} receipt belongs to another build")
    for suffix in ("blob", "offsets.u64"):
        artifact = output / "shards" / f"{shard:04d}.{suffix}"
        item = receipt["files"][suffix]
        if artifact.stat().st_size != item["bytes"] or digest_file(artifact) != item["sha256"]:
            raise ValueError(f"Shard {shard} output changed; refusing to overwrite completed data")
    return receipt


def convert_shard(task):
    source, output, shard, rows, source_bytes, identity = task
    receipt = validate_receipt(output, shard, rows, source_bytes, identity)
    if receipt is not None:
        return receipt
    started = time.monotonic()
    source_base = source / "shards" / f"{shard:04d}"
    offset_path = source_base.with_suffix(".offsets.u64")
    if offset_path.stat().st_size != (rows + 1) * 8:
        raise ValueError(f"Shard {shard} has invalid source offsets")
    if source_base.with_suffix(".blob").stat().st_size != source_bytes:
        raise ValueError(f"Shard {shard} source size changed")
    source_offsets = offset_path.read_bytes()
    offsets = [v[0] for v in struct.iter_unpack("<Q", source_offsets)]
    if offsets[0] != 0 or offsets[-1] != source_bytes or any(not 0 <= b-a <= MAX_SPAN for a, b in zip(offsets, offsets[1:])):
        raise ValueError(f"Shard {shard} has unbounded or invalid source spans")
    blob = output / "shards" / f"{shard:04d}.blob"
    index = output / "shards" / f"{shard:04d}.offsets.u64"
    blob_partial = blob.with_name(blob.name + ".partial")
    index_partial = index.with_name(index.name + ".partial")
    position = valid = 0
    source_hash = hashlib.sha256()
    with source_base.with_suffix(".blob").open("rb") as src, blob_partial.open("wb") as dst, index_partial.open("wb") as idx:
        idx.write(struct.pack("<Q", 0))
        for start, end in zip(offsets, offsets[1:]):
            raw = src.read(end - start)
            if len(raw) != end - start:
                raise ValueError(f"Shard {shard} truncated during read")
            source_hash.update(raw)
            data = resize_thumbnail(raw) if raw else b""
            if len(data) > MAX_SPAN:
                raise ValueError("Encoded thumbnail exceeds range contract")
            valid += bool(raw)
            dst.write(data)
            position += len(data)
            idx.write(struct.pack("<Q", position))
    blob_partial.replace(blob)
    index_partial.replace(index)
    receipt = dict(shard=shard, rows=rows, valid=valid, missing=rows-valid,
        source_bytes=source_bytes, source_sha256=source_hash.hexdigest(),
        source_offsets_sha256=hashlib.sha256(source_offsets).hexdigest(),
        build_identity=identity, completed_at=utc_now(), seconds=time.monotonic()-started,
        files={suffix: dict(bytes=path.stat().st_size, sha256=digest_file(path))
               for suffix, path in (("blob", blob), ("offsets.u64", index))})
    atomic_json(output / "receipts" / f"{shard:04d}.json", receipt)
    return receipt


def build_release(source: Path, output: Path, workers=12, limit=None, expected_rows=None):
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("Keep source and output trees separate")
    if not 1 <= workers <= 32 or (limit is not None and limit < 1):
        raise ValueError("Invalid worker or shard limit")
    source_json = (source / "manifest.json").read_bytes()
    source_manifest = json.loads(source_json)
    validate_source(source_manifest)
    if expected_rows is not None and source_manifest["rows"] != expected_rows:
        raise ValueError("Unexpected corpus row count")
    config = dict(version=1, source=str(source), source_manifest_sha256=hashlib.sha256(source_json).hexdigest(),
        size=128, quality=80, method=4, color="RGB", resample="Lanczos", pillow=PIL.__version__, webp=features.version("webp"))
    identity = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    with (output / ".build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker = output / "build.json"
        if marker.exists():
            if json.loads(marker.read_text()) != config:
                raise ValueError("Output belongs to another source or encoder; use a fresh release")
        else:
            if any(p.name != ".build.lock" for p in output.iterdir()):
                raise ValueError("Refusing to adopt an existing non-build directory")
            if shutil.disk_usage(output).free < min(MAX_RELEASE_BYTES, sum(s[1] for s in source_manifest["shards"])) + 1024**3:
                raise ValueError("Insufficient disk headroom for this release")
            atomic_json(marker, config)
        for name in ("shards", "receipts"):
            (output / name).mkdir(exist_ok=True)
        count = len(source_manifest["shards"])
        tasks = [(source, output, i, *entry, identity) for i, entry in enumerate(source_manifest["shards"])][:limit]
        completed = []
        started = time.monotonic()
        status = dict(state="building", started_at=utc_now(), total_rows=source_manifest["rows"], total_shards=count,
            workers=workers, completed_shards=0, completed_rows=0, bytes=0, source_bytes=0)
        atomic_json(output / "progress.json", status)
        try:
            # At most 2x workers queued; errors cannot leave the rest of the
            # corpus running. Only small checksum receipts cross processes.
            with ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn")) as pool:
                remaining = iter(tasks)
                pending = {pool.submit(convert_shard, task) for task in [next(remaining, None) for _ in range(workers*2)] if task is not None}
                try:
                    while pending:
                        ready, pending = wait(pending, return_when=FIRST_COMPLETED)
                        for future in ready:
                            receipt = future.result()
                            completed.append(receipt)
                            status.update(completed_shards=len(completed), updated_at=utc_now(), elapsed_seconds=time.monotonic()-started)
                            status["completed_rows"] += receipt["rows"]
                            status["source_bytes"] += receipt["source_bytes"]
                            status["bytes"] += sum(v["bytes"] for v in receipt["files"].values())
                            if status["bytes"] > MAX_RELEASE_BYTES:
                                raise ValueError("128px release exceeded its 400 GiB safety bound")
                            atomic_json(output / "progress.json", status)
                            if len(completed) % 32 == 0 or len(completed) == len(tasks):
                                print(json.dumps(status), flush=True)
                            task = next(remaining, None)
                            if task is not None:
                                pending.add(pool.submit(convert_shard, task))
                finally:
                    for future in pending:
                        future.cancel()
            if len(completed) == count:
                completed.sort(key=lambda receipt: receipt["shard"])
                manifest = dict(version=1, encoding="monet-u64-offsets", rows=source_manifest["rows"],
                    shards=[[r["rows"], r["files"]["blob"]["bytes"]] for r in completed],
                    thumbnail_size=128, build_identity=identity)
                encoded = (json.dumps(manifest, separators=(",", ":")) + "\n").encode()
                temporary = output / "manifest.json.gz.partial"
                temporary.write_bytes(gzip.compress(encoded, mtime=0))
                temporary.replace(output / "manifest.json.gz")
                atomic_json(output / "manifest.json", manifest)
                status["state"] = "complete"
            else:
                status["state"] = "partial"
        except BaseException as error:
            status.update(state="failed", error=f"{type(error).__name__}: {error}")
            raise
        finally:
            status.update(updated_at=utc_now(), elapsed_seconds=time.monotonic()-started)
            atomic_json(output / "progress.json", status)
        return status
