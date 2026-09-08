#!/usr/bin/env python3
"""Small real-HTTP pilot: verify every measured image and report client/server latency."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import random
import statistics
import struct
import threading
import time
import requests


def summary(values):
    ordered = sorted(values)
    return {"n": len(values), "p50_ms": statistics.median(values), "p95_ms": ordered[min(len(ordered)-1, int(len(ordered)*.95))], "max_ms": max(values)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--count", type=int, default=64)
    args = parser.parse_args()
    if not 1 <= args.count <= 128: raise ValueError("Pilot request count must stay bounded")
    manifest = json.loads(args.manifest.read_text())
    samples = random.Random(20260908).sample(manifest["samples"], args.count)
    local = threading.local()
    def session():
        if not hasattr(local, "session"): local.session = requests.Session()
        return local.session
    def measure(sample, size, mode):
        start = time.perf_counter(); server_ms = 0.; operations = 0; transferred = 0
        def get(path, status=200, headers=None):
            nonlocal server_ms, operations, transferred
            response = session().get(args.origin.rstrip("/") + path, headers=headers, timeout=45)
            if response.status_code != status: raise ValueError(f"{path}: expected {status}, got {response.status_code}: {response.text[:200]}")
            server_ms += float(response.headers.get("X-Read-Ms", "0")); operations += 1; transferred += len(response.content)
            return response
        expected = sample[str(size)]
        if mode == "range":
            row = sample["row"]; base = f'/packs/{size}/{sample["shard"]}'
            offset = get(f"{base}.offsets.u64", 206, {"Range": f"bytes={row*8}-{row*8+15}"})
            if len(offset.content) != 16: raise ValueError("Offset read downloaded more than 16 bytes")
            begin, end = struct.unpack("<QQ", offset.content)
            if begin != expected["start"] or end - begin != expected["bytes"]: raise ValueError("Wrong offset identity")
            response = get(f"{base}.blob", 206, {"Range": f"bytes={begin}-{end-1}"})
            if response.headers.get("Content-Range") != f'bytes {begin}-{end-1}/{manifest["shards"][sample["shard"]][str(size)]}':
                raise ValueError("Wrong Content-Range")
        else: response = get(f'/thumbs/{size}/{sample["ref"]}.webp')
        if len(response.content) != expected["bytes"] or hashlib.sha256(response.content).hexdigest() != expected["sha256"]:
            raise ValueError("Image bytes differ from original pilot sample")
        return {"ms": (time.perf_counter()-start)*1000, "server_ms": server_ms, "bytes": transferred, "requests": operations, "container": response.headers.get("X-Container")}

    # First request of this run, before /health or a warmup. It is only a
    # deployment-cold observation if nobody has already awakened the worker.
    cold = measure(samples[0], 256, "image")
    results = []
    # Both modes use the same samples: later passes reuse Volume/OS caches.
    # Shuffling avoids measuring only one recently touched file region.
    for size in (256, 128):
        for concurrency in (1, 16):
            for mode in ("image", "range"):
                started = time.perf_counter()
                with ThreadPoolExecutor(max_workers=concurrency) as pool:
                    values = list(pool.map(lambda sample: measure(sample, size, mode), samples))
                elapsed = time.perf_counter() - started
                record = {"size": size, "mode": mode, "concurrency": concurrency, "client": summary([v["ms"] for v in values]),
                    "server": summary([v["server_ms"] for v in values]), "image_payload_bytes": sum(v["bytes"] for v in values),
                    "http_requests": sum(v["requests"] for v in values), "images_per_second": len(values)/elapsed,
                    "seconds": elapsed, "containers": sorted(set(v["container"] for v in values))}
                results.append(record); print(json.dumps(record), flush=True)
    health = session().get(args.origin.rstrip("/") + "/health", timeout=30).json()
    receipt = {"origin": args.origin, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "first_request": cold,
        "note": "HTTP/1.1 keep-alive per worker. First request has no explicit warmup; external activity may already have awakened the worker. Repeated tests reuse Volume/OS caches; no claim of hardware-cold disk. Image bodies verified by size/SHA-256, offset identities and image Content-Range checked. image_payload_bytes includes the 16-byte offset bodies in range mode. Throughput includes connection setup and is a small-sample observation, not a capacity limit.",
        "config": {"cpu_request": .25, "cpu_limit": 1, "memory_request_mib": 512, "memory_limit_mib": 768, "region": "us", "max_containers": 1, "max_inputs": 32, "scaledown_seconds": 60},
        "health": health, "results": results}
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"first_request": cold, "health": health}), flush=True)


if __name__ == "__main__": main()
