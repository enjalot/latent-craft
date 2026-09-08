#!/usr/bin/env python3
"""Extract 16 verified thumbnail pairs for a self-contained Moonshine comparison."""
import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("pilot", type=Path); parser.add_argument("output", type=Path)
args = parser.parse_args()
manifest = json.loads((args.pilot / "manifest.json").read_text())
args.output.mkdir(parents=True, exist_ok=False)
records = []
for shard in manifest["shards"]:
    for sample in [s for s in manifest["samples"] if s["shard"] == shard][:2]:
        record = {"ref": sample["ref"]}
        for size in ("256", "128"):
            extent = sample[size]
            with (args.pilot / size / f"{shard}.blob").open("rb") as f:
                f.seek(extent["start"]); data = f.read(extent["bytes"])
            if hashlib.sha256(data).hexdigest() != extent["sha256"]: raise ValueError("Image identity mismatch")
            filename = f'{sample["ref"]}-{size}.webp'
            (args.output / filename).write_bytes(data)
            record[size] = {"file": filename, "bytes": len(data)}
        records.append(record)
(args.output / "images.json").write_text(json.dumps(records, indent=2) + "\n")
print(json.dumps({"pairs": len(records), "bytes": sum(r[size]["bytes"] for r in records for size in ("128", "256"))}))
