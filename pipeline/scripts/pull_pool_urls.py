#!/usr/bin/env python3
"""Pull the ENTIRE MONET pool's original-image `url` + `width` + `height` columns
into per-shard parquet files keyed by the pool's own shard ordering — the
metadata half of what `pull_pool_thumbs256.py` did for the thumbnails.

Why: the Hub copy of MONET ships no full-resolution images, only the 384px
`thumbnail`. For the crawl sources (laion, cc12m, coyo, commoncatalog-cc-by,
megalith10m) the original lives at the source site, at `url`; the synthetic
sources (flux-klein, flux-schnell, z-image) have no `url` column at all — their
384px thumbnail is the largest that exists anywhere. So "show the full image on
demand" for MONET means: carry `url`/`width`/`height` per point and let the
browser fetch the original from the source site when the lightbox opens. This
pull gathers those three columns once for the whole pool (same per-shard
transfer argument as the thumbnail pull: any draw touches ~every shard, but
these columns are ~150 B/row, so the whole thing is a few GB, not 154).

Lookup contract: pool row r -> (pool-20m/prov_shard_idx[r], prov_local_row[r])
-> shards/{shard_idx:04d}.parquet row `local_row`. Shard order is IDENTICAL to
pool-20m/manifest.json["shards"], so prov_shard_idx indexes straight into it,
and each shard's row count is asserted equal to the thumbs256 store's count for
the same shard (guards against the Hub shard changing between the two pulls,
which would silently misalign every lookup).

Output (ADDITIVE ONLY — never touches pool-20m/, draws/, theirumap/,
retrieval-storage/, or random-2m/, which belong to the separate MONET eval
research project sharing this directory):
  /data2/monet/pool-20m-urls/
    manifest.json               shard list + per-shard stats (written at end)
    shards/{i:04d}.parquet      columns local_row:int32, url:string|null,
                                width:int32, height:int32 (0 = unknown), HF-shard row order
    shards/{i:04d}.done         marker -> resumable; re-run skips done shards
    shards/{i:04d}.meta.json    n_rows, n_with_url, wall time

Usage: pull_pool_urls.py [WORKERS=8] [LIMIT_SHARDS=all]
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

REPO = "jasperai/monet"
POOL_MANIFEST = Path("/data2/monet/pool-20m/manifest.json")
THUMBS_SHARDS = Path("/data2/monet/pool-20m-thumbs256/shards")
OUT = Path("/data2/monet/pool-20m-urls")
SHARDS_DIR = OUT / "shards"
WANTED = ("url", "width", "height")
HF_RETRIES = 6


def _read_columns(shard_path: str):
    """Column-projected parquet read of whichever of `url`/`width`/`height` the
    shard has (synthetic shards have no `url`), with backoff on the transient
    HTTP errors HF's hub throws under load. Returns (table, n_rows)."""
    import fsspec
    import pyarrow.parquet as pq

    fs = fsspec.filesystem("hf")
    last_err: Exception | None = None
    for attempt in range(HF_RETRIES):
        try:
            with fs.open(f"datasets/{REPO}/{shard_path}", "rb") as fh:
                pf = pq.ParquetFile(fh)
                cols = [c for c in WANTED if c in pf.schema_arrow.names]
                table = pf.read(columns=cols)
            return table, pf.metadata.num_rows
        except Exception as e:  # noqa: BLE001 — anything transient from hub/network
            last_err = e
            time.sleep(min(60, 2**attempt))
    raise RuntimeError(f"{shard_path}: giving up after {HF_RETRIES} attempts: {last_err}")


def process_shard(args: tuple[int, str]) -> dict:
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq

    shard_idx, shard_path = args
    base = SHARDS_DIR / f"{shard_idx:04d}"
    done = base.with_suffix(".done")
    if done.exists():
        return {"shard_idx": shard_idx, "skipped": True}

    t0 = time.time()
    table, n = _read_columns(shard_path)

    # Row-count guard against the thumbs256 store built from the same shard.
    thumbs_meta = THUMBS_SHARDS / f"{shard_idx:04d}.meta.json"
    if thumbs_meta.exists():
        n_thumbs = json.loads(thumbs_meta.read_text())["n_rows"]
        if n_thumbs != n:
            raise RuntimeError(f"shard {shard_idx} row count {n} != thumbs256 store's {n_thumbs} — Hub shard changed?")

    names = table.column_names
    if "url" in names:
        urls = table.column("url").to_pylist()
        urls = [u if isinstance(u, str) and u else None for u in urls]
    else:
        urls = [None] * n

    def _dim(col: str) -> np.ndarray:
        if col not in names:
            return np.zeros(n, dtype=np.int32)
        arr = table.column(col).to_numpy(zero_copy_only=False).astype("float64")
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
        return np.clip(arr, 0, 2**31 - 1).astype(np.int32)

    out = pa.table(
        {
            "local_row": pa.array(np.arange(n, dtype=np.int32)),
            "url": pa.array(urls, type=pa.string()),
            "width": pa.array(_dim("width")),
            "height": pa.array(_dim("height")),
        }
    )
    tmp = base.with_suffix(".parquet.tmp")
    pq.write_table(out, tmp, compression="zstd")
    os.replace(tmp, base.with_suffix(".parquet"))

    n_with_url = sum(1 for u in urls if u)
    meta = {
        "shard_idx": shard_idx,
        "shard_path": shard_path,
        "n_rows": n,
        "n_with_url": n_with_url,
        "has_url_column": "url" in names,
        "wall_s": round(time.time() - t0, 1),
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
        f"[urls] {len(shards)} shards total, {len(shards) - len(todo)} already done, "
        f"{len(todo)} to go, {workers} workers",
        flush=True,
    )

    t0 = time.time()
    done_count = 0
    rows = 0
    with_url = 0
    errors: list[str] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(process_shard, t): t for t in todo}
        for fut in as_completed(futs):
            shard_idx, shard_path = futs[fut]
            try:
                r = fut.result()
            except Exception as e:  # noqa: BLE001
                errors.append(f"{shard_idx} {shard_path}: {e}")
                print(f"[urls] FAILED shard {shard_idx}: {e}", flush=True)
                continue
            if r.get("skipped"):
                continue
            done_count += 1
            rows += r["n_rows"]
            with_url += r["n_with_url"]
            if done_count % 25 == 0 or done_count == len(todo):
                elapsed = time.time() - t0
                rate = done_count / elapsed if elapsed > 0 else 0
                eta = (len(todo) - done_count) / rate / 60 if rate > 0 else float("inf")
                print(
                    f"[urls] {done_count}/{len(todo)} shards  rows={rows:,}  with_url={with_url:,}  "
                    f"{rate*60:.1f} shards/min  eta~{eta:.0f}min",
                    flush=True,
                )

    per_shard = []
    for i, p in enumerate(shards):
        mp = SHARDS_DIR / f"{i:04d}.meta.json"
        per_shard.append(json.loads(mp.read_text()) if mp.exists() else {"shard_idx": i, "shard_path": p, "missing": True})
    manifest = {
        "schema": "monet-pool-urls-2026-09-04",
        "repo": REPO,
        "source_pool_manifest": str(POOL_MANIFEST),
        "shard_order": "identical to pool-20m/manifest.json['shards']; prov_shard_idx indexes into it",
        "columns": ["local_row", "url", "width", "height"],
        "n_shards": len(shards),
        "n_shards_done": sum(1 for s in per_shard if not s.get("missing")),
        "lookup": "row r -> (prov_shard_idx[r], prov_local_row[r]) -> shards/{shard_idx:04d}.parquet[local_row]",
        "shards": per_shard,
        "errors": errors,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(
        f"[urls] DONE {done_count} shards this run, {len(errors)} errors, "
        f"total wall {(time.time()-t0)/60:.1f} min",
        flush=True,
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
