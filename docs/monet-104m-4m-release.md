# MONET full corpus: 4M-trained basemap

Release: `monet-clip-basemap-full-4m-20260906a`, 512³ voxels, 16³ voxels per streaming chunk.

[Open the map](http://gsv.local:5300/?dataset=monet-clip-basemap-full-4m-512), or select
“MONET · CLIP ViT-B/32 · 4M head · 103.82M · 512³” in the dataset picker. The existing default is unchanged.

The map includes **103,816,750 images**: the existing 19,344,847 pool rows, then 84,471,903 complement rows. Both projections use **CLIP ViT-B/32, random 4M-trained basemap heads**, not the older 2M heads or the separate SSCD-sampled 4M model. No embeddings were downloaded or recomputed and no model was retrained.

## Inputs and identity

The research inputs are read-only:

- 2D: `/data/latent-basemap/sandbox/monet-clip-fullcorpus-proj-4m-20260905/coords.f32.npy`, checkpoint SHA-256 prefix `2a2597e2ce49b14f`.
- 3D: `/data/latent-basemap/sandbox/monet-clip-fullcorpus-proj-4m-3d-20260905/coords.f32.npy`, checkpoint prefix `c4de39cdd69556ea`.
- Thumbnails: `/data2/monet/pool-20m-thumbs256/`, all 10,880 shards complete. The existing packed `(shard << 16) | local_row` reference fits in u32 at this size; no thumbnail duplication is necessary.

The publisher checks full checkpoint hashes against the projection receipts, matching 2D/3D row layouts, every coordinate for finiteness, all thumbnail offset arrays and blob lengths, source categories, and every source row's shard/local address. Unique references plus matching total shard populations establish that the corpus covers the source rows exactly once. **The pool's row order is not shard order**; its provenance permutation is preserved. Existing pool URL metadata is reused only after comparing every pool thumbnail identity.

CPU re-inference of 64 evenly spaced rows from each half, through each head, reproduced coordinates with maximum absolute errors of `8.49e-6` / `9.78e-6` for 2D pool/complement and `3.81e-6` for both 3D halves.

## Geometry and browser cost

The build contains 2,318,931 occupied voxels across 5,448 chunks, averaging 44.77 images per occupied voxel. That is 1.73% occupancy of the 134,217,728 possible 512³ cells, not a dense volume texture. Voxel sizes and movement settings remain the same as the other 512³ maps.

The largest voxel contains **61,136 images**. The complete streaming pack is
**4,966,260,469 bytes (4.63 GiB)**, including **366,023,889 bytes (349.07 MiB)** of
compressed atlases. All density overview files together are **253,852 bytes
(247.90 KiB)**; the four display PNGs are 192,645 bytes (188.13 KiB).

Only the 3D framing extent uses a deterministic one-million-row sample. Every row is assigned and counted. Large builds write chunk IDs, local voxel IDs and representative distances to memory-mapped scratch arrays; normalization/distance work runs in one-million-row batches. The remaining global sort permutation uses 8 bytes per point. Observed atlas-stage process RSS was approximately 5 GiB on the shared research host, rather than materializing full Python-object source/URL tables and multiple N×3 float64 arrays.

The release retains the existing runtime contracts:

- Occupied-only 32px RGB/ETC1S atlases, with bounded 128px hover/sharp-band replacements.
- Hierarchical proxy bricks at steps 4, 2 and 1, selected by distance with existing cache limits.
- u32 voxel counts and separate, range-addressed mining postings. Mining never downloads all of a dense voxel at once.
- Fixed 512×512 2D density overview: one pixel per bin, every point counted, no point sprites. The four display PNGs total roughly 190 KiB. Exact 2D identities remain in ranged spatial pages, separate from this display.
- Ranged row→thumbnail, row→voxel and row→2D lookups; no 100M-entry browser arrays. The shared range cache remains capped at 16 MiB and individual reads at 1 MiB.

Full row-table sizes on disk are 792.06 MiB each for the thumbnail and voxel indexes, 396.03 MiB each for mining postings in aggregate and row→2D coordinates, and 1.547 GiB for the 16-byte spatial records. These are server/CDN storage, **not startup downloads**. Browser streaming limits have not been raised for this release.

The shared 256px thumbnail store contains 828,415,235,818 bytes of image blobs (771.5 GiB), plus 830,621,040 bytes of shard offsets (792.1 MiB). Those images already existed and are not duplicated by the map build. Only requested thumbnails are delivered to the browser; this large static store is distinct from the voxel atlases and runtime texture caches.

## Known image limitations

159,617 source images (0.154%) failed decoding during the completed thumbnail pull. Their zero-length spans remain explicit missing images, not fabricated black thumbnails. A voxel whose selected representative lacks a thumbnail can have a blank atlas tile even though other images in that voxel are available.

The finished pack has 3,776 blank representative tiles (0.163% of occupied voxels).

Original-image URL metadata currently covers **only the initial 19.34M pool rows**. Those URLs and dimensions are preserved; complement metadata is explicitly empty and the lightbox falls back to the available 256px thumbnail. The provenance receipt records this limitation. Complement original URLs have not been downloaded. A future full URL collection needs partitioned metadata or wider URL offsets, because a single v1 URL blob is limited to 4 GiB. This release's URL blob remains the existing pool-sized blob, safely below that limit.

The local text-navigation comparison still targets its original 2.01M dataset; this release does not quietly turn that exact search into a 100M search or apply its older text-projection heads to a different coordinate frame.

## Reproduce and audit

From the repo root:

```bash
nice -n 10 pipeline/.venv/bin/python -u pipeline/scripts/build_fullcorpus_monet.py --release 20260906a --voxels 512
```

An existing release is never overwritten. Use a new alphanumeric release ID for another build. `--resume` can reuse completed, verified points/minimap/source stages of an unpublished build. Four bounded atlas workers each use at most two encoder threads; the queue holds at most four jobs and results retain only small color arrays, not images. `--reuse-atlases <interrupted-staging-directory>` can reuse completed atlases from this exact release after checking occupied IDs, representative rows and texture dimensions; geometry, postings and manifests are regenerated. The final streaming manifest is written last, and the dataset registry is updated only after publication and validation.

```bash
/home/enjalot/code/latent-basemap/.venv/bin/python pipeline/scripts/verify_fullcorpus_monet.py \
  /data/latent-scope-3d/chunks/monet-clip-basemap-full-4m-20260906a-512-stream \
  /data/latent-scope-3d/points/monet-clip-basemap-full-4m-20260906a \
  --check-heads --report /data/latent-scope-3d/reports/monet-104m-4m-20260906a.json
```

The read-only audit re-derives **all** row→voxel and row→2D joins from the source coordinates, checks every thumbnail/source code, verifies postings cover all rows exactly once, checks representatives and posting order, checks spatial page bounds/joins, and conserves counts at every proxy-brick refinement. Unit tests compare disk-backed assignment with the existing in-memory algorithm, including ties/outliers/batch boundaries; test shuffled source provenance and original-URL preservation; and inject duplicate postings into a fixture to prove the publication audit rejects them.

## Verification result and rendering follow-up

The [full-data audit receipt](benchmarks/monet-104m-4m-20260906a.json) passed all
103,816,750 row joins, exact-once postings/spatial membership and proxy count
checks, including re-inference through both checkpoints. All 88 pipeline and 89
frontend unit tests pass; type checking and production build pass. The existing
large-JavaScript-bundle warning remains.

A successful non-instrumented browser check resolved the last row (103,816,749,
thumbnail reference 712,976,143), mined 100 distinct images from an 807-image voxel,
and advanced the preview to the next unmined row. All 91 range requests returned
206; no whole-corpus binary table was requested. That check ended with 38 resident
chunks, 9,905 voxel instances, 21,368,000 accounted chunk bytes and a 219,912-byte
range cache, with no JavaScript or GL error. These are one view's working-set
counters, not total browser memory or a hardware performance benchmark.

There is an **open rendering follow-up**: an earlier headless SwiftShader run
returned `GL_INVALID_VALUE`; an additional instrumented run lost its WebGL context
and then reported stale-context buffers from the instancing library. The clean
repeat passed, but the cause of the first error is unconfirmed. This release does
not claim context-loss recovery is fixed or that software-renderer checks establish
real-GPU performance. The map-data audit passed independently of those browser
runs. No full e2e suite was added.
