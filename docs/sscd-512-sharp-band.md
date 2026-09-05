# SSCD 512, sharp previews, and 64px atlas costs

Measured September 5, 2026. Sizes below use decimal MB/GB unless marked MiB.

## Published pack

Default dataset: `monet-sscd-512`, label `MONET · CLIP ViT-B/32 · SSCD draw · 2M · 512³`.
The 160 option remains available. Both reuse the same UMAP coordinates and 2M draw;
no new fit, embedding extraction, or sample was made.

Immutable release: `/data/latent-scope-3d/chunks/monet-sscd-512-stream-20260905a`.
Built with `pipeline/scripts/run_streaming_monet.py sscd --voxels 512 --release 20260905a`.

- 2,000,000 points, 304,083 occupied voxels, 1,608 chunks, 2,329 hierarchy nodes.
- Cell width: 0.1953125 world units; visible cube edge: 0.15625; chunk edge: 3.125.
- Chunk atlases: 53.14 MB compressed; 2.662 GB decoded as RGBA if *all* loaded.
- Chunk summaries: 105.43 MB. Proxy brick records: 6.39 MB.
- Complete published directory: 398.87 MB, including 147.49 MB of copied minimap
  density tiles across zoom levels. It excludes source thumbnails and original images.
- 343 unavailable representative thumbnails produce blank tiles (0.113% of occupied
  voxels). Their counts, postings, and other images in those voxels remain valid.

Validation compared every voxel count against the independent article's full-2M
rebin, checked all atlas/summary/posting hashes and sizes, and proved that the
concatenated postings contain each row 0–1,999,999 exactly once.

## 128px sharp band

`SharpBand` considers resident cubes whose centers are between R and R + one
voxel, where R is the current effector radius. Hover takes priority even outside
that shell. All-direction candidates are prioritized toward the camera's view,
and the selected set is capped at 128. The scan is chunk-bounded and runs at
10Hz; each frame rechecks residency, the moving suppression boundary, and mining
state. Finer datasets do not increase the cache capacity.

`PreviewPool` uses one instanced mesh and a 128-layer, 128×128 RGBA texture array.
It holds 8 MiB of base pixels on the CPU and 10.67 MiB of GPU texels including
mipmaps, independent of cache occupancy. This is separate from the conservative
256 MiB chunk-admission reservation, not included in that cap. Transient decoded
bitmaps, completed-but-not-yet-uploaded pixels, driver storage, and network
buffers are additional, bounded by concurrency or slot count.

At most four row resolution / thumbnail requests / decodes are active, and two
layers become upload-ready per animation frame. Only changed array layers upload;
mipmaps are generated once on an updated texture in that render. Inactive ready
layers form a bounded warm LRU. Failures back off for two seconds. Aborted or
superseded requests cannot install an image into a reassigned slot.

Preview row lookups use the next mining row, not the fixed atlas representative.
They share bounded posting pages but do not replace the hovered voxel's prepared
100-row mining batch. Extracting or returning images changes the preview key.
Evicted/suppressed/empty blocks cannot retain a visible overlay. Ready overlays
replace the source cube's opacity without disabling its raycast, so glass view
does not render the image twice. The image array is sRGB and center-cropped like
the base atlas.

128px currently reduces GPU/upload size, **not source download size**: the server
still returns its existing thumbnail. The browser crops/downsamples it to 128px
and closes the source bitmap. A CDN-hosted 128px variant would be a separate change.

## What would 64px base atlases cost?

| Whole-pack atlas quantity | 160 / 32px | 160 / 64px | 512 / 32px | 512 / 64px |
| --- | ---: | ---: | ---: | ---: |
| Compressed CDN bytes | 5.65 MB measured | ~17.91 MB estimated | 53.14 MB measured | ~183.46 MB estimated |
| RGBA GPU footprint if all resident | 252.56 MB | 1.010 GB | 2.662 GB | 10.647 GB |
| 4-bit RGB GPU example if all resident | 31.57 MB | 126.28 MB | 332.72 MB | 1.331 GB |

Doubling the tile edge quadruples texel storage. It does **not** necessarily
quadruple KTX2 transfer. The estimates above actually re-encode 16 sampled chunks
per resolution at 64px, with four occupancy strata and four quantile samples per
stratum. Within each stratum, its sampled 64/32 byte ratio is applied to the
full stratum's measured 32px bytes. This is a content-dependent extrapolation,
not a measured full 64px release or a confidence interval. Samples and exact
per-chunk sizes are in `measurements/atlas64-sscd{160,512}-20260905.json`.
The reproducible script is `pipeline/scripts/cost_atlas_resolution.py`.

At 512, a 64px release would be approximately 529.19 MB including the unchanged
non-atlas files, versus 398.87 MB today. Source-thumbnail storage is separate.

The runtime tradeoff matters more than this static increase. At the article's
example camera (-15.3125, -5.3125, -3.75), facing -Z, the existing admission
rules admit 46 chunks / 28,606 instances at 32px. With the same rules and 64px
atlas dimensions, they would admit **13 chunks / 9,084 instances**. The
conservative RGBA reservation, not compressed CDN bytes, is binding here.
Actual hardware-compressed GPU memory may be lower, but that does not change
the current admission rule. This is an arithmetic simulation, not an FPS test.

A full chunk's atlas would become 4096×4096 rather than 2048×2048. A future
64px build must set both `tile_px=64` and `atlas_px=4096`; changing only tile size
would reduce tile capacity and fail for dense chunks. Summaries, point files,
voxel geometry, and image counts do not otherwise grow because tile size changes.

For now, the published 512 pack stays at 32px, with 128px hover/band previews.
This keeps broad coverage while spending sharp-image memory near interaction.

## Effector geometry

Superseded by the [solid-marker visual pass](game-session-and-visuals.md):
72 beveled solid bars, merged into one draw, have their centres on the true
camera-centred sphere. Fixed slots prevent rotation/pop. Angular aperture now
grows with radius so scrolling is visible in empty space; the original fixed
3/6/9 geodesic offsets and curved surface patches did not provide that cue.
Markers appear while resizing, hold briefly, and fade out by 900ms.

Tests cover surface radii/aim/fade, the sharp shell, concurrency/upload/cache
bounds, stale async completion, retry backoff, transparent state, and independent
mining-page lookup. Browser checks exercise both 160 and 512 rendering without
shader errors. Software-rendered headless FPS is not treated as a device benchmark.
