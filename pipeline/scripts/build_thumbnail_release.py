#!/usr/bin/env python3
"""Build or resume the full MONET 128px store locally, without cloud writes."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from lsvoxel.thumbnail_release import build_release


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--limit", type=int, help="Convert only this many shards; never publish an incomplete manifest")
    parser.add_argument("--expected-rows", type=int, default=103816750)
    args = parser.parse_args()
    print(json.dumps(build_release(args.source, args.output, args.workers, args.limit, args.expected_rows)), flush=True)
