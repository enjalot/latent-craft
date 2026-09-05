# MONET CLIP basemap maps — September 5, 2026

These maps use the recently trained **single-seed focused** latent-basemap heads,
not a new UMAP fit. Both take CLIP ViT-B/32 embeddings; the 2D and 3D heads are
separate models. The SSCD UMAP dataset remains the default and keeps its own save.

## Row identity

The training sample has **2,008,321** rows, sampled by source shard. It is NOT the
existing 2,000,000-row SSCD draw. The full pool contains **19,344,847** rows.

Training coordinates come from:

- `/data/latent-basemap/sandbox/monet-random-clip-2m/champion-bs16k/coordinates.npy`
- `/data/latent-basemap/sandbox/monet-random-clip-2m-3d/champion-bs16k/coordinates.npy`

Pool coordinates come from the `monet-clip-fullpool-proj-20260905` and
`monet-clip-fullpool-proj-3d-20260905` directories in the same sandbox. Their
manifests record the matching checkpoint and row alignment to `pool-20m`.
Nothing in the research directories or `/data2` was changed.

The builder joins training source-shard paths and local row numbers to the pool's
provenance, then verifies **every image ID**. The pool is not shard-ordered, so
this explicitly uses a sorted packed-reference index rather than assuming that
matching shards occupy consecutive pool positions. Thumbnail references use
the existing `(shard_index << 16) | local_row` store addresses.

All training coordinates were also compared against the corresponding full-pool
positions: maximum absolute difference **0.00006104 in 2D**, **0.00001335 in 3D**;
mean absolute differences about 1.37e-7 and 8.65e-8 respectively. These are small
floating-point differences, not different layouts.

## Training release

Picker key: `monet-clip-basemap-training-512`.
Pack: `/chunks/monet-clip-basemap-training-20260905a-512-stream`.
Points and 2D minimap ID: `monet-clip-basemap-training-20260905a`.

- 215,032 occupied voxels across 1,486 chunks at 512³; densest voxel 1,256 images.
- 40,230,260 bytes of KTX2 atlases; 1,911,894,016 bytes if all atlases were loaded
  as RGBA. Those are corpus totals, not browser startup allocations.
- 4,779,536 bytes of hierarchical bricks; 1,964 hierarchy nodes.
- Complete streaming pack: 368,229,832 bytes, including copied 2D density tiles.
  Original thumbnails, URL metadata, build inputs and intermediate packs are separate.
- 55 missing representative thumbnails (0.026%) give blank atlas tiles; their
  point identities and all other images in those voxels remain accessible.

The audit checked every referenced hash, all point-to-voxel and thumbnail joins,
every posting exactly once, all hierarchy count sums, and coordinate rebinning
against the original 3D projection. Browser checks loaded the linked 2D map,
streamed chunks and sharp previews, and mined 100 images with the next image
advancing correctly. Observed point/spatial lookup responses were 206 ranges,
no larger than 32 KiB, rather than full point-table downloads.
At a close food-cluster view, a follow-up check had 21 resident chunks (18.7 MiB
tracked chunk/atlas allocation), 6,968 resident voxels, five sharp images and
0.35 MiB of cached range data. The fixed sharp pool adds 10.67 MiB GPU + 8 MiB
CPU pixels. These are a view sample, not an entire-browser memory measurement;
the chunk admission budget remains 256 MiB and the range cache 16 MiB.

## Reproduction

From `pipeline/`:

```sh
.venv/bin/python scripts/build_basemap_monet.py training --release 20260905a --voxels 512
.venv/bin/python scripts/build_basemap_monet.py pool --release 20260905a --voxels 512
```

Use a **new** release identifier for a fresh build. `--resume` reuses verified
point/minimap stages of an unpublished release; it does not overwrite a published
streaming pack. For a service without the interactive shell's PATH, pass
`--basisu /home/enjalot/.local/bin/basisu`. Atlas generation is an offline CPU/I/O
step, independent of the inexpensive model projection or client streaming cost.

`scripts/audit_streaming_pack.py <pack directory> --coordinates <coords3d.npy>`
performs the full read-only audit. Serving retains the existing bounded
hierarchical bricks, compact atlases, byte-ranged postings and lookup caches.
