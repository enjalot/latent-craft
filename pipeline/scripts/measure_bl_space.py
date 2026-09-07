#!/usr/bin/env python3
"""Sequential public-demo measurements; no load test, credentials, or paid jobs."""
import argparse
import json
from pathlib import Path
import time
import httpx
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://enjalot-latent-craft-bl.hf.space")
    parser.add_argument("--experiment", type=Path, default=Path("/data/latent-craft/experiments/bl-search-20260907b"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prep = json.loads((args.experiment / "prepare.json").read_text())
    truth = np.load(args.experiment / "truth.npz")["ids"]
    client = httpx.Client(base_url=args.url, timeout=60)
    before = client.get("/api/bl/status").raise_for_status().json()
    if before["state"] != "ready": raise RuntimeError(f"Space not ready: {before['state']}")
    records = []
    for i, prompt in enumerate(prep["prompts"]):
        # Alternate who pays the embedding computation; second backend gets
        # the same cached query vector. Compare search time separately.
        for backend in (["faiss", "sq8"] if i % 2 == 0 else ["sq8", "faiss"]):
            started = time.perf_counter()
            retries = []
            for attempt in range(3):
                try:
                    body = client.post("/api/bl/search", json=dict(query=prompt, backend=backend)).raise_for_status().json()
                    break
                except httpx.TransportError as error:
                    retries.append(type(error).__name__)
                    if attempt == 2: raise
                    time.sleep(1)
            elapsed = 1000*(time.perf_counter()-started)
            assert body["release"] == "bl-20260907a" and body["query"] == prompt and body["backend"] == backend
            ids = [hit["row"] for hit in body["results"]]
            assert len(ids) == len(set(ids)) == 24 and all(0 <= row < 1080814 for row in ids)
            records.append(dict(prompt=prompt, backend=backend, end_to_end_ms=elapsed, transport_retries=retries,
                embed_ms=body["embed_ms"], search_ms=body["search_ms"], embedding_cached=body["embedding_cached"],
                recall24=len(set(ids) & set(truth[i, :24]))/24))
        print(i+1, "of", len(prep["prompts"]), flush=True)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.with_suffix(".partial.json").write_text(json.dumps(records, indent=2) + "\n")
    after = client.get("/api/bl/status").raise_for_status().json()
    summary = {}
    for backend in ["faiss", "sq8"]:
        found = [r for r in records if r["backend"] == backend]
        summary[backend] = dict(recall24=float(np.mean([r["recall24"] for r in found])),
            **{f"{key}_{percentile}": float(np.percentile([r[key] for r in found], percentile))
               for key in ["search_ms", "end_to_end_ms"] for percentile in [50, 95]})
        fresh = [r["end_to_end_ms"] for r in found if not r["embedding_cached"]]
        summary[backend].update(uncached_queries=len(fresh),
            **{f"uncached_end_to_end_ms_{p}": float(np.percentile(fresh, p)) if fresh else None for p in [50, 95]})
    uncached = [r["embed_ms"] for r in records if not r["embedding_cached"]]
    result = dict(url=args.url, before=before, after=after, summary=summary,
        embed_uncached_p50_ms=float(np.median(uncached)) if uncached else None,
        embed_uncached_p95_ms=float(np.percentile(uncached, 95)) if uncached else None,
        note="Sequential two-backend comparison on 64 fixed public prompts; not a concurrency, sleep-resume or cold-disk benchmark. Alternating backends share cached text embeddings.", records=records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    client.close()


if __name__ == "__main__": main()
