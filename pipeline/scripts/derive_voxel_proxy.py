#!/usr/bin/env python3
"""Derive voxel_proxy.bin for an EXISTING chunk pack (one built before the file
existed) from its per-chunk meta.bin files, register it in manifest.json, then
validate the pack. Idempotent — re-running rewrites the same bytes and entry. Packs
under /data are being served as static files, so both writes land atomically.

Usage: .venv/bin/python scripts/derive_voxel_proxy.py <pack_dir>
  e.g. .venv/bin/python scripts/derive_voxel_proxy.py /data/latent-scope-3d/chunks/bl-160
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lsvoxel.chunkpack.build import derive_voxel_proxy, validate_chunks  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    pack_dir = Path(sys.argv[1]).resolve()
    if not (pack_dir / "manifest.json").is_file():
        print(f"[derive_voxel_proxy] no manifest.json in {pack_dir}", file=sys.stderr)
        return 1

    print(f"[derive_voxel_proxy] pack: {pack_dir}", flush=True)
    result = derive_voxel_proxy(pack_dir)
    print(f"[derive_voxel_proxy] derive result: {result}", flush=True)

    print("[derive_voxel_proxy] validating ...", flush=True)
    v = validate_chunks(pack_dir)
    print(f"[derive_voxel_proxy] validate result: {v}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
