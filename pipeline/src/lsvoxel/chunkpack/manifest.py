"""Top-level manifest.json writer — the pipeline<->frontend contract's index. Lists
only OCCUPIED chunks (empty chunks are omitted, mirroring map_pack.py's convention of
skipping all-zero tiles). See the project plan's Phase 4e for the full schema.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_entry(path: Path, rel_to: Path) -> dict[str, Any]:
    return {
        "path": str(path.relative_to(rel_to)),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def write_manifest(
    out_dir: Path,
    dataset_id: str,
    world: dict[str, Any],
    atlas: dict[str, Any],
    point_source: dict[str, Any],
    subsets: dict[str, int],
    thumb_url_template: str,
    proxy_path: Path,
    point_index_path: Path,
    row_to_voxel_path: Path,
    chunk_entries: list[dict[str, Any]],
) -> Path:
    manifest = {
        "format_version": 1,
        "dataset_id": dataset_id,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "world": world,
        "atlas": atlas,
        "point_source": point_source,
        "subsets": subsets,
        "thumb_url_template": thumb_url_template,
        "proxy": file_entry(proxy_path, out_dir),
        "point_index": file_entry(point_index_path, out_dir),
        "row_to_voxel": file_entry(row_to_voxel_path, out_dir),
        "chunks": chunk_entries,
    }
    out_path = out_dir / "manifest.json"
    out_path.write_text(json.dumps(manifest, indent=1))
    return out_path


def validate_manifest(out_dir: Path) -> dict[str, Any]:
    """Re-derive byte counts/hashes for every file the manifest references and
    cross-check against what's recorded. Raises on the first mismatch."""
    manifest = json.loads((out_dir / "manifest.json").read_text())

    for key in ("proxy", "point_index", "row_to_voxel"):
        entry = manifest[key]
        p = out_dir / entry["path"]
        if not p.exists():
            raise FileNotFoundError(f"{key}: {p} missing")
        actual_bytes = p.stat().st_size
        if actual_bytes != entry["bytes"]:
            raise ValueError(f"{key}: size mismatch, manifest={entry['bytes']} actual={actual_bytes}")
        actual_sha = sha256_file(p)
        if actual_sha != entry["sha256"]:
            raise ValueError(f"{key}: sha256 mismatch")

    for chunk in manifest["chunks"]:
        for field in ("atlas", "meta"):
            path_key, bytes_key, sha_key = f"{field}_path", f"{field}_bytes", f"{field}_sha256"
            p = out_dir / chunk[path_key]
            if not p.exists():
                raise FileNotFoundError(f"chunk {chunk['chunk_id']}: {p} missing")
            actual_bytes = p.stat().st_size
            if actual_bytes != chunk[bytes_key]:
                raise ValueError(
                    f"chunk {chunk['chunk_id']} {field}: size mismatch, "
                    f"manifest={chunk[bytes_key]} actual={actual_bytes}"
                )
            if sha256_file(p) != chunk[sha_key]:
                raise ValueError(f"chunk {chunk['chunk_id']} {field}: sha256 mismatch")

    return {"n_chunks": len(manifest["chunks"]), "status": "ok"}
