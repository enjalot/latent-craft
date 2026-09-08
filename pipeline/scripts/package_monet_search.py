#!/usr/bin/env python3
"""Package the existing disk FAISS index and prove map-row identity samples.

Perceptual-hash collisions are refined by comparing exact stored IVF/PQ codes
against the original row's CLIP vector. Never resolve a collision by row order.
Unresolved identical-code collisions remain explicit and are omitted by search.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

import faiss
import numpy as np
import torch
from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast


def digest(path):
    with path.open("rb") as stream: return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_codes(index, mapping, collisions):
    rng = np.random.default_rng(20260908)
    samples = np.unique(np.concatenate(([0, len(mapping)-1], rng.integers(0, len(mapping), 1024))))
    wanted = np.unique(np.concatenate((samples, np.array(list(map(int, collisions)), dtype="int64"))))
    codes = {}
    lists = index.invlists
    for list_id in range(index.nlist):
        count = lists.list_size(list_id)
        ids_pointer, code_pointer = lists.get_ids(list_id), lists.get_codes(list_id)
        try:
            ids = faiss.rev_swig_ptr(ids_pointer, count)
            found = np.flatnonzero(np.isin(ids, wanted, kind="sort"))
            if len(found):
                data = faiss.rev_swig_ptr(code_pointer, count*index.code_size).reshape(count, index.code_size)
                prefix = list_id.to_bytes(index.sa_code_size()-index.code_size, "little")
                for slot in found: codes[int(ids[slot])] = prefix + data[slot].tobytes()
        finally:
            lists.release_ids(list_id, ids_pointer); lists.release_codes(list_id, code_pointer)
    if set(codes) != set(map(int, wanted)): raise ValueError("ANN sample IDs absent from inverted lists")
    pool = np.load("/data2/monet/pool-20m/clip512.f32.npy", mmap_mode="r")
    complement = np.load("/data2/monet/pool-complement-88m/clip512.f32.npy", mmap_mode="r")
    if len(pool)+len(complement) != len(mapping): raise ValueError("Embedding/map row layout differs")
    def encode(row):
        vector = pool[row] if row < len(pool) else complement[row-len(pool)]
        return index.sa_encode(np.asarray(vector, dtype="float32")[None, :]).tobytes()
    checked = 0
    for ann in samples:
        row = int(mapping[ann])
        if row == 0xffffffff: continue
        if encode(row) != codes[int(ann)]: raise ValueError(f"Original vector differs from indexed code at ANN ID {ann}, map row {row}")
        checked += 1
    unresolved = {}
    for ann, candidates in collisions.items():
        matched = [row for row in candidates if encode(row) == codes[int(ann)]]
        if not matched: raise ValueError(f"No source vector matches collided ANN code {ann}")
        if len(matched) == 1: mapping[int(ann)] = matched[0]
        else: unresolved[ann] = matched
    return {"exact_code_samples": checked, "collided_ann_ids": len(collisions),
            "resolved_ann_ids": len(collisions)-len(unresolved), "unresolved": unresolved}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--index", type=Path, default=Path("/data2/monet/retrieval-storage/clip/embedding_clip-vit-base-patch32.faiss"))
    args = parser.parse_args()
    if args.output.exists(): raise FileExistsError("Use a fresh immutable release")
    torch.set_num_threads(2); faiss.omp_set_num_threads(2)
    manifest = json.loads((args.pack / "manifest.json").read_text())
    identity = json.loads((args.identity / "identity-report.json").read_text())
    if manifest["dataset_id"] != "monet-clip-basemap-full-4m-20260906a" or identity["rows"] != manifest["point_source"]["n_points"]:
        raise ValueError("Wrong CLIP projection or row join")
    if not identity["exact_source_join"] or digest(args.identity / "ann_to_row.u32") != identity["ann_to_row_sha256"]:
        raise ValueError("Identity artifact changed")
    for key, encoding in (("point_index", "point-u32-u8"), ("row_to_voxel", "voxel-u32")):
        if manifest[key].get("encoding") != encoding or digest(args.pack / manifest[key]["path"]) != manifest[key]["sha256"]:
            raise ValueError("Map lookup identity/encoding differs")
    args.output.mkdir(parents=True)
    index = faiss.read_index(str(args.index), faiss.IO_FLAG_MMAP | faiss.IO_FLAG_READ_ONLY)
    if (index.ntotal, index.d, index.nlist, index.pq.M, index.pq.nbits, index.metric_type) != (identity["rows"], 512, 4096, 64, 8, faiss.METRIC_INNER_PRODUCT):
        raise ValueError("Unexpected FAISS model/index")
    if type(faiss.downcast_InvertedLists(index.invlists)).__name__ != "OnDiskInvertedLists":
        raise ValueError("Index did not open with disk-backed inverted lists")
    shutil.copyfile(args.identity / "ann_to_row.u32", args.output / "ann_to_row.u32")
    mapping = np.memmap(args.output / "ann_to_row.u32", mode="r+", dtype="<u4")
    report = verify_codes(index, mapping, json.loads((args.identity / "ambiguous.json").read_text()))
    mapping.flush()
    if report["unresolved"]: raise ValueError("Resolve remaining ANN identities before public full-corpus search")
    seen = np.zeros(len(mapping), dtype=bool)
    for start in range(0, len(mapping), 250000):
        rows = mapping[start:start+250000]
        if np.any(rows >= len(mapping)) or np.any(seen[rows]) or len(np.unique(rows)) != len(rows):
            raise ValueError("Final ANN/map join is not one-to-one")
        seen[rows] = True
    if not seen.all(): raise ValueError("Final ANN/map join is incomplete")
    report["final_mapping_is_permutation"] = True
    report["source_join_ann_to_row_sha256"] = identity["ann_to_row_sha256"]
    report["ann_to_row_sha256"] = digest(args.output / "ann_to_row.u32")
    print(json.dumps(report, indent=2), flush=True)
    (args.output / "identity-report.json").write_text(json.dumps({**identity, **report}, indent=2))
    # Linked bytes are immutable; this release only edits its private row map.
    for source, name in ((args.index, "clip-ivfpq.index"), (args.pack / "point_index.bin", "point_index.bin"),
                         (args.pack / "row_to_voxel.bin", "row_to_voxel.bin")):
        try: os.link(source, args.output / name)
        except OSError: shutil.copyfile(source, args.output / name)
    model = CLIPTextModelWithProjection.from_pretrained(args.model, local_files_only=True).eval()
    tokenizer = CLIPTokenizerFast.from_pretrained(args.model, local_files_only=True)
    model.save_pretrained(args.output / "text-model"); tokenizer.save_pretrained(args.output / "text-model")
    with torch.inference_mode():
        check = torch.nn.functional.normalize(model(**tokenizer("a red sports car", return_tensors="pt", truncation=True, max_length=77)).text_embeds, dim=-1).numpy()[0]
    np.save(args.output / "text-check.npy", check)
    service = dict(dataset="monet-clip-basemap-full-4m-512", release=manifest["dataset_id"],
        identity=manifest["row_to_voxel"]["sha256"], rows=index.ntotal, nprobe=64,
        unresolved_ann_ids=len(report["unresolved"]), index_type="IVF4096,PQ64x8", embedding="openai/clip-vit-base-patch32",
        model_revision="3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268")
    (args.output / "service.json").write_text(json.dumps(service, indent=2))
    assets = [{"path": str(p.relative_to(args.output)), "bytes": p.stat().st_size, "sha256": digest(p)}
              for p in sorted(args.output.rglob("*")) if p.is_file()]
    (args.output / "assets.json").write_text(json.dumps({"version": 1, "files": assets}, indent=2))
    print(json.dumps({"files": len(assets), "bytes": sum(a["bytes"] for a in assets), "output": str(args.output)}), flush=True)


if __name__ == "__main__": main()
