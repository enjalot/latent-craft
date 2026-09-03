#!/usr/bin/env python3
"""Pull the ENTIRE MONET pool's thumbnails, downscaled to 256px longest-side,
into a packed blob+offsets store keyed by the pool's own shard ordering.

Why the whole pool rather than one research draw: a draw is uniform over the
19.3M-row pool, so the `random` draw alone touches 2,012 of the pool's 2,015 HF
shards (~1,000 scattered rows each). Parquet reads are row-group granular, so
pulling ANY draw's thumbnails means reading essentially every shard's whole
thumbnail column anyway — the transfer cost is per-shard, not per-row. Pulling
everything once therefore costs about the same transfer as one arm and covers
every current and future draw (random, sscd, annfaiss, theirfaiss, ...) with no
re-download. Downscaling 384->256 on ingest keeps disk to roughly a third.

Lookup contract: pool row r -> (pool-20m/prov_shard_idx[r], prov_local_row[r])
-> shards/{shard_idx:04d}.offsets.u64[local_row : local_row+2] -> byte range in
shards/{shard_idx:04d}.blob. Shard order is IDENTICAL to pool-20m/manifest.json
["shards"], so prov_shard_idx indexes straight into it.

Output (ADDITIVE ONLY — never touches pool-20m/, draws/, theirumap/,
retrieval-storage/, or random-2m/, which belong to the separate MONET eval
research project sharing this directory):
  /data2/monet/pool-20m-thumbs256/
    manifest.json               shard list + params + per-shard stats (written at end)
    shards/{i:04d}.blob         concatenated webp bytes, HF-shard row order
    shards/{i:04d}.offsets.u64  n_rows+1 cumulative byte offsets (uint64 LE)
    shards/{i:04d}.done         marker -> resumable; re-run skips done shards
    shards/{i:04d}.meta.json    n_rows, n_failed_decode, bytes, wall time

A row whose thumbnail fails to decode gets a ZERO-LENGTH span (offset[i+1] ==
offset[i]) so offsets stay dense and lookups never mis-index; failures are
counted per shard rather than aborting the shard.

CPU note: decode+resize+re-encode is the real cost (~19M images). Meant to run
under `nice` (see the systemd-run launch) so the research project's active
faiss jobs keep CPU priority; it just takes longer while they're busy.

Usage: pull_pool_thumbs256.py [WORKERS=8] [LIMIT_SHARDS=all]
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

REPO = "jasperai/monet"
POOL_MANIFEST = Path("/data2/monet/pool-20m/manifest.json")
OUT = Path("/data2/monet/pool-20m-thumbs256")
SHARDS_DIR = OUT / "shards"
MAX_SIDE = 256
WEBP_QUALITY = 80
HF_RETRIES = 6


def _read_thumbnail_column(shard_path: str) -> list[bytes | None]:
    """Column-projected parquet read of just `thumbnail`, with backoff on the
    transient HTTP errors HF's hub throws under load."""
    import fsspec
    import pyarrow.parquet as pq

    fs = fsspec.filesystem("hf")
    last_err: Exception | None = None
    for attempt in range(HF_RETRIES):
        try:
            with fs.open(f"datasets/{REPO}/{shard_path}", "rb") as fh:
                table = pq.read_table(fh, columns=["thumbnail"])
            return table.column("thumbnail").to_pylist()
        except Exception as e:  # noqa: BLE001 — anything transient from hub/network
            last_err = e
            time.sleep(min(60, 2**attempt))
    raise RuntimeError(f"{shard_path}: giving up after {HF_RETRIES} attempts: {last_err}")


def _downscale_webp(raw: bytes) -> bytes | None:
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(raw))
        im = im.convert("RGB")
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)  # preserves aspect, longest side <= MAX_SIDE
        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=WEBP_QUALITY, method=4)
        return buf.getvalue()
    except Exception:  # noqa: BLE001 — a bad image must not kill the shard
        return None


def process_shard(args: tuple[int, str]) -> dict:
    shard_idx, shard_path = args
    base = SHARDS_DIR / f"{shard_idx:04d}"
    done = base.with_suffix(".done")
    if done.exists():
        return {"shard_idx": shard_idx, "skipped": True}

    t0 = time.time()
    thumbs = _read_thumbnail_column(shard_path)
    n = len(thumbs)

    offsets = np.zeros(n + 1, dtype="<u8")
    chunks: list[bytes] = []
    n_failed = 0
    total = 0
    for i, raw in enumerate(thumbs):
        out = _downscale_webp(raw) if raw else None
        if out is None:
            n_failed += 1
            out = b""
        chunks.append(out)
        total += len(out)
        offsets[i + 1] = total

    # write atomically: tmp then rename, so a crash mid-write can't leave a
    # partial blob that later reads as a valid (short) file
    blob_tmp = base.with_suffix(".blob.tmp")
    with open(blob_tmp, "wb") as f:
        for c in chunks:
            f.write(c)
    os.replace(blob_tmp, base.with_suffix(".blob"))
    off_tmp = base.with_suffix(".offsets.u64.tmp")
    offsets.tofile(off_tmp)
    os.replace(off_tmp, base.with_suffix(".offsets.u64"))

    wall = time.time() - t0
    meta = {
        "shard_idx": shard_idx,
        "shard_path": shard_path,
        "n_rows": n,
        "n_failed_decode": n_failed,
        "bytes": total,
        "wall_s": round(wall, 1),
    }
    base.with_suffix(".meta.json").write_text(json.dumps(meta))
    done.touch()
    return {**meta, "skipped": False}


def main() -> int:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else None

    pool = json.loads(POOL_MANIFEST.read_text())
    shards: list[str] = pool["shards"]
    if limit is not None:
        shards = shards[:limit]
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)

    todo = [(i, p) for i, p in enumerate(shards) if not (SHARDS_DIR / f"{i:04d}.done").exists()]
    print(
        f"[thumbs256] {len(shards)} shards total, {len(shards) - len(todo)} already done, "
        f"{len(todo)} to go, {workers} workers",
        flush=True,
    )

    t0 = time.time()
    done_count = 0
    rows = 0
    bytes_total = 0
    failed = 0
    errors: list[str] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(process_shard, t): t for t in todo}
        for fut in as_completed(futs):
            shard_idx, shard_path = futs[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001
                errors.append(f"{shard_idx} {shard_path}: {e}")
                print(f"[thumbs256] FAILED shard {shard_idx}: {e}", flush=True)
                continue
            if r.get("skipped"):
                continue
            done_count += 1
            rows += r["n_rows"]
            bytes_total += r["bytes"]
            failed += r["n_failed_decode"]
            if done_count % 10 == 0 or done_count == len(todo):
                elapsed = time.time() - t0
                rate = done_count / elapsed if elapsed > 0 else 0
                eta = (len(todo) - done_count) / rate / 60 if rate > 0 else float("inf")
                print(
                    f"[thumbs256] {done_count}/{len(todo)} shards  rows={rows:,}  "
                    f"out={bytes_total/1e9:.1f}GB  failed_decode={failed}  "
                    f"{rate*60:.1f} shards/min  eta~{eta:.0f}min",
                    flush=True,
                )

    # manifest: assembled from per-shard meta so it's correct across resumes
    per_shard = []
    for i, p in enumerate(shards):
        mp = SHARDS_DIR / f"{i:04d}.meta.json"
        per_shard.append(json.loads(mp.read_text()) if mp.exists() else {"shard_idx": i, "shard_path": p, "missing": True})
    manifest = {
        "schema": "monet-pool-thumbs256-2026-09-03",
        "repo": REPO,
        "source_pool_manifest": str(POOL_MANIFEST),
        "shard_order": "identical to pool-20m/manifest.json['shards']; prov_shard_idx indexes into it",
        "max_side_px": MAX_SIDE,
        "format": "webp",
        "webp_quality": WEBP_QUALITY,
        "n_shards": len(shards),
        "n_shards_done": sum(1 for s in per_shard if not s.get("missing")),
        "lookup": "row r -> (prov_shard_idx[r], prov_local_row[r]) -> offsets[local_row:local_row+2] -> blob slice",
        "shards": per_shard,
        "errors": errors,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(
        f"[thumbs256] DONE {done_count} shards this run, {len(errors)} errors, "
        f"total wall {(time.time()-t0)/60:.1f} min",
        flush=True,
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
