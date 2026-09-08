# Full-corpus MONET maps

The full corpus contains 103,816,750 images: 19,344,847 pool rows followed by
84,471,903 complement rows. Projection row order is preserved through thumbnail
references, voxel postings, and 2D spatial indexes. Source-shard order is not
interchangeable with projection row order.

## Model profiles

`pipeline/scripts/build_fullcorpus_monet.py` supports two explicit profiles:

| Profile | Embeddings supplied to the head | Training draw |
| --- | --- | --- |
| `clip-4m` | CLIP ViT-B/32, 512 dimensions | 4M |
| `dino-6m-pca768` | DINOv2 ViT-g/14, centered PCA to 768 dimensions, then L2 normalized | 6M |

Each profile pairs separately trained 2D and 3D heads using the same embedding
representation. The DINO profile uses the saved PCA transform fitted on the
training draw, not a new transform fitted on the full corpus. A separately
trained direct-DINO-1536 2D projection is not substituted into this pair.

The registered DINO release is `monet-dino-basemap-full-6m-pca768-20260908a`;
select `?dataset=monet-dino-basemap-full-6m-pca768-512` on a frontend with its
data routes configured. Its completed full-row audit measured:

| Quantity | Value |
| --- | ---: |
| Occupied voxels | 1,408,316 |
| Streaming chunks | 4,446 |
| Largest voxel | 91,696 images |
| Complete streaming pack | 4,732,488,380 bytes (4.41 GiB) |
| Compressed atlases, included in pack | 230,019,081 bytes (219.36 MiB) |
| Density overview files, included in pack | 276,667 bytes (270.18 KiB) |

These are server-side file sizes, excluding the shared thumbnail store and build
intermediates. They are not browser memory requirements or startup transfers.
This release retains the existing browser cache limits.

## Build and verify

The publisher currently targets the research host's prepared source layout;
inspect `PROFILES`, `SANDBOX`, and `lsvoxel.config` before using it elsewhere.
It requires completed projection receipts, matching source columns and thumbnail
shards, the prior pool metadata table, and Basis Universal's `basisu` encoder.
Head re-inference additionally requires PyTorch and the sibling `latent-basemap`
model implementation. It runs on CPU without allocating a GPU.

From the repository root, using a Python environment with these dependencies:

```bash
python pipeline/scripts/build_fullcorpus_monet.py \
  --profile dino-6m-pca768 --release RELEASE_ID --voxels 512 \
  --atlas-workers 4 --check-heads

python pipeline/scripts/verify_fullcorpus_monet.py \
  /path/to/published-stream-pack /path/to/published-points \
  --check-heads --report /path/to/audit.json
```

Replace `RELEASE_ID` with a fresh alphanumeric identifier. Existing releases
are never overwritten. `--resume` is for completed stages of an unpublished
build, not changing the inputs of an existing release. Register the new dataset
only after the final pack passes its audit. Give a new projection its own
dataset/save identity; changing voxel assignments invalidates old stack IDs.

Preflight checks projection/model hashes, finite coordinates, matching source
layouts, thumbnail shard boundaries and source identities. The post-build audit
reconstructs every row's voxel and 2D position from the original coordinates,
checks thumbnail identities, exact-once postings and spatial membership, and
count conservation through proxy refinements. Sampled CPU re-inference checks
that the saved head and PCA reproduce coordinates from both corpus halves.

## Storage is not the browser working set

Both profiles use occupied-only 512³ voxels grouped into 16³ streaming chunks,
32px compressed atlases, hierarchical proxy bricks, and bounded 128px sharp
previews. The 2D overview is a fixed 512×512 density heatmap counting every image;
exact identities use separate ranged spatial pages.

The 103.82M-row tables stay on the data server. The client range cache is bounded
and mining reads postings in pages, even for very dense voxels. Existing packed
256px thumbnail blobs are shared by releases rather than duplicated. See
[streaming architecture](streaming-architecture.md) for binary layouts and cache
budgets. Generated packs, model weights, search indexes, and corpus images do
not belong in Git; only the small application theme textures are bundled.

Original URL metadata currently covers the initial pool, not the complement.
Complement images use available 256px thumbnails. Known failed source decodes
remain missing images and can produce blank representative tiles. A map build
does not add full-corpus text search; a CLIP text-navigation head cannot be used
in the DINO coordinate frame.
