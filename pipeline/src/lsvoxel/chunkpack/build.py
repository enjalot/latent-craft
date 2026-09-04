"""Orchestrates a full chunk-pack build: frame -> assign -> per-chunk atlas+meta ->
whole-dataset point_index/row_to_voxel/proxy/voxel_proxy -> manifest.json.

Sorted-boundary NumPy passes are used for both representative selection and point-id
storage order, avoiding full N-row pandas groupby/sort intermediates for million-row
packs.
"""
from __future__ import annotations

import ctypes
import errno
import json
import os
from pathlib import Path
import shutil
import tempfile
import warnings

import numpy as np
import pandas as pd

from .. import frame as frame_mod
from ..datasets.base import ThumbnailSource
from . import assign as assign_mod
from . import atlas as atlas_mod
from . import manifest as manifest_mod
from . import metablob
from . import pointindex as pointindex_mod
from . import proxy as proxy_mod
from . import row_to_voxel as row_to_voxel_mod
from . import voxel_proxy as voxel_proxy_mod


def assign_and_build(
    dataset_id: str,
    points_df: pd.DataFrame,
    coords3d: np.ndarray,
    num_voxels: int,
    thumb_source: ThumbnailSource,
    out_dir: Path,
    subsets: dict[str, int],
    thumb_url_template: str,
    umap_run: str,
    points_table_path: Path,
    voxels_per_chunk: int = 16,
    atlas_px: int = 2048,
    tile_px: int = 32,
    basisu_bin: str = "basisu",
    tmp_dir: Path | None = None,
) -> dict:
    """Build and validate in a sibling staging directory, then publish as one pack.

    On Linux an existing pack is exchanged with the staged pack atomically via
    ``renameat2(RENAME_EXCHANGE)``. Other platforms use a rollback-safe two-rename
    fallback: clients may briefly see no directory, but can never see half a build.
    """
    out_dir = Path(out_dir)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.building-", dir=out_dir.parent))
    build_tmp_dir = tmp_dir
    if tmp_dir is not None:
        try:
            if Path(tmp_dir).resolve().is_relative_to(out_dir.resolve()):
                build_tmp_dir = staging / "_tmp"
        except OSError:
            pass

    published = False
    try:
        result = _assign_and_build_into(
            dataset_id=dataset_id,
            points_df=points_df,
            coords3d=coords3d,
            num_voxels=num_voxels,
            thumb_source=thumb_source,
            out_dir=staging,
            subsets=subsets,
            thumb_url_template=thumb_url_template,
            umap_run=umap_run,
            points_table_path=points_table_path,
            voxels_per_chunk=voxels_per_chunk,
            atlas_px=atlas_px,
            tile_px=tile_px,
            basisu_bin=basisu_bin,
            tmp_dir=build_tmp_dir,
        )
        manifest_mod.validate_manifest(staging)
        _publish_staged_pack(staging, out_dir)
        published = True
        return {**result, "manifest_path": out_dir / "manifest.json"}
    finally:
        if not published and staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def _rename_exchange(left: Path, right: Path) -> bool:
    """Atomically exchange two paths on Linux; return false when unsupported."""
    if os.name != "posix":
        return False
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        return False
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    at_fdcwd = -100
    rename_exchange = 2
    result = renameat2(
        at_fdcwd,
        os.fsencode(left),
        at_fdcwd,
        os.fsencode(right),
        rename_exchange,
    )
    if result == 0:
        return True
    error = ctypes.get_errno()
    if error in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
        return False
    raise OSError(error, os.strerror(error), f"{left} <-> {right}")


def _publish_staged_pack(staging: Path, out_dir: Path) -> None:
    if not out_dir.exists():
        staging.replace(out_dir)
        return
    if not out_dir.is_dir() or out_dir.is_symlink():
        raise ValueError(f"refusing to replace non-directory pack target: {out_dir}")
    if _rename_exchange(staging, out_dir):
        try:
            shutil.rmtree(staging)
        except OSError as error:
            warnings.warn(f"published pack but could not remove previous build at {staging}: {error}")
        return

    backup = out_dir.with_name(f".{out_dir.name}.previous")
    if backup.exists():
        raise FileExistsError(f"stale publication backup exists: {backup}")
    out_dir.replace(backup)
    try:
        staging.replace(out_dir)
    except BaseException:
        backup.replace(out_dir)
        raise
    try:
        shutil.rmtree(backup)
    except OSError as error:
        warnings.warn(f"published pack but could not remove previous build at {backup}: {error}")


def _assign_and_build_into(
    dataset_id: str,
    points_df: pd.DataFrame,
    coords3d: np.ndarray,
    num_voxels: int,
    thumb_source: ThumbnailSource,
    out_dir: Path,
    subsets: dict[str, int],
    thumb_url_template: str,
    umap_run: str,
    points_table_path: Path,
    voxels_per_chunk: int = 16,
    atlas_px: int = 2048,
    tile_px: int = 32,
    basisu_bin: str = "basisu",
    tmp_dir: Path | None = None,
) -> dict:
    n = len(points_df)
    if coords3d.shape != (n, 3):
        raise ValueError(f"coords3d must be ({n}, 3), got {coords3d.shape}")
    row_ids = points_df["row_id"].to_numpy()
    if not np.array_equal(row_ids, np.arange(n, dtype=row_ids.dtype)):
        raise ValueError("points_df must be dense, row_id-ordered (0..N-1, no gaps)")
    if num_voxels % voxels_per_chunk != 0:
        raise ValueError(f"num_voxels ({num_voxels}) must be divisible by voxels_per_chunk ({voxels_per_chunk})")

    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir = tmp_dir or (out_dir / "_tmp")
    tmp_dir.mkdir(parents=True, exist_ok=True)

    print("[build] computing frame ...", flush=True)
    frame = frame_mod.compute_frame_3d(coords3d)
    coords_norm = frame_mod.normalize_to_cube(coords3d, frame["extent"])

    print("[build] assigning points to voxels/chunks ...", flush=True)
    assign = assign_mod.assign_points_to_chunks(coords_norm, num_voxels, voxels_per_chunk)
    reps = assign_mod.select_representatives(coords_norm, assign, num_voxels)

    max_voxel_count = int(reps["n_points"].max()) if len(reps) else 0
    if max_voxel_count > np.iinfo(np.uint16).max:
        worst = reps.loc[reps["n_points"].idxmax()]
        raise ValueError(
            "voxel occupancy exceeds meta.bin's uint16 limit: "
            f"chunk={int(worst['chunk_id'])} local_voxel={int(worst['local_voxel_id'])} "
            f"count={max_voxel_count}; increase num_voxels or revise the binary format"
        )

    voxels_per_chunk3 = voxels_per_chunk**3
    chunks_per_axis = num_voxels // voxels_per_chunk
    tiles_per_side = atlas_px // tile_px

    print(
        f"[build] {len(reps):,} occupied voxels across {reps['chunk_id'].nunique():,} "
        f"occupied chunks (world {chunks_per_axis}^3 = {chunks_per_axis**3:,} chunk slots)",
        flush=True,
    )

    # point_ids storage order: (chunk_id, local_voxel_id, row_id) ascending
    order = np.lexsort((row_ids, assign["local_voxel_id"], assign["chunk_id"]))
    chunk_id_sorted = assign["chunk_id"][order]
    local_id_sorted = assign["local_voxel_id"][order]
    row_id_sorted = row_ids[order]

    chunk_bounds = np.flatnonzero(np.diff(chunk_id_sorted)) + 1
    chunk_starts = np.concatenate(([0], chunk_bounds))
    chunk_ends = np.concatenate((chunk_bounds, [len(chunk_id_sorted)]))
    chunk_ids_present = chunk_id_sorted[chunk_starts]

    reps_by_chunk = {int(cid): g for cid, g in reps.groupby("chunk_id", sort=False)}

    chunk_entries: list[dict] = []
    # Voxels whose representative point had no thumbnail bytes — see
    # atlas.build_chunk_atlas_png. Always 0 for a dataset whose thumbnails are all
    # present (BL); nonzero means the pack was built over a partially-populated
    # store (MONET mid-pull) and those voxels render as flat background tiles.
    n_blank_tiles = 0
    proxy_chunk_ids: list[int] = []
    proxy_colors: list[np.ndarray] = []
    proxy_n_points: list[int] = []
    proxy_n_occ: list[int] = []
    voxel_proxy_runs: list[np.ndarray] = []

    n_chunks_total = len(chunk_ids_present)
    for ci, chunk_id in enumerate(chunk_ids_present.tolist()):
        s, e = int(chunk_starts[ci]), int(chunk_ends[ci])
        c_local_ids = local_id_sorted[s:e]
        c_row_ids = row_id_sorted[s:e]
        n_points_chunk = e - s

        g = reps_by_chunk[int(chunk_id)].sort_values("local_voxel_id")
        occ_local_ids = g["local_voxel_id"].to_numpy()
        occ_repr_row_ids = g["repr_row_id"].to_numpy()
        occ_counts = g["n_points"].to_numpy()

        # point_offset per occupied voxel = position within THIS chunk's point_ids
        # array where its points begin; c_local_ids is ascending (part of the lexsort
        # above), so a diff/boundary pass gives exactly that, no per-voxel search needed
        local_bounds = np.flatnonzero(np.diff(c_local_ids)) + 1
        local_starts = np.concatenate(([0], local_bounds))
        offset_by_local_id = dict(zip(c_local_ids[local_starts].tolist(), local_starts.tolist()))

        voxel_records = metablob.new_voxel_records(voxels_per_chunk3)
        for lid, repr_row, cnt in zip(
            occ_local_ids.tolist(), occ_repr_row_ids.tolist(), occ_counts.tolist()
        ):
            voxel_records[lid]["count"] = cnt
            voxel_records[lid]["point_offset"] = offset_by_local_id[lid]
            voxel_records[lid]["repr_row_id"] = repr_row
            voxel_records[lid]["flags"] = metablob.FLAG_HAS_ATLAS_TILE

        atlas_img, n_blank, chunk_tiles_per_side = atlas_mod.build_compact_chunk_atlas_png(
            occ_local_ids,
            occ_repr_row_ids,
            thumb_source,
            tile_px=tile_px,
            max_atlas_px=atlas_px,
        )
        n_blank_tiles += n_blank
        for tile_index, lid in enumerate(occ_local_ids.tolist()):
            voxel_records[lid]["color_rgb"] = atlas_mod.mean_tile_color(
                atlas_img, tile_index, tile_px, chunk_tiles_per_side
            )
        voxel_proxy_runs.append(voxel_proxy_mod.records_for_chunk(int(chunk_id), voxel_records))

        chunk_dir = out_dir / "c" / f"{chunk_id:06d}"
        chunk_dir.mkdir(parents=True, exist_ok=True)
        png_path = tmp_dir / f"{chunk_id:06d}.png"
        atlas_img.save(png_path)
        atlas_path = chunk_dir / "atlas.ktx2"
        atlas_mod.encode_ktx2(png_path, atlas_path, basisu_bin=basisu_bin)
        png_path.unlink(missing_ok=True)

        meta_path = chunk_dir / "meta.bin"
        metablob.write_chunk_meta(
            meta_path,
            metablob.ChunkMeta(
                chunk_id=int(chunk_id),
                voxel_grid_n=voxels_per_chunk,
                atlas_tile_px=tile_px,
                voxel_records=voxel_records,
                point_ids=c_row_ids.astype(np.uint32),
            ),
        )

        cx = int(chunk_id) % chunks_per_axis
        cy = (int(chunk_id) // chunks_per_axis) % chunks_per_axis
        cz = int(chunk_id) // (chunks_per_axis * chunks_per_axis)
        cell = 2.0 / chunks_per_axis
        bbox = [
            -1.0 + cx * cell, -1.0 + (cx + 1) * cell,
            -1.0 + cy * cell, -1.0 + (cy + 1) * cell,
            -1.0 + cz * cell, -1.0 + (cz + 1) * cell,
        ]
        atlas_fe = manifest_mod.file_entry(atlas_path, out_dir)
        meta_fe = manifest_mod.file_entry(meta_path, out_dir)
        chunk_entries.append(
            {
                "chunk_id": int(chunk_id), "cx": cx, "cy": cy, "cz": cz, "bbox": bbox,
                "n_occupied_voxels": len(occ_local_ids), "n_points": n_points_chunk,
                "atlas_size_px": atlas_img.width,
                "atlas_tiles_per_side": chunk_tiles_per_side,
                "atlas_path": atlas_fe["path"], "atlas_bytes": atlas_fe["bytes"],
                "atlas_sha256": atlas_fe["sha256"],
                "meta_path": meta_fe["path"], "meta_bytes": meta_fe["bytes"],
                "meta_sha256": meta_fe["sha256"],
            }
        )

        colors = np.array(
            [voxel_records[lid]["color_rgb"] for lid in occ_local_ids.tolist()], dtype=np.float64
        )
        weights = occ_counts.astype(np.float64)
        chunk_color = (colors * weights[:, None]).sum(axis=0) / weights.sum()
        proxy_chunk_ids.append(int(chunk_id))
        proxy_colors.append(chunk_color.round().astype(np.uint8))
        proxy_n_points.append(n_points_chunk)
        proxy_n_occ.append(len(occ_local_ids))

        if (ci + 1) % 25 == 0 or ci + 1 == n_chunks_total:
            blank_note = f", {n_blank_tiles:,} blank tiles so far" if n_blank_tiles else ""
            print(f"[build] chunk {ci + 1}/{n_chunks_total} done{blank_note}", flush=True)

    if n_blank_tiles:
        print(
            f"[build] WARNING: {n_blank_tiles:,} of {len(reps):,} occupied voxels "
            f"({100 * n_blank_tiles / max(len(reps), 1):.1f}%) got a blank atlas tile — "
            "their representative point's thumbnail wasn't available",
            flush=True,
        )

    print("[build] writing whole-dataset artifacts ...", flush=True)
    proxy_records = proxy_mod.build_proxy_records(
        chunks_per_axis,
        np.array(proxy_chunk_ids, dtype=np.int64),
        np.array(proxy_colors, dtype=np.uint8),
        np.array(proxy_n_points, dtype=np.uint32),
        np.array(proxy_n_occ, dtype=np.uint16),
    )
    proxy_path = out_dir / "proxy.bin"
    proxy_mod.write_proxy(proxy_path, chunks_per_axis, proxy_records)

    point_index_path = out_dir / "point_index.bin"
    pointindex_mod.build_point_index(points_df, subsets, point_index_path)

    row_to_voxel_path = out_dir / "row_to_voxel.bin"
    row_to_voxel_mod.build_row_to_voxel(n, assign, row_to_voxel_path)

    voxel_proxy_path = out_dir / "voxel_proxy.bin"
    voxel_proxy_mod.write_voxel_proxy(
        voxel_proxy_path, num_voxels, voxels_per_chunk,
        voxel_proxy_mod.build_voxel_proxy_records(voxel_proxy_runs),
    )

    world = {
        "num_voxels": num_voxels,
        "voxels_per_chunk": voxels_per_chunk,
        "chunks_per_axis": chunks_per_axis,
        "frame": frame,
    }
    atlas_cfg = {
        "size_px": atlas_px, "tile_px": tile_px, "tiles_per_side": tiles_per_side,
        "format": "ktx2-etc1s", "alpha": False, "layout": "compact-occupied-v1",
    }
    point_source = {"points_table": str(points_table_path), "umap_run": umap_run, "n_points": n}

    manifest_path = manifest_mod.write_manifest(
        out_dir, dataset_id, world, atlas_cfg, point_source, subsets, thumb_url_template,
        proxy_path, point_index_path, row_to_voxel_path, voxel_proxy_path, chunk_entries,
    )

    try:
        if tmp_dir.exists() and not any(tmp_dir.iterdir()):
            tmp_dir.rmdir()
    except OSError:
        pass

    return {
        "manifest_path": manifest_path,
        "n_chunks": len(chunk_entries),
        "n_occupied_voxels": len(reps),
        "n_points": n,
        "n_blank_tiles": n_blank_tiles,
    }


def derive_voxel_proxy(pack_dir: Path) -> dict:
    """Write voxel_proxy.bin for a pack built before the file existed, from the
    pack's own per-chunk meta.bin files, and register it in manifest.json (the only
    key that changes). Byte-identical to what assign_and_build would have written —
    both paths go through voxel_proxy.records_for_chunk — and idempotent: re-running
    rewrites the same bytes and the same entry. The .bin lands via temp file + rename
    for the same reason manifest.dump_manifest does: the pack is being served.
    Callers pair it with validate_chunks."""
    manifest = json.loads((pack_dir / "manifest.json").read_text())
    world = manifest["world"]

    runs: list[np.ndarray] = []
    for chunk in manifest["chunks"]:
        meta = metablob.read_chunk_meta(pack_dir / chunk["meta_path"])
        if meta.chunk_id != chunk["chunk_id"]:
            raise ValueError(
                f"{chunk['meta_path']}: header chunk_id {meta.chunk_id} != manifest {chunk['chunk_id']}"
            )
        runs.append(voxel_proxy_mod.records_for_chunk(meta.chunk_id, meta.voxel_records))
    records = voxel_proxy_mod.build_voxel_proxy_records(runs)

    voxel_proxy_path = pack_dir / "voxel_proxy.bin"
    tmp_path = pack_dir / "voxel_proxy.bin.tmp"
    voxel_proxy_mod.write_voxel_proxy(tmp_path, world["num_voxels"], world["voxels_per_chunk"], records)
    tmp_path.replace(voxel_proxy_path)

    entry = manifest_mod.voxel_proxy_entry(voxel_proxy_path, pack_dir)
    manifest_path = manifest_mod.dump_manifest(pack_dir, manifest_mod.with_voxel_proxy(manifest, entry))
    return {"manifest_path": manifest_path, "n_voxels": entry["n_voxels"], "bytes": entry["bytes"]}


def validate_chunks(out_dir: Path) -> dict:
    return manifest_mod.validate_manifest(out_dir)
