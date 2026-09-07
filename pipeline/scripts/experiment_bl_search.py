#!/usr/bin/env python3
"""Reproducible full-corpus BL retrieval experiment. All writes go to --output.

Each build/evaluation is a separate subprocess: build memory cannot contaminate
serving RSS. Empty application caches do NOT imply a cold OS/disk cache. Source
vectors and published map data are read-only. No cloud resources are created.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import time

os.environ.setdefault("OMP_NUM_THREADS", "8")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "8")
os.environ.setdefault("RAYON_NUM_THREADS", "8")
os.environ.setdefault("LANCE_CPU_THREADS", "8")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np

MODEL = "google/siglip2-so400m-patch16-256"
REVISION = "e8708ab72d125807e45b36fb7d4e0aacbb59f379"
MODEL_CACHE = Path("/data/hf/hub/models--google--siglip2-so400m-patch16-256/snapshots") / REVISION
SOURCE = Path("/data/latent-basemap/substrates/bl-siglip2-1m/substrate.f16.npy")
ROWS = Path("/data/latent-basemap/substrates/bl-siglip2-1m/rows.parquet")
PROMPTS = [
    "a map of London", "a map of India", "a map of the world", "a nautical chart",
    "a map of Africa", "a plan of a city", "a compass rose", "a mountain landscape",
    "a sailing ship at sea", "a steam locomotive", "a bridge over a river", "a lighthouse",
    "a cathedral", "a medieval castle", "a library interior", "an Egyptian pyramid",
    "a portrait of a woman", "a portrait of a man", "children playing", "a soldier on horseback",
    "a royal crown", "a suit of armour", "people dancing", "a crowded market",
    "a botanical illustration of flowers", "an oak tree", "a fern", "a mushroom",
    "an illustration of a butterfly", "a bird perched on a branch", "a lion", "an elephant",
    "a whale", "a fish", "a snake", "a dog",
    "an anatomical diagram of a skeleton", "a human skull", "a diagram of the heart", "a microscope",
    "an astronomical diagram", "the moon", "a telescope", "a geological cross section",
    "a decorative floral border", "an ornate initial letter", "a coat of arms", "a decorative scroll",
    "a book cover with gold lettering", "a leather book binding", "a title page", "a printed music score",
    "a church altar", "an angel", "a classical statue", "a ruined abbey",
    "a waterfall", "a volcano", "a desert caravan", "an arctic expedition",
    "a spinning wheel", "a windmill", "a mechanical diagram of an engine", "a hot air balloon",
]
CONFIGS = {
    "faiss-flat": ("faiss", "f32", "FLAT", 0),
    "faiss-pq72": ("faiss", "f32", "PQ", 72),
    "faiss-sq8": ("faiss", "f32", "SQ", 0),
    "lance-f32-pq72": ("lance", "f32", "IVF_PQ", 72),
    "lance-f16-flat": ("lance", "f16", "IVF_FLAT", 0),
    "lance-f16-pq72": ("lance", "f16", "IVF_PQ", 72),
    "lance-f16-pq144": ("lance", "f16", "IVF_PQ", 144),
    "lance-f16-sq8": ("lance", "f16", "IVF_SQ", 0),
    "lance-f16-hnsw-sq8": ("lance", "f16", "IVF_HNSW_SQ", 0),
    "lance-f16-dot-pq144": ("lance", "f16", "IVF_PQ", 144),
    "lance-f16-l2-pq144": ("lance", "f16", "IVF_PQ", 144),
    "lance-f16-dot-sq8": ("lance", "f16", "IVF_SQ", 0),
}


def distance_metric(name):
    return "dot" if "-dot-" in name else "l2" if "-l2-" in name else "cosine"


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def rss():
    return int(next(s for s in Path("/proc/self/status").read_text().splitlines() if s.startswith("VmRSS:")).split()[1]) * 1024


def metrics():
    return dict(rss_bytes=rss(), peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)


def sizes(path):
    files = [p for p in path.rglob("*") if p.is_file()]
    return dict(total_bytes=sum(p.stat().st_size for p in files),
                index_bytes=sum(p.stat().st_size for p in files if "_indices" in p.parts), files=len(files))


def normalize(x):
    x = np.asarray(x, dtype=np.float32)
    norm = np.linalg.norm(x, axis=1, keepdims=True)
    if not np.isfinite(x).all() or np.any(norm == 0):
        raise ValueError("Nonfinite or zero vector")
    return x / norm


def recall(ids, truth, k=24):
    return float(np.mean([len(set(a[:k]) & set(b[:k])) / k for a, b in zip(ids, truth)]))


def prepare(out):
    import faiss
    import pyarrow as pa
    import pyarrow.parquet as pq
    import torch
    from transformers import AutoTokenizer, Siglip2TextModel

    source = np.load(SOURCE, mmap_mode="r")
    n, dim = source.shape
    assert (n, dim) == (1_080_814, 1152)
    rows = pq.read_table(ROWS, columns=["subset", "fname"])
    points = pq.read_table("/data/latent-scope-3d/points/bl/points.parquet", columns=["row_id", "subset", "fname"])
    assert all(rows[key].cast(pa.string()).combine_chunks().equals(points[key].cast(pa.string()).combine_chunks())
               for key in ["subset", "fname"])
    assert np.array_equal(points["row_id"].to_numpy(), np.arange(n))
    x = np.lib.format.open_memmap(out / "vectors.f32.npy", mode="w+", dtype="float32", shape=source.shape)
    for start in range(0, n, 16384): x[start:start+16384] = normalize(source[start:start+16384])
    x.flush()
    del rows, points
    torch.set_num_threads(8)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_CACHE, local_files_only=True)
    model = Siglip2TextModel.from_pretrained(MODEL_CACHE, local_files_only=True).eval()
    text = []
    times = []
    with torch.inference_mode():
        for prompt in PROMPTS:
            started = time.perf_counter()
            result = model(**tokenizer(prompt, padding="max_length", truncation=True, max_length=64, return_tensors="pt")).pooler_output
            text.append(normalize(result.numpy())[0])
            times.append((time.perf_counter() - started) * 1000)
    model.save_pretrained(out / "text-model")
    tokenizer.save_pretrained(out / "text-model")
    model_bytes = sum(p.numel() * p.element_size() for p in model.parameters())
    del model, tokenizer
    # Draw 16 image queries per subset, held out of the index-training sample.
    counts = [61548, 217100, 416935, 385231]
    rng = np.random.default_rng(20260907)
    image_rows = np.concatenate([rng.choice(count, 16, replace=False) + sum(counts[:i]) for i, count in enumerate(counts)])
    queries = np.concatenate([np.asarray(text, dtype="float32"), x[image_rows]])
    np.save(out / "queries.npy", queries)
    np.save(out / "image-query-rows.npy", image_rows)
    # Exact float32 cosine ground truth over ALL 1.08M stored float16-source vectors.
    faiss.omp_set_num_threads(8)
    index = faiss.IndexFlatIP(dim)
    index.add(x)
    started = time.perf_counter()
    scores, ids = index.search(queries, 100)
    np.savez(out / "truth.npz", ids=ids, scores=scores)
    faiss.write_index(index, str(out / "faiss-flat.index"))
    save(out / "faiss-flat.build.json", dict(config="faiss-flat", bytes=(out / "faiss-flat.index").stat().st_size,
         note="Built during exact-ground-truth preparation; timing is not a separate build benchmark", **metrics()))
    with SOURCE.open("rb") as f: digest = hashlib.file_digest(f, "sha256").hexdigest()
    save(out / "prepare.json", dict(rows=n, dim=dim, source=str(SOURCE), source_sha256=digest,
         model=MODEL, revision=REVISION, prompts=PROMPTS, text_queries=len(text), image_queries=len(image_rows),
         source_dtype="float16", ground_truth="float32 normalized source vectors, exact IndexFlatIP",
         exact_batch_seconds=time.perf_counter()-started, encoder_weight_bytes=model_bytes,
         encoder_ms=times, threads=8, seed=20260907, versions=dict(faiss=faiss.__version__, torch=torch.__version__), **metrics()))
    print("Prepared full BL ground truth", flush=True)


def batches(x, dtype):
    import pyarrow as pa
    for start in range(0, len(x), 8192):
        a = np.asarray(x[start:start+8192], dtype=dtype)
        yield pa.RecordBatch.from_arrays([pa.array(np.arange(start, start+len(a), dtype=np.uint32)),
             pa.FixedSizeListArray.from_arrays(pa.array(a.ravel()), x.shape[1])], names=["row_id", "vector"])


def build(out, name):
    backend, dtype, kind, m = CONFIGS[name]
    x = np.load(out / "vectors.f32.npy", mmap_mode="r")
    n, dim = x.shape
    started = time.perf_counter()
    if backend == "faiss":
        import faiss
        faiss.omp_set_num_threads(8)
        if kind == "FLAT": return
        quantizer = faiss.IndexFlatIP(dim)
        if kind == "PQ": index = faiss.IndexIVFPQ(quantizer, dim, 1024, m, 8, faiss.METRIC_INNER_PRODUCT)
        else: index = faiss.IndexIVFScalarQuantizer(quantizer, dim, 1024, faiss.ScalarQuantizer.QT_8bit, faiss.METRIC_INNER_PRODUCT)
        index.cp.seed = 20260907; index.cp.niter = 20
        held = np.load(out / "image-query-rows.npy")
        candidates = np.setdiff1d(np.arange(n), held)
        training = np.random.default_rng(20260907).choice(candidates, 65536, replace=False)
        index.train(x[training])
        training_s = time.perf_counter()-started
        for start in range(0, n, 16384): index.add(x[start:start+16384])
        faiss.write_index(index, str(out / f"{name}.index"))
        result = dict(bytes=(out / f"{name}.index").stat().st_size, training_seconds=training_s, version=faiss.__version__)
    else:
        import lancedb
        import pyarrow as pa
        db = lancedb.connect(out / "lance")
        schema = pa.schema([("row_id", pa.uint32()), ("vector", pa.list_(pa.float16() if dtype == "f16" else pa.float32(), dim))])
        table = db.create_table(name, batches(x, "float16" if dtype == "f16" else "float32"), schema=schema)
        ingest_s = time.perf_counter()-started
        options = dict(metric=distance_metric(name), index_type=kind, num_partitions=1024,
                       max_iterations=20, sample_rate=64)
        if m: options.update(num_sub_vectors=m, num_bits=8)
        if "HNSW" in kind: options.update(m=16, ef_construction=100)
        table.create_index(**options)
        result = dict(**sizes(out / "lance" / f"{name}.lance"), ingest_seconds=ingest_s,
                      version=lancedb.__version__, index_options=options)
    save(out / f"{name}.build.json", dict(config=name, build_seconds=time.perf_counter()-started, **result, **metrics()))
    print(name, "built", flush=True)


def int8_probe(out):
    import lancedb
    import pyarrow as pa
    x = np.load(out / "vectors.f32.npy", mmap_mode="r")
    # Check actual signed-int8 storage and cosine index support, not uint8/Hamming.
    a = np.rint(np.asarray(x[:8192]) * 127 / np.max(np.abs(x[:8192]), axis=1, keepdims=True)).astype("int8")
    db = lancedb.connect(out / "compatibility")
    t = db.create_table("signed_int8", pa.table({"vector": pa.FixedSizeListArray.from_arrays(pa.array(a.ravel()), x.shape[1])}))
    result = dict(storage_supported=True, schema=str(t.schema), dtype="signed int8", metric="cosine")
    try:
        t.create_index(metric="cosine", index_type="IVF_SQ", num_partitions=8)
        result["results"] = t.search(np.asarray(x[0])).metric("cosine").limit(3).select([]).to_list()
        result["native_cosine_supported"] = True
    except Exception as error:
        result.update(native_cosine_supported=False, error=str(error))
    save(out / "signed-int8-compatibility.json", result)


def int8_full(out):
    """Separate quantization loss from ANN loss on the complete corpus.

    Lance stores the actual signed-int8 column. Since native cosine indexing
    rejects that type, a temporary FAISS float32 oracle searches dequantized,
    renormalized rows. This is NOT claimed to be a Lance serving workaround.
    """
    import faiss
    import lancedb
    import pyarrow as pa
    x = np.load(out / "vectors.f32.npy", mmap_mode="r")
    started = time.perf_counter()
    oracle = faiss.IndexFlatIP(x.shape[1]); faiss.omp_set_num_threads(2)
    def quantized_batches():
        for start in range(0, len(x), 8192):
            rows = x[start:start+8192]
            scale = np.max(np.abs(rows), axis=1) / 127
            codes = np.rint(rows / scale[:, None]).clip(-127, 127).astype("int8")
            oracle.add(normalize(codes.astype("float32") * scale[:, None]))
            yield pa.RecordBatch.from_arrays([pa.array(np.arange(start, start+len(rows), dtype=np.uint32)),
                pa.FixedSizeListArray.from_arrays(pa.array(codes.ravel()), x.shape[1]), pa.array(scale)],
                names=["row_id", "vector_int8", "scale"])
    db = lancedb.connect(out / "compatibility-full")
    schema = pa.schema([("row_id", pa.uint32()), ("vector_int8", pa.list_(pa.int8(), x.shape[1])), ("scale", pa.float32())])
    table = db.create_table("signed_int8", quantized_batches(), schema=schema)
    scores, ids = oracle.search(np.load(out / "queries.npy"), 24)
    truth = np.load(out / "truth.npz")["ids"]
    save(out / "signed-int8-full.json", dict(rows=table.count_rows(), quantization="per-row symmetric signed int8 plus float32 scale",
        note="Lance storage only; exact dequantized oracle is FAISS, NOT a native Lance int8 search index or latency benchmark",
        text_recall24=recall(ids[:64], truth[:64]), image_recall24=recall(ids[64:], truth[64:]),
        **sizes(out / "compatibility-full"), seconds=time.perf_counter()-started, **metrics()))


def evaluate(out, name, cache_mb, probes_list=None):
    backend, _, kind, _ = CONFIGS[name]
    queries = np.load(out / "queries.npy")
    truth = np.load(out / "truth.npz")["ids"]
    before = rss(); started = time.perf_counter()
    if backend == "faiss":
        import faiss
        faiss.omp_set_num_threads(2)
        flags = 0 if kind == "FLAT" else faiss.IO_FLAG_MMAP | faiss.IO_FLAG_READ_ONLY
        index = faiss.read_index(str(out / f"{name}.index"), flags)
        def search(q, probes, refine):
            if kind != "FLAT": index.nprobe = probes
            return index.search(q[None, :], 24)[1][0]
    else:
        import lancedb
        session = lancedb.Session(index_cache_size_bytes=cache_mb*1024**2, metadata_cache_size_bytes=32*1024**2)
        table = lancedb.connect(out / "lance", session=session).open_table(name)
        def search(q, probes, refine):
            query = table.search(q).metric(distance_metric(name)).nprobes(probes).select(["row_id", "_distance"]).limit(24)
            if "HNSW" in kind: query = query.ef(100)
            if refine: query = query.refine_factor(refine)
            return np.array(query.to_arrow()["row_id"], dtype=np.int64)
    opened = dict(open_ms=1000*(time.perf_counter()-started), rss_before=before, rss_open=rss())
    settings = [(64, 0)] if kind == "FLAT" else [(p, r) for p in (probes_list or [8, 32, 64]) for r in ([0, 4] if backend == "lance" and kind != "IVF_FLAT" else [0])]
    result = []
    for probes, refine in settings:
        times = []; found = []
        for q in queries:
            started = time.perf_counter(); ids = search(q, probes, refine)
            times.append(1000*(time.perf_counter()-started)); found.append(ids)
        result.append(dict(nprobes=probes, refine=refine, first_ms=times[0],
            p50_ms=float(np.median(times)), p95_ms=float(np.percentile(times,95)),
            text_p50_ms=float(np.median(times[:64])), text_p95_ms=float(np.percentile(times[:64],95)),
            text_recall24=recall(found[:64], truth[:64]), image_recall24=recall(found[64:], truth[64:]),
            text_recall10=recall(found[:64], truth[:64], 10),
            times_ms=times, result_ids=[a.tolist() for a in found], **metrics()))
        print(name, cache_mb, probes, refine, result[-1]["text_recall24"], result[-1]["text_p50_ms"], flush=True)
    suffix = ".extended" if probes_list else ""
    save(out / f"{name}.cache{cache_mb}{suffix}.eval.json", dict(config=name, cache_mb=cache_mb, settings=result,
         cache_note="Fresh process/application cache; OS cache uncontrolled. Later settings reuse earlier cache state.",
         threads=2, **opened))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("/data/latent-craft/experiments/bl-search-20260907a"))
    parser.add_argument("--stage", choices=["all", "prepare", "build", "evaluate", "int8", "int8-full"], default="all")
    parser.add_argument("--config", choices=CONFIGS)
    parser.add_argument("--cache-mb", type=int, default=64)
    parser.add_argument("--probes", type=int, nargs="+")
    parser.add_argument("--configs", nargs="+", choices=CONFIGS)
    parser.add_argument("--reuse-preparation", type=Path)
    args = parser.parse_args(); out = args.output; out.mkdir(parents=True, exist_ok=True)
    if args.stage in ("build", "evaluate") and not args.config: parser.error("--config is required for build/evaluate")
    if args.cache_mb < 0: parser.error("--cache-mb must be nonnegative")
    if args.probes and any(p < 1 or p > 1024 for p in args.probes): parser.error("--probes must be within 1..1024")
    if args.reuse_preparation and not (out / "prepare.json").exists():
        for name in ["prepare.json", "vectors.f32.npy", "queries.npy", "image-query-rows.npy", "truth.npz", "faiss-flat.index", "faiss-flat.build.json"]:
            source = args.reuse_preparation / name
            if not (out / name).exists(): os.link(source, out / name)
        if not (out / "text-model").exists(): (out / "text-model").symlink_to(args.reuse_preparation / "text-model", target_is_directory=True)
    if args.stage == "prepare": prepare(out)
    elif args.stage == "build": build(out, args.config)
    elif args.stage == "evaluate": evaluate(out, args.config, args.cache_mb, args.probes)
    elif args.stage == "int8": int8_probe(out)
    elif args.stage == "int8-full": int8_full(out)
    else:
        def run(stage, *extra):
            subprocess.run([sys.executable, __file__, "--output", str(out), "--stage", stage, *extra], check=True)
        if not (out / "prepare.json").exists(): run("prepare")
        if not (out / "signed-int8-compatibility.json").exists(): run("int8")
        if not (out / "signed-int8-full.json").exists(): run("int8-full")
        for name, (backend, _, _, _) in CONFIGS.items():
            if args.configs and name not in args.configs: continue
            if not (out / f"{name}.build.json").exists():
                try: run("build", "--config", name)
                except subprocess.CalledProcessError as error:
                    save(out / f"{name}.build.json", dict(error=str(error))); continue
            for cache in ([64, 512] if backend == "lance" else [0]):
                if not (out / f"{name}.cache{cache}.eval.json").exists():
                    env = os.environ.copy()
                    for key in ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "RAYON_NUM_THREADS", "LANCE_CPU_THREADS"]: env[key] = "2"
                    try:
                        subprocess.run([sys.executable, __file__, "--output", str(out), "--stage", "evaluate", "--config", name, "--cache-mb", str(cache)], env=env, check=True)
                    except subprocess.CalledProcessError as error:
                        save(out / f"{name}.cache{cache}.eval.json", dict(config=name, error=str(error), cache_mb=cache))


if __name__ == "__main__": main()
