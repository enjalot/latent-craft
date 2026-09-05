# Which embedding am I looking at?

Audit date: 2026-09-05. The existing MONET maps use **CLIP ViT-B/32**, not DINO.
British Library uses **SigLIP 2**. A MONET draw arm describes the sampling rule;
it does not describe the feature space UMAP projects. In particular, “SSCD draw”
does not mean “UMAP of SSCD embeddings.”

| Stable dataset key | UMAP embedding | Rows | Occupied voxels at 160³ |
| --- | --- | ---: | ---: |
| `bl-160` | SigLIP 2, 1152 dimensions | 1,080,814 | 14,688 |
| `monet-random-160` | CLIP ViT-B/32, 512 dimensions | 2,000,000 | 23,779 |
| `monet-sscd-160` | CLIP ViT-B/32, 512 dimensions | 2,000,000 | 29,030 |
| `monet-annfaiss-160` | CLIP ViT-B/32, 512 dimensions | 2,000,000 | 27,848 |
| `monet-theirfaiss-160` | CLIP ViT-B/32, 512 dimensions | 2,000,000 | 26,933 |

The picker and HUD show the embedding name. URL keys and points-table IDs remain
unchanged so existing links, inventory identities and metadata endpoints keep
working.

## The requested 2M CLIP / SSCD / 0.6dev map is already live

The default `?dataset=monet-sscd-160` selects this complete chain:

1. Pool CLIP features: `/data2/monet/pool-20m/clip512.f32.npy`.
2. Fixed draw IDs: `/data2/monet/draws/sscd.idx.npy`.
3. Row-aligned UMAP input: `/data2/monet/draws/sscd-clip.f32.npy`,
   shape `(2_000_000, 512)`, float32.
4. Completed 2D and 3D fits:
   `/data/latent-scope-3d/umap/monet-sscd/umap-001/`.
5. Minimap: `/data/latent-scope-3d/minimap/monet-sscd/`.
6. Active immutable 160³ streaming pack:
   `/data/latent-scope-3d/chunks/monet-sscd-160-stream-20260904b/`.

The fit metadata records cosine distance, 25 neighbors, `min_dist=0`, seed 42,
and independent 2D / 3D fits. Recorded runtimes were 644.16 and 668.63 seconds.
No duplicate fit or pack was launched for the naming change.

## Model evidence and version boundary

- The local pool ingestion script,
  `../latent-basemap/experiments/sandbox/monet_download_pool_clip.py`, explicitly
  reads MONET's `embedding_clip-vit-base-patch32` column. This establishes
  **CLIP ViT-B/32**; the dimension alone would not establish the model.
- `../latent-basemap/experiments/sandbox/monet_assemble_draw.py` gathers
  `clip512[idx]` into each `{arm}-clip.f32.npy`. Existing saved draw IDs, not a
  newly generated sample, define the row order.
- Every MONET run's `meta.json` under `/data/latent-scope-3d/umap/` points to
  the matching `*-clip.f32.npy` input and records 512 source dimensions.
- `/data/latent-basemap/substrates/bl-siglip2-1m/manifest.json` identifies
  “siglip2 (as shipped with biglam/british-library-book-images)” and 1152
  dimensions. It does not identify a narrower checkpoint, so the label does not
  invent one.
- All five runs record `umap_version: "0.6.0"` and the development environment
  `/data/latent-basemap/umap06dev-env`, with recorded source revision `67ca365`.
  Importing that environment today confirms version `0.6.0`. **The revision is
  historical recorded provenance, not independently reverified:** the old fit
  helper hardcodes that string, and the local source-clone path in the installed
  package's `direct_url.json` no longer exists. This is the project's “0.6dev”
  installation, not a newly installed PyPI release.

## Verification performed

For all five maps, checked input array dimensions, finite 2D/3D coordinates,
points-table row counts, 160³ manifest resolution, summed chunk point counts,
and existence of the minimap manifest.

For SSCD, additionally checked all 2M points-table `pool_row` values against
`sscd.idx.npy`, dense ordered `row_id`s, 101 spread embedding-row probes against
the corresponding pool rows, and every atlas/summary/postings file's declared
byte size across all 229 chunks. Embedding probes are a sampled alignment check,
not a full 4GB source checksum or an independent rerun of UMAP.
