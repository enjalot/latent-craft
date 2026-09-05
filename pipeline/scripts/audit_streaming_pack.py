#!/usr/bin/env python3
"""Read-only streaming pack audit: hashes, partition, coordinate/thumbnail joins and proxy counts."""
import argparse
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
import pyarrow.parquet as pq


def audit(root, coordinates=None):
    raw = json.loads((root / "manifest.json").read_text())
    n = raw["point_source"]["n_points"]
    def check(path, size, digest):
        target = root / path
        assert target.stat().st_size == size, path
        with target.open("rb") as f:
            assert hashlib.file_digest(f, "sha256").hexdigest() == digest, path
    for key in ["point_index", "row_to_voxel", "proxy", "voxel_proxy"]:
        ref = raw[key]; check(ref["path"], ref["bytes"], ref["sha256"])
    rv = np.memmap(root / raw["row_to_voxel"]["path"], mode="r", dtype=np.dtype([("chunk","<u4"),("local","<u2"),("pad","<u2")]))
    seen = np.zeros(n, dtype=bool)
    count_dtype = np.dtype([("count","<u4"),("offset","<u4"),("color","u1",3),("flags","u1"),("repr","<u4")])
    occupied = atlas_bytes = gpu_rgba = max_count = 0
    for entry in raw["chunks"]:
        for prefix in ["atlas", "meta"]:
            check(entry[f"{prefix}_path"],entry[f"{prefix}_bytes"],entry[f"{prefix}_sha256"])
        ref = entry["postings"]; check(ref["path"],ref["bytes"],ref["sha256"])
        meta = (root / entry["meta_path"]).read_bytes()
        assert meta[:4] == b"LSV1" and struct.unpack_from("<H",meta,4)[0] == 2
        assert struct.unpack_from("<I",meta,6)[0] == entry["chunk_id"]
        records = np.frombuffer(meta,dtype=count_dtype,offset=32)
        assert len(records) == raw["world"]["voxels_per_chunk"] ** 3 == struct.unpack_from("<I",meta,10)[0]
        counts = records["count"]
        occupied_mask = counts > 0
        assert np.array_equal(records["offset"][occupied_mask],(np.cumsum(counts,dtype=np.uint64)-counts)[occupied_mask])
        ids = np.fromfile(root / ref["path"],dtype="<u4")
        assert counts.sum() == len(ids) == entry["n_points"]
        assert ids.max() < n and len(np.unique(ids)) == len(ids) and not seen[ids].any()
        seen[ids] = True
        assert np.all(rv["chunk"][ids] == entry["chunk_id"])
        assert np.array_equal(rv["local"][ids],np.repeat(np.arange(len(counts),dtype=np.uint16),counts))
        for local in np.flatnonzero(counts):
            a = int(records["offset"][local]); b = a + int(counts[local])
            assert records["repr"][local] in ids[a:b]
        assert np.count_nonzero(counts) == entry["n_occupied_voxels"]
        occupied += entry["n_occupied_voxels"]; atlas_bytes += entry["atlas_bytes"]
        gpu_rgba += entry["atlas_size_px"] ** 2 * 4; max_count = max(max_count,int(counts.max()))
    assert seen.all()
    hierarchy = json.loads((root / "hierarchy.json").read_text())
    assert (root / hierarchy["file"]).stat().st_size == hierarchy["bytes"]
    bricks = np.memmap(root / hierarchy["file"],mode="r",dtype=np.dtype([("xyz","<u2",3),("repr","<u2"),("count","<u4"),("color","u1",4)]))
    for node in hierarchy["nodes"]:
        for level in node["levels"]:
            a=level["offset"]//16
            assert bricks["count"][a:a+level["count"]].sum() == node["count"]
    for node in hierarchy["tree"]:
        if node["children"]: assert sum(hierarchy["tree"][i]["count"] for i in node["children"]) == node["count"]
    assert hierarchy["tree"][0]["count"] == n
    # Check every thumbnail reference against the dense points table.
    pi = np.memmap(root / raw["point_index"]["path"],mode="r",dtype=np.dtype({"names":["subset","local"],"formats":["u1","<u4"],"offsets":[0,2],"itemsize":8}))
    assert len(pi) == len(rv) == n
    cursor=0
    for batch in pq.ParquetFile(raw["point_source"]["points_table"]).iter_batches(batch_size=65536,columns=["global_idx","subset"]):
        end=cursor+len(batch)
        assert np.array_equal(pi["local"][cursor:end],batch.column("global_idx").to_numpy())
        subsets=np.array([raw["subsets"][s] for s in batch.column("subset").to_pylist()],dtype=np.uint8)
        assert np.array_equal(pi["subset"][cursor:end],subsets)
        cursor=end
    assert cursor == n
    if coordinates:
        coords=np.load(coordinates,mmap_mode="r"); assert coords.shape == (n,3)
        extent=raw["world"]["frame"]["extent"]; lo=np.array(extent[::2]); span=np.array(extent[1::2])-lo
        grid=raw["world"]["num_voxels"]; vpc=raw["world"]["voxels_per_chunk"]; side=grid//vpc
        for a in range(0,n,65536):
            normalized=(coords[a:a+65536].astype(np.float64)-lo)/span*2-1
            bins=np.clip(np.floor((normalized+1)/2*grid),0,grid-1).astype(np.uint32)
            c=bins//vpc; local=bins%vpc
            assert np.array_equal(rv["chunk"][a:a+len(bins)],c[:,0]+side*(c[:,1]+side*c[:,2]))
            assert np.array_equal(rv["local"][a:a+len(bins)],local[:,0]+vpc*(local[:,1]+vpc*local[:,2]))
    spatial=np.memmap(root / "spatial.bin",mode="r",dtype=np.dtype([("x","<u2"),("y","<u2"),("row","<u4"),("chunk","<u4"),("local","<u2"),("corpus","u1"),("pad","u1")]))
    assert len(spatial) == n
    rowxy=np.memmap(root / "row_xy.bin",mode="r",dtype="<u2",shape=(n,2)); seen[:]=False
    for a in range(0,n,65536):
        batch=spatial[a:a+65536]; rows=batch["row"]
        assert len(np.unique(rows))==len(rows) and not seen[rows].any(); seen[rows]=True
        assert np.array_equal(batch["chunk"],rv["chunk"][rows]) and np.array_equal(batch["local"],rv["local"][rows])
        assert np.array_equal(batch["x"],rowxy[rows,0]) and np.array_equal(batch["y"],rowxy[rows,1])
        assert np.array_equal(batch["corpus"],pi["subset"][rows])
    assert seen.all()
    return dict(dataset=raw["dataset_id"],points=n,occupied_voxels=occupied,chunks=len(raw["chunks"]),max_voxel_count=max_count,
        atlas_bytes=atlas_bytes,all_atlas_rgba_bytes=gpu_rgba,brick_bytes=hierarchy["bytes"],hierarchy_nodes=len(hierarchy["tree"]),
        pack_bytes=sum(p.stat().st_size for p in root.rglob("*") if p.is_file()),all_hashes_verified=True,all_row_joins_verified=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("pack",type=Path);parser.add_argument("--coordinates",type=Path)
    args=parser.parse_args();print(json.dumps(audit(args.pack,args.coordinates),indent=2))
