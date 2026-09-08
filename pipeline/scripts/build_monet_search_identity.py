#!/usr/bin/env python3
"""Join publisher ANN IDs to map rows without assuming equal row order.

Uses source shard + original ID, then the publisher's perceptual-hash lookup.
Hash collisions remain explicit one-to-many candidates, never silently picked.
Scratch joins are disk-backed; the runtime output is one u32 per ANN ID plus a
small collision table. Requires the optional duckdb and pyarrow packages.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

MISSING = 0xffffffff


def validate_dense_rows(path, column, n):
    """104 MB at 104M rows, instead of a multi-GB distinct-ID hash table."""
    seen = np.zeros(n, dtype=bool)
    count = 0
    for batch in pq.ParquetFile(path).iter_batches(batch_size=250000, columns=[column]):
        values = batch.column(0).to_numpy()
        if np.any(values < 0) or np.any(values >= n) or np.any(seen[values]) or len(np.unique(values)) != len(values):
            raise ValueError("Row join has duplicate or out-of-range IDs")
        seen[values] = True; count += len(values)
    if count != n or not seen.all(): raise ValueError("Row join is missing IDs")


def source_rows(pool, complement, output):
    paths = json.loads((complement / "full_shards.json").read_text())["shards"]
    pool_paths = json.loads((pool / "manifest.json").read_text())["shards"]
    if paths[:len(pool_paths)] != pool_paths or len(paths) > 65536:
        raise ValueError("Source shard identity mismatch")
    schema = pa.schema([("row", pa.uint32()), ("shard", pa.uint16()), ("id", pa.string())])
    count = 0
    with pq.ParquetWriter(output, schema, compression="zstd") as writer:
        ids = np.load(pool / "id.npy", mmap_mode="r")
        shards = np.load(pool / "prov_shard_idx.npy", mmap_mode="r")
        if len(ids) != len(shards): raise ValueError("Pool provenance length mismatch")
        for start in range(0, len(ids), 250000):
            stop = min(start + 250000, len(ids))
            writer.write_table(pa.Table.from_arrays([pa.array(np.arange(start, stop, dtype="uint32")),
                pa.array(shards[start:stop], type=pa.uint16()), pa.array(ids[start:stop])], schema=schema))
        count = len(ids)
        offsets = np.load(complement / "offsets.npy", mmap_mode="r")
        shards = np.load(complement / "prov_shard_idx.npy", mmap_mode="r")
        local = np.load(complement / "prov_local_row.npy", mmap_mode="r")
        if len(offsets) != len(paths) - len(pool_paths) + 1 or offsets[0] != 0 or offsets[-1] != len(shards) or len(local) != len(shards):
            raise ValueError("Complement provenance length mismatch")
        batches, buffered = [], 0
        for relative, shard in enumerate(range(len(pool_paths), len(paths))):
            start, stop = map(int, offsets[relative:relative+2])
            with np.load(complement / "light" / f"{shard:05d}.npz", allow_pickle=False) as light:
                ids = light["id"]
            if len(ids) != stop-start or np.any(shards[start:stop] != shard):
                raise ValueError("Complement source row order differs from map")
            # Light shards and consolidated embeddings preserve surviving source
            # rows, including gaps in the original per-shard local indices.
            if np.any(np.diff(local[start:stop]) <= 0): raise ValueError("Unordered source provenance")
            batches.append(pa.Table.from_arrays([pa.array(np.arange(count, count+len(ids), dtype="uint32")),
                pa.array(np.full(len(ids), shard, dtype="uint16")), pa.array(ids)], schema=schema))
            count += len(ids); buffered += len(ids)
            if buffered >= 250000:
                writer.write_table(pa.concat_tables(batches)); batches = []; buffered = 0
        if batches: writer.write_table(pa.concat_tables(batches))
    return paths, count


def join_identity(map_rows, paths, hashes, catalog, output, scratch, n):
    db = duckdb.connect()
    db.execute("SET threads=2")
    db.execute("SET memory_limit='8GB'")
    db.execute("SET preserve_insertion_order=false")
    db.execute("SET max_temp_directory_size='80GB'")
    db.execute("SET temp_directory=?", [str(scratch / "spill")])
    table = pa.table({"shard": np.arange(len(paths), dtype="uint16"),
                      "path": [p.removeprefix("v1.2.0/") for p in paths]})
    db.register("source_paths", table)
    db.read_parquet(str(map_rows)).create_view("map_rows")
    db.read_parquet(str(hashes)).create_view("ann")
    db.read_parquet(str(catalog)).create_view("catalog")
    validate_dense_rows(hashes, "row_id", n)
    if db.execute("SELECT count(*) FROM catalog").fetchone()[0] != n: raise ValueError("Publisher catalog row count differs")
    print("Joining source shard + image ID", flush=True)
    joined = scratch / "hash_to_map.parquet"
    db.execute("COPY (SELECT c.hash_perceptual, m.row FROM catalog c JOIN source_paths p ON c.local_path=p.path JOIN map_rows m ON m.shard=p.shard AND m.id=c.id) TO ? (FORMAT PARQUET, COMPRESSION ZSTD)", [str(joined)])
    db.read_parquet(str(joined)).create_view("source")
    validate_dense_rows(joined, "row", n)
    if db.execute("SELECT count(*) FROM source WHERE hash_perceptual IS NULL").fetchone()[0]:
        raise ValueError("Missing source hashes")
    print("Joining ANN hashes; preserving collisions", flush=True)
    pairs = scratch / "ann_map_pairs.parquet"
    db.execute("COPY (SELECT a.row_id::UINTEGER AS ann, s.row::UINTEGER AS row FROM ann a JOIN source s USING(hash_perceptual) ORDER BY ann,row) TO ? (FORMAT PARQUET, COMPRESSION ZSTD)", [str(pairs)])
    db.close()
    output.mkdir(parents=True, exist_ok=False)
    result = np.memmap(output / "ann_to_row.u32", mode="w+", dtype="<u4", shape=(n,))
    result[:] = MISSING
    ambiguous = {}
    last = -1
    for batch in pq.ParquetFile(pairs).iter_batches(batch_size=250000):
        ann = batch.column("ann").to_numpy(); rows = batch.column("row").to_numpy()
        unique, first, counts = np.unique(ann, return_index=True, return_counts=True)
        if len(unique) and unique[0] == last:
            key = str(last)
            ambiguous.setdefault(key, [int(result[last])]).extend(map(int, rows[:counts[0]]))
        for key, begin, count in zip(unique[counts > 1], first[counts > 1], counts[counts > 1]):
            key = str(int(key))
            if key not in ambiguous: ambiguous[key] = rows[begin:begin+count].astype(int).tolist()
        result[unique] = rows[first]
        if len(unique): last = int(unique[-1])
    if np.any(result == MISSING): raise ValueError("Some ANN IDs have no source map row")
    for key, candidates in ambiguous.items():
        candidates[:] = sorted(set(candidates))
        if len(candidates) < 2: raise ValueError("Invalid collision table")
        result[int(key)] = MISSING
    result.flush()
    (output / "ambiguous.json").write_text(json.dumps(ambiguous, separators=(",", ":")))
    with (output / "ann_to_row.u32").open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"rows": n, "exact_source_join": True, "ambiguous_ann_ids": len(ambiguous),
            "ambiguous_map_rows": len({r for rows in ambiguous.values() for r in rows}),
            "ann_to_row_sha256": digest, "encoding": "u32-map-row-or-ffffffff-ambiguity"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or args.scratch.exists(): raise FileExistsError("Use fresh immutable output and scratch paths")
    args.scratch.mkdir(parents=True)
    start = time.monotonic()
    mapping = args.scratch / "map_sources.parquet"
    paths, n = source_rows(Path("/data2/monet/pool-20m"), Path("/data2/monet/pool-complement-88m"), mapping)
    print(f"Source identity exported for {n:,} map rows", flush=True)
    root = Path("/data2/monet/retrieval-storage")
    report = join_identity(mapping, paths, root / "clip/embedding_clip-vit-base-patch32.hashes.parquet",
                           root / "index.parquet", args.output, args.scratch, n)
    report["seconds"] = time.monotonic() - start
    (args.output / "identity-report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__": main()
