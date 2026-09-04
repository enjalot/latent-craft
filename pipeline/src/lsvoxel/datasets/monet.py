"""MONET (jasperai/monet) draw arms: points table + thumbnail source.

Mirrors `datasets/bl.py`'s shape — `build_points_table()` plus a `ThumbnailSource` —
but everything is parameterized by *draw arm* (`random`, `sscd`, `annfaiss`,
`theirfaiss`, ...), since each arm is its own 2M-row subset of the same 19.3M-row pool
and gets its own points table / UMAP fit / chunk pack / minimap pack.

The row_id contract, which everything downstream depends on:

    row_id i  ==  row i of `/data2/monet/draws/{arm}-clip.f32.npy`  (the UMAP input)
              ==  pool row `idx[i]`, where idx = `{arm}.idx.npy`    (all metadata)

The draw's CLIP substrate was assembled as `clip512[idx]` with `idx` sorted ascending
(see `~/code/latent-basemap/experiments/sandbox/monet_assemble_draw.py`), so this
table just has to gather the pool's metadata arrays through the same `idx`, in the
same order, and never re-sort. Everything else in the pipeline keys off `row_id`.

Two column names are load-bearing because the generic chunk-pack/minimap code reads
them without knowing which dataset it's on:

* `subset` — `chunkpack/pointindex.py` maps it through the `subsets` mapping to a
  `subset_code:u8`, and `minimap/build.py` uses it as the per-corpus density axis.
  Here it's MONET's `source` (laion / coyo / synthetic-* / ...), coded by the frozen
  `config.MONET_SOURCES`.
* `global_idx` — becomes `point_index.bin`'s `local_idx:u32`, the only per-point
  field the frontend has for building a thumbnail URL. Here it's the packed
  `(shard_idx, local_row)` thumbnail reference; see `lsvoxel/monet_thumbs.py` for the
  packing, which is defined and decoded only there.

The same `(shard_idx, local_row)` also addresses the pool's original-image
`url`/`width`/`height` store (`config.MONET_URLS_SHARDS_DIR`, pulled by
`scripts/pull_pool_urls.py` in the pool's shard order), which is where the table's
`image_url` / `image_width` / `image_height` columns come from.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import (
    MONET_POOL_DIR,
    MONET_SOURCES,
    MONET_THUMBS_SHARDS_DIR,
    MONET_URLS_SHARDS_DIR,
    monet_draw_clip_path,
    monet_draw_idx_path,
)
from ..monet_thumbs import (
    DEFAULT_MAX_OPEN_SHARDS,
    MonetThumbStore,
    pack_thumb_ref,
    unpack_thumb_ref,
)
from ..points_table import write_points_table
from .base import ThumbnailSource

#: Pool columns gathered per draw row, with the dtype each lands in the table as.
#: `id`/`sscd_cluster_id` stay strings; the rest are numeric.
_POOL_COLUMNS = ("id", "source", "sscd_nn", "sscd_cluster_id", "aesthetic")

#: The per-row values built packs carry or key off — what a rebuild must reproduce
#: exactly (see `points_table.write_points_table`): the two load-bearing columns
#: named above, plus row_id itself.
MONET_CONTRACT_COLUMNS = ("row_id", "global_idx", "subset")


def _gather_originals(
    shard_idx: np.ndarray, local_row: np.ndarray, urls_shards_dir: Path
) -> tuple[pa.Array, np.ndarray, np.ndarray]:
    """`(url, width, height)` per draw row from the per-shard url store, reading only
    the shards this draw touches (a 2M draw touches ~2,012 of 2,015 — nearly all, but
    a smaller draw shouldn't pay for the whole pool).

    Pool rows are NOT shard-ordered (`prov_shard_idx` isn't monotone), so the rows are
    visited grouped by shard and the results scattered back through the inverse
    permutation, all arrow/numpy: the url column stays an arrow string array from the
    parquet read to the frame, never 2M python `str` objects in between.
    """
    n = len(shard_idx)
    order = np.argsort(shard_idx, kind="stable")
    shards, starts = np.unique(shard_idx[order], return_index=True)
    ends = np.append(starts[1:], n)

    url_chunks: list[pa.Array] = []
    width = np.zeros(n, dtype=np.int32)
    height = np.zeros(n, dtype=np.int32)
    for shard, a, b in zip(shards.tolist(), starts.tolist(), ends.tolist()):
        pos = order[a:b]
        rows = local_row[pos]
        base = urls_shards_dir / f"{shard:04d}"
        if not base.with_suffix(".done").exists():
            raise FileNotFoundError(
                f"url store shard {shard} not pulled yet ({base.with_suffix('.parquet')}); "
                "run scripts/pull_pool_urls.py to completion before building a MONET table"
            )
        table = pq.read_table(base.with_suffix(".parquet"), columns=["url", "width", "height"])
        if int(rows.max()) >= table.num_rows:
            raise ValueError(
                f"url store shard {shard} has {table.num_rows} rows but the draw addresses "
                f"local_row {int(rows.max())} — store and pool provenance disagree"
            )
        take = pa.array(rows)
        url_chunks.extend(table.column("url").take(take).chunks)
        width[pos] = table.column("width").take(take).to_numpy()
        height[pos] = table.column("height").take(take).to_numpy()

    inverse = np.empty(n, dtype=np.int64)
    inverse[order] = np.arange(n)
    urls_by_shard = pa.chunked_array(url_chunks, type=pa.string()).combine_chunks()
    urls = urls_by_shard.take(pa.array(inverse))
    return urls, np.clip(width, 0, None), np.clip(height, 0, None)


def _gather(name: str, idx: np.ndarray, pool_dir: Path, n_pool: int) -> np.ndarray:
    """Read one pool array as a memmap and gather the draw's rows out of it.

    Memmap + fancy-index rather than a full load: the pool arrays run to 1.7 GB each
    and only 2M of 19.3M rows are wanted. `idx` is sorted, so the access pattern stays
    forward-only through the file.
    """
    arr = np.load(pool_dir / f"{name}.npy", mmap_mode="r")
    if len(arr) != n_pool:
        raise ValueError(f"{name}.npy has {len(arr):,} rows, expected the pool's {n_pool:,}")
    return np.asarray(arr[idx])


def _intern_strings(values: np.ndarray) -> np.ndarray:
    """Object array whose entries are shared python strings, one per distinct value.

    `source` has 9 distinct values across 2M rows; a plain `.astype(object)` would
    allocate 2M separate `str` objects for them.
    """
    uniques, inverse = np.unique(values, return_inverse=True)
    return uniques.astype(object)[inverse]


def build_points_table(
    arm: str,
    out_path: Path,
    pool_dir: Path = MONET_POOL_DIR,
    urls_shards_dir: Path = MONET_URLS_SHARDS_DIR,
) -> pd.DataFrame:
    """Build `points.parquet` for one draw arm.

    `row_id` is position in the draw (0..N-1), which is exactly the row order of
    `{arm}-clip.f32.npy` — so the UMAP coordinates fit from that file are already
    row_id-aligned and nothing downstream ever re-sorts.
    """
    idx_path = monet_draw_idx_path(arm)
    if not idx_path.exists():
        raise FileNotFoundError(
            f"{idx_path} missing — arm {arm!r} hasn't been drawn yet by the research "
            "project's density step"
        )
    idx = np.load(idx_path)
    if idx.ndim != 1 or idx.dtype.kind not in "iu":
        raise ValueError(f"{idx_path}: expected a 1-D integer array, got {idx.shape} {idx.dtype}")
    n = len(idx)

    # The draw must be a strictly ascending set of valid pool rows: ascending is what
    # makes row_id <-> clip-row alignment true (the substrate was assembled in this
    # order), and strictness rules out a duplicated pool row silently appearing twice.
    if not (np.diff(idx) > 0).all():
        raise ValueError(f"{idx_path}: pool indices must be strictly ascending (sorted, no dups)")

    prov_shard = np.load(pool_dir / "prov_shard_idx.npy", mmap_mode="r")
    n_pool = len(prov_shard)
    if idx[0] < 0 or idx[-1] >= n_pool:
        raise ValueError(f"{idx_path}: indices outside the pool's [0, {n_pool:,}) rows")

    shard_idx = _gather("prov_shard_idx", idx, pool_dir, n_pool).astype(np.int64)
    local_row = _gather("prov_local_row", idx, pool_dir, n_pool).astype(np.int64)
    gathered = {name: _gather(name, idx, pool_dir, n_pool) for name in _POOL_COLUMNS}

    # subset == source, and both columns share the same interned strings: `subset` is
    # the name the generic pipeline code reads, `source` the dataset's own name for it.
    source = _intern_strings(gathered["source"])
    unknown = sorted(set(np.unique(gathered["source"]).tolist()) - set(MONET_SOURCES))
    if unknown:
        raise ValueError(
            f"source value(s) not in config.MONET_SOURCES: {unknown} — that mapping is "
            "frozen (built packs carry its codes); append the new source to it "
            "deliberately rather than letting a code be assigned implicitly"
        )

    # global_idx: the packed thumbnail ref (see lsvoxel/monet_thumbs.py). Packed with
    # the same function the server decodes with, then round-tripped below.
    packed = pack_thumb_ref(shard_idx, local_row)
    if packed.max() >= 2**32:
        raise ValueError("packed thumbnail refs exceed u32 — point_index.bin can't carry them")
    global_idx = packed.astype(np.uint32)
    back_shard, back_local = unpack_thumb_ref(global_idx.astype(np.int64))
    if not (np.array_equal(back_shard, shard_idx) and np.array_equal(back_local, local_row)):
        raise ValueError("packed thumbnail refs don't round-trip back to (shard_idx, local_row)")

    image_url, image_width, image_height = _gather_originals(shard_idx, local_row, urls_shards_dir)

    out = pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "subset": source,  # contract column: chunkpack/pointindex + minimap read this
            "source": source,  # MONET's own name for the same value
            "pool_row": idx.astype(np.int64),
            "id": gathered["id"].astype(object),
            "sscd_nn": gathered["sscd_nn"].astype(np.float32),
            "sscd_cluster_id": gathered["sscd_cluster_id"].astype(object),
            "aesthetic": gathered["aesthetic"].astype(np.float32),
            "shard_idx": shard_idx.astype(np.uint16),
            "local_row": local_row.astype(np.uint16),
            "global_idx": global_idx,  # contract column: point_index.bin's local_idx
            # original image at the source site (null for synthetic sources); 0 == unknown size
            "image_url": image_url.to_pandas(),
            "image_width": image_width,
            "image_height": image_height,
        }
    )

    # Same hard assertions bl.py carries: the whole pipeline assumes a dense,
    # row_id-ordered table with no gaps or duplicates, and every stage re-checks it.
    if not np.array_equal(out["row_id"].to_numpy(), np.arange(n, dtype=np.uint32)):
        raise ValueError("points table must be dense, row_id-ordered (0..N-1, no gaps)")
    if out["pool_row"].duplicated().any():
        raise ValueError("points table has duplicate pool_row values")

    clip_path = monet_draw_clip_path(arm)
    if clip_path.exists():
        clip_rows = np.load(clip_path, mmap_mode="r").shape[0]
        if clip_rows != n:
            raise ValueError(
                f"{clip_path} has {clip_rows:,} rows but the draw has {n:,} — row_id would "
                "not line up with the UMAP input"
            )
    else:
        print(f"[monet] note: {clip_path} not assembled yet — UMAP input missing for {arm!r}")

    write_points_table(out, out_path, MONET_CONTRACT_COLUMNS)
    return out


class MonetThumbnailSource(ThumbnailSource):
    """row_id -> thumbnail bytes, via the points table's `(shard_idx, local_row)`.

    Called roughly once per occupied voxel during an atlas build (hundreds of
    thousands of times), so the shard files stay open across calls — see
    `MonetThumbStore`, which owns the fd cache and the blob/offsets reads.

    Returns `b""` for a row whose thumbnail isn't available (shard not pulled yet, or
    a decode failure recorded during the pull) rather than raising, so a build over a
    partially-populated store produces blank tiles instead of dying — `chunkpack/
    atlas.py` skips and counts those.
    """

    def __init__(
        self,
        points_df: pd.DataFrame,
        shards_dir: Path = MONET_THUMBS_SHARDS_DIR,
        max_open_shards: int = DEFAULT_MAX_OPEN_SHARDS,
    ):
        if not (points_df["row_id"].to_numpy() == range(len(points_df))).all():
            raise ValueError("points_df must be dense, row_id-ordered (0..N-1, no gaps)")
        self._shard_idx = points_df["shard_idx"].to_numpy(dtype=np.int64)
        self._local_row = points_df["local_row"].to_numpy(dtype=np.int64)
        self._store = MonetThumbStore(shards_dir, max_open_shards)

    def open(self, row_id: int) -> bytes:
        return self._store.read(int(self._shard_idx[row_id]), int(self._local_row[row_id]))

    def close(self) -> None:
        self._store.close()
