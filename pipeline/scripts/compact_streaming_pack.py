#!/usr/bin/env python3
"""Storage-only immutable publication pack: compact lookups, sparse summaries, gzip JSON.

Original geometry, atlas ordering, postings, 2D positions and image IDs are unchanged.
Run verify_fullcorpus_monet.py on the result before registering/deploying it.
"""
import argparse
import gzip
import json
import os
import errno
import shutil
from pathlib import Path
import struct
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import numpy as np
from lsvoxel.chunkpack.metablob import HEADER_DTYPE, WIDE_VOXEL_RECORD_DTYPE, SPARSE_VOXEL_RECORD_DTYPE
from lsvoxel.chunkpack.pointindex import POINT_INDEX_DTYPE
from lsvoxel.chunkpack.row_to_voxel import ROW_TO_VOXEL_DTYPE
from lsvoxel.chunkpack.streaming import blob
from lsvoxel.chunkpack.manifest import validate_manifest

COMPACT_POINT_DTYPE = np.dtype([("local_idx", "<u4"), ("subset_code", "u1")])

def sparse_summary(raw):
    if len(raw) < 32:
        raise ValueError("Truncated summary")
    head = np.frombuffer(raw[:32], dtype=HEADER_DTYPE)[0]
    if bytes(head["magic"]) != b"LSV1" or int(head["version"]) != 2:
        raise ValueError("Compaction requires v2 summaries with separate postings")
    n = int(head["n_voxel_records"])
    if n > 65536 or len(raw) != 32 + 16*n:
        raise ValueError("Invalid dense summary")
    records = np.frombuffer(raw, dtype=WIDE_VOXEL_RECORD_DTYPE, offset=32)
    ids = np.flatnonzero(records["count"])
    if len(ids)*18 >= n*16:
        return raw, 2
    header = bytearray(raw[:32]); struct.pack_into("<H", header, 4, 3); struct.pack_into("<I", header, 22, len(ids))
    output = np.empty(len(ids), dtype=SPARSE_VOXEL_RECORD_DTYPE)
    output["local"], output["record"] = ids, records[ids]
    return bytes(header) + output.tobytes(), 3

def compact(source: Path, output: Path):
    source, output = source.resolve(), output.resolve()
    if output == source or source in output.parents:
        raise ValueError("Output must be outside the immutable input release")
    if output.exists():
        raise FileExistsError("Use a fresh immutable release")
    validate_manifest(source)
    manifest = json.loads((source / "manifest.json").read_text())
    if not manifest.get("streaming") or manifest["world"]["voxels_per_chunk"] != 16 or manifest["world"]["chunks_per_axis"] ** 3 > 2**20:
        raise ValueError("Packed voxel encoding requires a streamed 16³-chunk grid fitting 20-bit chunk IDs")
    if manifest["point_index"].get("encoding") or manifest["row_to_voxel"].get("encoding"):
        raise ValueError("Input is already compact")
    n = manifest["point_source"]["n_points"]
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.building-", dir=output.parent))
    changed = {manifest[key]["path"] for key in ("point_index", "row_to_voxel")}
    changed.update(c["meta_path"] for c in manifest["chunks"])
    for path in source.rglob("*"):
        if not path.is_file(): continue
        name = str(path.relative_to(source)); target = stage / name
        if name in changed or name == "manifest.json" or name.endswith(".gz"): continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix == ".json":
            target.write_text(json.dumps(json.loads(path.read_text()), separators=(",", ":")))
        else:
            try:
                os.link(path, target)  # Immutable input; unchanged tables need no second copy on the same volume.
            except OSError as error:
                if error.errno != errno.EXDEV: raise
                shutil.copyfile(path, target)
    for key, dtype, out_dtype, encoding in (("point_index", POINT_INDEX_DTYPE, COMPACT_POINT_DTYPE, "point-u32-u8"),
                                          ("row_to_voxel", ROW_TO_VOXEL_DTYPE, np.dtype("<u4"), "voxel-u32")):
        ref = manifest[key]
        src = np.memmap(source / ref["path"], dtype=dtype, mode="r")
        if len(src) != n: raise ValueError("Lookup row count mismatch")
        target = stage / ref["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as stream:
            for start in range(0, n, 1_000_000):
                batch = src[start:start+1_000_000]
                if key == "point_index":
                    data = np.empty(len(batch), dtype=out_dtype)
                    data["local_idx"], data["subset_code"] = batch["local_idx"], batch["subset_code"]
                else:
                    if np.any(batch["chunk_id"] >= 2**20) or np.any(batch["local_voxel_id"] >= 4096): raise ValueError("Voxel address overflow")
                    data = (batch["chunk_id"] << 12) | batch["local_voxel_id"].astype("<u4")
                stream.write(data.tobytes())
        manifest[key] = {**blob(target, stage), "encoding": encoding}
        print(f"Compacted {key}: {target.stat().st_size:,} bytes", flush=True)
    sparse = 0
    for chunk in manifest["chunks"]:
        target = stage / chunk["meta_path"]; target.parent.mkdir(parents=True, exist_ok=True)
        raw, version = sparse_summary((source / chunk["meta_path"]).read_bytes())
        target.write_bytes(raw); chunk["meta_version"] = version; sparse += version == 3
        chunk.update({f"meta_{k}": v for k,v in blob(target, stage).items()})
    manifest["save_identity"] = manifest.get("save_identity", f"/chunks/{source.name}")
    (stage / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    for path in stage.rglob("*.json"):
        path.with_suffix(path.suffix + ".gz").write_bytes(gzip.compress(path.read_bytes(), compresslevel=9, mtime=0))
    validate_manifest(stage)
    stage.rename(output)
    result = dict(source=str(source), output=str(output), points=n, sparse_chunks=sparse,
        original_bytes=sum(p.stat().st_size for p in source.rglob("*") if p.is_file()),
        publication_bytes=sum(p.stat().st_size for p in output.rglob("*") if p.is_file()))
    print(json.dumps(result, indent=2), flush=True)
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("source", type=Path); parser.add_argument("output", type=Path)
    args = parser.parse_args(); compact(args.source, args.output)
