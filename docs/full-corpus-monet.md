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
data routes configured. The current storage-only repack is
`monet-dino-basemap-full-6m-pca768-20260908a-512-web-20260908b`.
Its completed full-row audit measured:

| Quantity | Value |
| --- | ---: |
| Occupied voxels | 1,408,316 |
| Streaming chunks | 4,446 |
| Largest voxel | 91,696 images |
| Complete compact streaming pack | 3,739,632,688 bytes (3.48 GiB) |
| Saved against the original streaming pack | 992,855,692 bytes (20.98%) |
| Compressed atlases, included in pack | 230,019,081 bytes (219.36 MiB) |
| Density overview files and gzip sidecar, included in pack | 276,941 bytes (270.45 KiB) |

These are server-side file sizes, excluding the shared thumbnail store and build
intermediates. They are not browser memory requirements or startup transfers.
Desktop retains the existing distance/residency budgets. Touch devices use the
smaller profile described below. The repack preserves image/voxel identities and
the original `save_identity`, so existing inventories and CSV files remain valid.

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

For a storage-only publication repack, preserve the source and use a fresh output:

```bash
python pipeline/scripts/compact_streaming_pack.py /path/to/stream-pack /path/to/new-web-pack
python pipeline/scripts/verify_fullcorpus_monet.py /path/to/new-web-pack /path/to/points --check-heads
```

Compaction removes padding from lookup records, stores only occupied voxel
summaries where smaller, minifies JSON and adds gzip sidecars. It does not change
embeddings, counts, geometry, atlas ordering, or postings. Unchanged binary files
are hardlinked on the same filesystem, copied across filesystems; both releases
must remain immutable. Compact readers still accept legacy packs.

## Mobile and publication profile

Touch phones/tablets show a data-use consent dialog before importing the 3D
engine or fetching map assets. Copying the URL does not start the map; plain-HTTP
LAN clipboard fallback is supported. `?mobile=1` previews this mode on desktop,
and `?mobile=0` explicitly opts into the desktop layout.

Mobile uses a D-pad, separate up/down buttons, drag-to-look, and a held 256px image
preview. Collection pauses until that preview is decoded. It retains small saved
thumbnails (16 block rows per page), skips the minimap and automatic sharp band,
caps device pixel ratio at 1.25 and framebuffer area at one million pixels, and
targets at most 30 rendered frames/s. Chunk admission is bounded by 12 chunks,
24,576 voxel instances and a conservative 96 MiB reservation. These are not total
browser-memory limits or a phone FPS guarantee. Tabs pause rendering while hidden.

A cold local production-browser sample at 390×844 transferred about 4.2 MB to
reach four resident chunks; its accounted chunk resources were 16.25 MiB. The
pre-consent page used about 6 KB and requested no map data. Routes, devices,
compression and cache state change these values. The warning budgets 5–15 MB to
start and explains that extended exploration can exceed 100 MB.

Maps without a `searchProfile`, including DINO, do not show or load search UI.
`VITE_DEMO_DATASET` restricts a publication build's picker to that one dataset.

## Direct static thumbnail serving

The optional `VITE_MONET_THUMB_PACK_URL` enables browser-to-object-storage
thumbnail ranges without a per-image application server. Prepare its small index:

```bash
python pipeline/scripts/prepare_monet_thumbnail_cdn.py /path/to/thumbnail-store /path/to/thumb-publication
```

Publish the generated manifest at the configured URL, with existing source
`shards/*.blob` and `shards/*.offsets.u64` beneath it. No images are re-encoded or
duplicated per map. A cold thumbnail takes a 16-byte offset-pair range, then its
WebP range; both must return valid 206 responses. Missing decode spans are not
replaced with another image. The complete shared store has 828,415,235,818 image
bytes plus 830,621,040 offset bytes; its manifest is 178,874 bytes before gzip.

Use `VITE_DATA_ORIGIN` for chunk/minimap data and an absolute
`VITE_MONET_THUMB_PACK_URL` for this shared thumbnail manifest. Keep binary ranged
objects identity-encoded. Only JSON/page assets should use HTTP compression.
For exported permanent thumbnail URLs, retain a resolver at `VITE_THUMBS_ORIGIN`;
the direct range client itself does not require it. Desktop original-URL metadata
still needs the existing `/meta` service unless a static `pointMetaFile` is set.

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
