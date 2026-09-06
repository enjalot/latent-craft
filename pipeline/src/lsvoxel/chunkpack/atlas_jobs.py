"""Bounded, ordered atlas preparation; completed atlas outputs can be reused."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import struct

import numpy as np

from . import atlas, metablob


def prepare_atlas(chunk_id, reps, thumb_source, output, scratch, tile_px, atlas_px, basisu_bin, reuse=None, encoder_threads=None):
    reps = reps.sort_values("local_voxel_id")
    local = reps.local_voxel_id.to_numpy()
    rows = reps.repr_row_id.to_numpy()
    side = atlas.compact_tiles_per_side(len(local), atlas_px // tile_px)
    directory = output / "c" / f"{chunk_id:06d}"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "atlas.ktx2"
    if reuse is not None:
        previous = Path(reuse) / "c" / f"{chunk_id:06d}"
        if (previous / "meta.bin").exists() and (previous / "atlas.ktx2").exists():
            meta = metablob.read_chunk_meta(previous / "meta.bin")
            records = meta.voxel_records
            occupied = np.flatnonzero(records["count"])
            if (meta.chunk_id != chunk_id or meta.atlas_tile_px != tile_px or not np.array_equal(occupied, local)
                    or not np.array_equal(records["repr_row_id"][occupied], rows)):
                raise ValueError(f"Refusing mismatched atlas reuse for chunk {chunk_id}")
            with (previous / "atlas.ktx2").open("rb") as stream:
                header = stream.read(32)
            if header[:12] != b"\xabKTX 20\xbb\r\n\x1a\n" or len(header) != 32 or struct.unpack_from("<II", header, 20) != (side*tile_px, side*tile_px):
                raise ValueError(f"Invalid cached atlas dimensions for chunk {chunk_id}")
            shutil.copyfile(previous / "atlas.ktx2", target)
            blank = sum(not thumb_source.open(int(row)) for row in rows)
            return dict(path=target, side=side, width=side*tile_px, blank=blank, colors=records["color_rgb"][occupied].copy())
    image, blank, side = atlas.build_compact_chunk_atlas_png(local, rows, thumb_source, tile_px=tile_px, max_atlas_px=atlas_px)
    try:
        colors = np.array([atlas.mean_tile_color(image, i, tile_px, side) for i in range(len(local))], dtype=np.uint8)
        png = scratch / f"{chunk_id:06d}.png"
        image.save(png)
        kwargs = {"max_threads": encoder_threads} if encoder_threads is not None else {}
        atlas.encode_ktx2(png, target, basisu_bin=basisu_bin, **kwargs)
        png.unlink()
        return dict(path=target, side=side, width=image.width, blank=blank, colors=colors)
    finally:
        image.close()


def ordered_atlases(chunk_ids, reps_by_chunk, thumb_source, output, scratch, tile_px, atlas_px, basisu_bin, workers=1, reuse=None):
    """At most `workers` tasks/results live, not an eager future for every chunk.

    Closing this iterator joins its small worker pool before the caller removes
    staging files after a failure. Results contain colors, never retained images.
    """
    if not 1 <= workers <= 8:
        raise ValueError("Atlas workers must be in 1..8")
    ids = iter(chunk_ids)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        pending = deque()
        def submit():
            chunk = next(ids, None)
            if chunk is not None:
                pending.append(executor.submit(prepare_atlas, int(chunk), reps_by_chunk[int(chunk)], thumb_source,
                    output, scratch, tile_px, atlas_px, basisu_bin, reuse, 2 if workers > 1 else None))
        for _ in range(workers): submit()
        while pending:
            result = pending.popleft().result()
            submit()
            yield result
