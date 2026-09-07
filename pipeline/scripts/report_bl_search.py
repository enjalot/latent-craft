#!/usr/bin/env python3
"""Reduce full benchmark receipts to an auditable, compact comparison table."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("experiment", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args(); out = args.output; out.mkdir(parents=True, exist_ok=True)
    preparation = json.loads((args.experiment / "prepare.json").read_text())
    records = []
    for path in sorted(args.experiment.glob("*.eval.json")):
        receipt = json.loads(path.read_text())
        if "error" in receipt: records.append({"receipt": path.name, **receipt}); continue
        build = json.loads((args.experiment / f'{receipt["config"]}.build.json').read_text())
        for setting in receipt["settings"]:
            records.append(dict(config=receipt["config"], receipt=path.name, cache_mb=receipt["cache_mb"],
                disk_bytes=build.get("total_bytes", build.get("bytes")), index_bytes=build.get("index_bytes", build.get("bytes")),
                build_seconds=build.get("build_seconds"), build_peak_rss_bytes=build.get("peak_rss_bytes"),
                **{k: v for k, v in setting.items() if k not in ("result_ids", "times_ms")}))
    report = dict(source_sha256=preparation["source_sha256"], rows=preparation["rows"], dim=preparation["dim"],
        model=preparation["model"], revision=preparation["revision"], prompts=preparation["prompts"],
        encoder_weight_bytes=preparation["encoder_weight_bytes"],
        note="Shared workstation, two search threads, uncontrolled OS cache; RSS excludes text encoder. Some metric sweeps overlap. Recall@24 measures exact-neighbor recovery, not subjective relevance.",
        results=records, signed_int8=json.loads((args.experiment / "signed-int8-compatibility.json").read_text()),
        signed_int8_full=json.loads((args.experiment / "signed-int8-full.json").read_text()) if (args.experiment / "signed-int8-full.json").exists() else None)
    (out / "bl-search-20260907.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = ["# Full BL search configuration measurements", "", report["note"], "",
        "Disk includes Lance's float base vectors plus its compressed index; FAISS rows contain the standalone search index only.", "",
        "| Configuration | Cache MiB | Probes | Refine | Text R@24 | Image R@24 | Text p50 / p95 ms | RSS MiB | Disk GiB |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in records:
        if "error" in r: continue
        lines.append(f'| {r["config"]} | {r["cache_mb"]} | {r["nprobes"]} | {r["refine"]} | {r["text_recall24"]:.3f} | {r["image_recall24"]:.3f} | {r["text_p50_ms"]:.1f} / {r["text_p95_ms"]:.1f} | {r["rss_bytes"]/2**20:.0f} | {r["disk_bytes"]/2**30:.3f} |')
    (out / "bl-search-20260907.md").write_text("\n".join(lines) + "\n")
    print(f"Wrote {len(records)} measured settings")


if __name__ == "__main__": main()
