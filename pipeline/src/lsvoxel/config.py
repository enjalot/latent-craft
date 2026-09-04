"""Dataset registry: per-dataset paths and conventions.

Adding a new dataset means adding one entry here plus a datasets/<id>.py module
implementing build_points_table() and a ThumbnailSource — nothing else in the
pipeline should need to know a dataset's specifics.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

DATA_ROOT = Path("/data/latent-scope-3d")
UMAP06DEV_PYTHON = Path("/data/latent-basemap/umap06dev-env/bin/python")


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    embedding_dim: int
    embedding_dtype: str
    points_table: Path
    umap_dir: Path
    chunks_dir: Path
    minimap_dir: Path


def points_table_path(dataset_id: str) -> Path:
    return DATA_ROOT / "points" / dataset_id / "points.parquet"



def umap_run_dir(dataset_id: str, run: str = "umap-001") -> Path:
    return DATA_ROOT / "umap" / dataset_id / run


def chunks_dir(dataset_id: str) -> Path:
    return DATA_ROOT / "chunks" / dataset_id


def minimap_dir(dataset_id: str) -> Path:
    return DATA_ROOT / "minimap" / dataset_id


BL_SUBSTRATE = Path("/data/latent-basemap/substrates/bl-siglip2-1m/substrate.f16.npy")
BL_ROWS_PARQUET = Path("/data/latent-basemap/substrates/bl-siglip2-1m/rows.parquet")
BL_THUMBS_MANIFEST_ROOT = Path("/data/images/british-library-book-images/thumbs/manifest")
BL_THUMBS_ROOT = Path("/data/images/british-library-book-images/thumbs")
BL_SUBSETS = ("covers", "medium", "embellishments", "plates")
#: fname -> Flickr photo lookup (1,019,200 rows, keyed by (fname, image_type)). The
#: full-resolution originals of the BL images live on Flickr, not on this box, so a
#: point's `image_url` is that table's `flickr_original_url`. The 61,548 `covers` rows
#: have no Flickr counterpart at all, and a few thousand rows carry no original URL.
BL_FLICKR_TABLE = Path("/data/images/british-library-book-images/flickr-metadata/fname_to_flickr.parquet")

# ---------------------------------------------------------------------------
# MONET (jasperai/monet) — the 19.3M-row "pool" and the 2M-row research draws
# ---------------------------------------------------------------------------
# READ-ONLY, all of it: `/data2/monet/` is shared with a separate, currently
# active MONET-eval research project. This pipeline reads `pool-20m/`, `draws/`
# and `pool-20m-thumbs256/` and writes nothing under `/data2` — its own outputs
# go to DATA_ROOT like every other dataset's.

MONET_POOL_DIR = Path("/data2/monet/pool-20m")
MONET_DRAWS_DIR = Path("/data2/monet/draws")
#: Packed thumbnail store built by `scripts/pull_pool_thumbs256.py` (blob+offsets
#: per HF shard, in the pool's own shard order). See `lsvoxel/monet_thumbs.py`.
MONET_THUMBS_DIR = Path("/data2/monet/pool-20m-thumbs256")
MONET_THUMBS_SHARDS_DIR = MONET_THUMBS_DIR / "shards"
#: Per-shard `url`/`width`/`height` of every pool row, pulled by
#: `scripts/pull_pool_urls.py` in the same shard order as the thumbs store, so a
#: point's `(shard_idx, local_row)` addresses both. Crawl sources carry the source
#: site's original-image URL; synthetic sources have none (their 384px thumbnail is
#: the largest image that exists).
MONET_URLS_DIR = Path("/data2/monet/pool-20m-urls")
MONET_URLS_SHARDS_DIR = MONET_URLS_DIR / "shards"

#: The research project's draw arms. `random`/`sscd` exist today; `annfaiss` and
#: `theirfaiss` land as their density steps finish. Everything downstream is
#: arm-parameterized, so a new arm needs no code change — only its
#: `{arm}.idx.npy` + `{arm}-clip.f32.npy` in MONET_DRAWS_DIR.
MONET_ARMS = ("random", "sscd", "annfaiss", "theirfaiss")

#: MONET's `source` column doubles as this dataset's `subset` axis (per-subset
#: minimap density planes, `subset_code:u8` in `point_index.bin`) — and unlike a
#: purely-synthetic reading of the name, it splits real crawl corpora from
#: generated ones, which is the interesting axis to colour a map by.
#:
#: FROZEN name -> code mapping over the 9 sources the pool manifest's
#: `source_counts` records, in that manifest's own (alphabetical) order. It is
#: deliberately NOT derived from whatever sources happen to appear in a given
#: draw: codes must mean the same thing across arms and across rebuilds, since
#: every built `point_index.bin` and minimap pack carries them. Never renumber;
#: append only. An unknown source fails the build loudly (see
#: `datasets/monet.py::build_points_table`) rather than silently taking a new code.
MONET_SOURCES = {
    "cc12m": 0,
    "commoncatalog-cc-by": 1,
    "coyo": 2,
    "diffusion-aesthetic-4k": 3,
    "laion": 4,
    "megalith10m": 5,
    "synthetic-flux-klein": 6,
    "synthetic-flux-schnell": 7,
    "synthetic-z-image": 8,
}

#: Which of the above are model-generated rather than crawled — metadata only
#: (nothing in the pipeline branches on it), kept next to the mapping so the
#: real-vs-synthetic split has one definition.
MONET_SYNTHETIC_SOURCES = frozenset(
    {"diffusion-aesthetic-4k", "synthetic-flux-klein", "synthetic-flux-schnell", "synthetic-z-image"}
)

#: MONET's thumbnails are byte ranges in packed blobs, not files, so they are
#: served by `scripts/data_server.py`'s dynamic `/thumbs/monet/<packed>.webp`
#: route. `{local_idx}` is the packed `(shard_idx, local_row)` ref — see
#: `lsvoxel/monet_thumbs.py`. Written into each chunk-pack manifest as
#: `thumb_url_template`; the frontend renders it under its `/thumbs` base.
MONET_THUMB_URL_TEMPLATE = "monet/{local_idx}.webp"

#: CLIP-512 is what the research project already assembled per draw
#: (`{arm}-clip.f32.npy`), so it's the UMAP input here — no embedding pull needed.
MONET_EMBEDDING_DIM = 512
MONET_EMBEDDING_DTYPE = "float32"


def monet_dataset_id(arm: str) -> str:
    """`random` -> `monet-random`. The dataset id used for every DATA_ROOT path
    (points table, umap run, chunks, minimap) and in the frontend's registry."""
    return f"monet-{arm}"


def monet_draw_idx_path(arm: str) -> Path:
    """int64 pool-row indices for a draw arm, sorted ascending, 2,000,000 long."""
    return MONET_DRAWS_DIR / f"{arm}.idx.npy"


def monet_draw_clip_path(arm: str) -> Path:
    """(2,000,000, 512) float32 CLIP for a draw arm, row i == pool row idx[i]."""
    return MONET_DRAWS_DIR / f"{arm}-clip.f32.npy"


def _monet_spec(arm: str) -> DatasetSpec:
    dataset_id = monet_dataset_id(arm)
    return DatasetSpec(
        dataset_id=dataset_id,
        embedding_dim=MONET_EMBEDDING_DIM,
        embedding_dtype=MONET_EMBEDDING_DTYPE,
        points_table=points_table_path(dataset_id),
        umap_dir=umap_run_dir(dataset_id),
        chunks_dir=chunks_dir(dataset_id),
        minimap_dir=minimap_dir(dataset_id),
    )


DATASET_SPECS = {
    "bl": DatasetSpec(
        dataset_id="bl",
        embedding_dim=1152,
        embedding_dtype="float16",
        points_table=points_table_path("bl"),
        umap_dir=umap_run_dir("bl"),
        chunks_dir=chunks_dir("bl"),
        minimap_dir=minimap_dir("bl"),
    ),
    # One entry per draw arm, same shape as BL's — arm-qualified dataset ids reuse
    # the standard points/umap/chunks/minimap layout rather than inventing a
    # per-arm subdirectory scheme.
    **{monet_dataset_id(arm): _monet_spec(arm) for arm in MONET_ARMS},
}
