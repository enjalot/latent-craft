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
}
