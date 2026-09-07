"""Measure local BL metadata CPU time and response bytes (not internet latency)."""
import argparse
import gzip
import json
import resource
import struct
import time

from metadata_server import MetadataStore


def benchmark(path):
    store = MetadataStore(path)
    results = []
    for query in ({"type": "covers"}, {"type": "plates"}, {"minYear": 1800, "maxYear": 1850},
                  {"book": "003850330"}, {"book": "000000000"}, {}):
        start = time.perf_counter(); body = store.snapshot(query); cold = (time.perf_counter() - start) * 1000
        start = time.perf_counter(); store.snapshot(query); cached = (time.perf_counter() - start) * 1000
        decoded = gzip.decompress(body)
        results.append({"query": query, "first_ms": round(cold, 2), "cached_ms": round(cached, 3),
                        "gzip_bytes": len(body), "decoded_bytes": len(decoded),
                        "matching_rows": struct.unpack_from("<I", decoded, 8)[0], "matching_voxels": struct.unpack_from("<I", decoded, 12)[0]})
    start = time.perf_counter(); detail = store.detail(568157)
    return {"identity": store.info, "queries": results, "detail_ms": round((time.perf_counter() - start) * 1000, 3),
            "detail_json_bytes": len(json.dumps(detail).encode()), "max_rss_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "note": "Fresh SQLite connection; OS file cache may be warm. Sequential local CPU measurements, not remote hosting latency."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--db", required=True)
    print(json.dumps(benchmark(parser.parse_args().db), indent=2))
