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

import numpy as np

from . import metablob
from . import voxel_proxy as voxel_proxy_mod


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


def voxel_proxy_entry(path: Path, rel_to: Path) -> dict[str, Any]:
    """`file_entry` plus the header's n_voxels, so a client can size its per-voxel
    buffers from the manifest alone before the fetch lands (as `chunks[].
    n_occupied_voxels` lets it do per chunk)."""
    _, _, n_voxels = voxel_proxy_mod.read_voxel_proxy_header(path)
    return {**file_entry(path, rel_to), "n_voxels": n_voxels}


def with_voxel_proxy(manifest: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    """`manifest` with its `voxel_proxy` entry set: replaced in place when present,
    otherwise inserted right after `row_to_voxel`, so a manifest that gained the key
    after the fact (scripts/derive_voxel_proxy.py) has the same key order as one
    write_manifest emits. Additive under format_version 1 — a reader that predates
    the key ignores it."""
    if "voxel_proxy" in manifest:
        return {**manifest, "voxel_proxy": entry}
    if "row_to_voxel" not in manifest:
        raise KeyError("manifest has no row_to_voxel entry to anchor voxel_proxy after")
    out: dict[str, Any] = {}
    for key, value in manifest.items():
        out[key] = value
        if key == "row_to_voxel":
            out["voxel_proxy"] = entry
    return out


def dump_manifest(out_dir: Path, manifest: dict[str, Any]) -> Path:
    """Serialize to out_dir/manifest.json via a sibling temp file + rename, so a
    client fetching from a live pack (the static data server serves straight from
    disk, and derive_voxel_proxy rewrites manifests of packs already being served)
    never reads a half-written manifest."""
    out_path = out_dir / "manifest.json"
    tmp_path = out_dir / "manifest.json.tmp"
    tmp_path.write_text(json.dumps(manifest, indent=1))
    tmp_path.replace(out_path)
    return out_path


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
    voxel_proxy_path: Path,
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
        "voxel_proxy": voxel_proxy_entry(voxel_proxy_path, out_dir),
        "chunks": chunk_entries,
    }
    return dump_manifest(out_dir, manifest)


def _validate_voxel_proxy(out_dir: Path, manifest: dict[str, Any]) -> int:
    """voxel_proxy.bin must describe exactly this pack: header grid == world, one
    record per occupied voxel (== the chunk entries' n_occupied_voxels sum == the
    manifest entry's n_voxels), and every chunk's run byte-equal to what its own
    meta.bin yields. Returns n_voxels."""
    entry = manifest["voxel_proxy"]
    vp = voxel_proxy_mod.read_voxel_proxy(out_dir / entry["path"])
    world = manifest["world"]
    if (vp.num_voxels, vp.voxels_per_chunk) != (world["num_voxels"], world["voxels_per_chunk"]):
        raise ValueError(
            f"voxel_proxy: header grid {vp.num_voxels}/{vp.voxels_per_chunk} != "
            f"world {world['num_voxels']}/{world['voxels_per_chunk']}"
        )
    if vp.n_voxels != entry["n_voxels"]:
        raise ValueError(f"voxel_proxy: header n_voxels={vp.n_voxels}, manifest={entry['n_voxels']}")
    n_occupied = sum(c["n_occupied_voxels"] for c in manifest["chunks"])
    if vp.n_voxels != n_occupied:
        raise ValueError(
            f"voxel_proxy: {vp.n_voxels} records, but chunks total {n_occupied} occupied voxels"
        )

    # read_voxel_proxy guarantees chunk_id-sorted records, so each chunk's run is a
    # searchsorted range; runs matching every listed chunk plus the total above
    # leaves no room for records of chunks the manifest doesn't list
    chunk_ids = vp.records["chunk_id"]
    for chunk in manifest["chunks"]:
        cid = chunk["chunk_id"]
        s, e = np.searchsorted(chunk_ids, cid, side="left"), np.searchsorted(chunk_ids, cid, side="right")
        meta = metablob.read_chunk_meta(out_dir / chunk["meta_path"])
        expected = voxel_proxy_mod.records_for_chunk(cid, meta.voxel_records)
        run = vp.records[s:e]
        if len(run) != len(expected) or not np.array_equal(run, expected):
            raise ValueError(f"voxel_proxy: chunk {cid} records differ from its meta.bin")
    return vp.n_voxels


def validate_manifest(out_dir: Path) -> dict[str, Any]:
    """Re-derive byte counts/hashes for every file the manifest references and
    cross-check against what's recorded; then cross-check voxel_proxy.bin's content
    against the chunks' meta.bin files. Raises on the first mismatch."""
    manifest = json.loads((out_dir / "manifest.json").read_text())
    if "voxel_proxy" not in manifest:
        raise KeyError("manifest has no voxel_proxy entry — derive it with scripts/derive_voxel_proxy.py")

    for key in ("proxy", "point_index", "row_to_voxel", "voxel_proxy"):
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

    n_voxels = _validate_voxel_proxy(out_dir, manifest)

    return {"n_chunks": len(manifest["chunks"]), "n_voxels": n_voxels, "status": "ok"}
