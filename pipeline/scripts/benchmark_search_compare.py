#!/usr/bin/env python3
"""Small local inference benchmark, not a browser latency or relevance eval."""
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

import numpy as np

PROMPTS = ["a red sports car", "an aerial photograph of a forest", "a dog playing in snow",
    "a watercolor painting of mountains", "a plate of pasta", "a portrait of a woman",
    "a medieval castle", "a black and white street photograph", "a close up of a butterfly",
    "a blue ceramic bowl", "a science fiction spaceship", "a vintage illustrated book cover"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8803")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    records = []
    for prompt in PROMPTS:
        for mode in ["project", "search"]:
            deadline = time.monotonic() + 180
            while True:
                request = urllib.request.Request(args.url + "/api/explore/query",
                    data=json.dumps({"dataset": "monet-clip-basemap-training-512", "release": "monet-clip-basemap-training-20260905a",
                        "query": prompt, "mode": mode}).encode(), headers={"Content-Type": "application/json"})
                try:
                    start = time.perf_counter()
                    with urllib.request.urlopen(request, timeout=30) as stream:
                        response = json.load(stream)
                    client_ms = (time.perf_counter()-start)*1000
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 503 or time.monotonic() >= deadline:
                        raise
                    time.sleep(1)
            records.append({"query": prompt, "mode": mode, "client_ms": client_ms,
                "timings": response["timings"], "embedding_cached": response["embedding_cached"],
                "projection": response["projection"], "first_result": response["results"][:1]})
    summary = {}
    for mode in ["project", "search"]:
        selected = [r for r in records if r["mode"] == mode]
        summary[mode] = {key: {"p50": float(np.percentile(values, 50)), "p95": float(np.percentile(values, 95))}
            for key, values in [(key, [r["timings"][key] for r in selected]) for key in
                ["embed_ms", "project_ms", "search_ms", "total_ms"]]}
    report = {"description": "12 sequential paired prompts, projection then search; search reuses text embedding cache.",
        "summary": summary, "resources": response["resources"], "records": records}
    args.out.write_text(json.dumps(report, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
