# 103.8M CLIP costs and occupancy filtering

September 6, 2026. Local artifact inspection and the earlier measured search
pilot; no new cloud deployment or search-index build.

## Settings changes

“Hide voxels with ≤ N images” starts off, with N = 1. Both values persist with
the dataset's movement settings. Counts mean **original occupancy**, not images
left to mine. Filtering does not delete inventory or alter map files.

The textured mesh, cage, picking, effector ghosts and sharp/hover overlays share
the visibility gate. Resizing/moving the effector or reloading a chunk cannot
restore a filtered voxel. Legacy voxel previews respect the same threshold.
Hierarchical preview cells are kept only if at least one child voxel exceeds N;
using their summed count would incorrectly retain clusters of singletons.

The existing hierarchy does not store maximum child counts. While filtering,
selected coarse bricks therefore fetch their finest records through the existing
bounded range reader: at most 64 KiB logical data per chunk (4,096 × 16 bytes),
sharing the four-request proxy queue and 16 MiB range cache. Cells are hidden
until their exact child maxima arrive. Retained maxima cost four bytes per cached
proxy instance, about 512 KiB at the nominal 131,072-instance cache budget;
temporary reduction scratch is 16 KiB per completed request. Coarse source
records are retained until reduction, at most 16 bytes per cached instance.
Cache limits still protect visible bricks, so these are budget-based figures,
not new hard global memory caps. No additional disk assets are required.

Distant whole-region bounds remain spatial context rather than claiming to be
individual voxels; the minimap remains the unfiltered whole-dataset density map.
Filtering reduces draw/picking work but does **not** prune atlas/chunk downloads
or compact their resident GPU allocations.

Actual counts from the published full-map source `voxel_proxy.bin`:

| Hide count ≤ | Voxels hidden | Fraction of occupied voxels | Images in those voxels |
| ---: | ---: | ---: | ---: |
| 1 | 1,138,173 | 49.08% | 1,138,173 |
| 2 | 1,521,228 | 65.60% | 1,904,283 |
| 5 | 1,875,081 | 80.86% | 3,204,374 |
| 10 | 2,022,031 | 87.20% | 4,308,213 |
| 50 | 2,178,509 | 93.94% | 7,809,882 |

Total: 2,318,931 occupied voxels / 103,816,750 images. Hiding singletons removes
almost half the blocks but only 1.10% of images from the visible voxel layer.

The top-left dock no longer scrolls as a unit. Dataset selection stays fixed;
Settings scrolls internally beneath its header, and search has its own overflow.
The panels remain separate and above the hotbar even on short viewports.

## Can we reuse MONET's FAISS index?

**Yes, the compressed search index itself is suitable for reuse.** A read-only
memory-mapped inspection confirms the local publisher artifact has:

- `IndexIVFPQ`, inner product, 512 dimensions;
- 103,816,750 vectors, 4,096 lists, PQ64 with 8-bit codes, nprobe = 64;
- 7,483,751,844 bytes = **6.970 GiB** on disk.

Path: `/data2/monet/retrieval-storage/clip/embedding_clip-vit-base-patch32.faiss`.
The associated metadata names CLIP ViT-B/32, the embedding model used by the
full map. A 4M-trained basemap head changes coordinates, not the similarity
index; 2D/3D and different voxel resolutions can share one ANN index.

The integration work is **identity translation**, not re-embedding 100M images.
Publisher FAISS IDs are not our map rows. The full map uses the 19,344,847-row
pool followed by 84,471,903 complement rows, with explicit source provenance.
The publisher hashes table maps ANN IDs to perceptual hashes; its companion
table gives source IDs and shard paths. These two tables have 103,816,750 rows
each but demonstrably different row orders. Never join them by position or
assume perceptual hashes are unique.

The earlier eight-result sample established a viable source-identity join, not
a corpus-wide bijection. Before enabling full-map search, build and audit a
complete ANN-ID → map-row lookup, resolve hash collisions using source identity
and, where necessary, original publisher ordering/vector evidence; reject
unresolved identities. A complete u32 lookup costs **415,267,000 bytes = 396.03
MiB**. The 1.285 GiB hashes Parquet and 1.765 GiB source Parquet are offline join
inputs, not required resident string tables or browser downloads. A corpus-count
match alone does not prove identical membership.

No second FAISS copy is needed per map. Coordinate/voxel lookups are already in
each published map. A differently ordered release needs its own audited row
translation, not a newly trained quantizer.

## Incremental resources and latency

| Path | Additional persisted payload | Server runtime / work |
| --- | --- | --- |
| Text → projection only | About 334 MiB text + two head tensor weights; no ANN | Fixed-size inference, independent of corpus size |
| Text → existing 103.8M ANN | 6.970 GiB index + 396 MiB row translation + shared text encoder | Previously measured 7.93 GiB peak RSS for encoder + index, **before** row mapping and production overhead; budget roughly 10–12 GiB |
| Exact float32 search over full corpus | 198.02 GiB raw vector payload alone | Not recommended for this demo |

Weight payload is not total Python/PyTorch RSS or checkpoint download size. The
projection-only prototype currently uses the 2M heads; the full map would use
its verified 4M heads and published coordinate frame. It still may project text
into sparse space rather than retrieve relevant images.

Prior **local measured** full-index search, Ryzen 9950X, two threads:

- ANN at nprobe 64: **39.67 ms median / 51.68 ms p95**.
- Text encoding: **18.05 / 28.70 ms**.
- Local disk index load: **6.52 seconds**; downloads/container startup extra.
- HF CPU Basic pilot warm browser-equivalent HTTP request: **92 / 162 ms**
  median/p95, including network and encoder/search, **not** map identity lookup,
  thumbnail display or flight. Small prompt set, not a concurrency/recall SLA.

Full methodology, cloud comparisons and caveats:
[hosting review](clip-search-hosting-review.md). The projection prototype's
separate measurements are in [text navigation](text-navigation-prototype.md).

## What reaches the browser?

**None of the multi-GB FAISS index or mapping.** Keep these server-side. Return
24 bounded result records (a few KiB of JSON), then load their thumbnails.
The full 256px packed thumbnail corpus averages 7,979.59 bytes/image, so 24
uncached thumbnails average **187 KiB** of image payload (content varies; this
is corpus arithmetic, not a measured query distribution). Twenty-four decoded
256² RGBA images are **6 MiB** before browser overhead. Reuse bounded result
cards and existing hover/flight handling; don't retain old result galleries.

Flying to a result incurs the existing chunk/atlas range reads and cache budgets.
Neither ANN nor projection requires all map data in the client, nor another
copy of the 771.5 GiB thumbnail corpus. Hosting one index copy is an extra
roughly 7 GiB of server artifact storage, not 7 GiB of CDN transfer per visitor.

Full-map CLIP search is **not enabled by this change**. The local comparison
still targets the 2.01M map until the full identity join and backend integration
are implemented. The occupancy filter is a view control, not yet a search
membership predicate; integration should avoid flying to an invisible result.

## Verification

94 frontend unit tests pass; the production build passes with the existing
large-bundle warning. Tests cover default/invalid thresholds, inclusive boundaries, unsigned
counts above 65,535, max-versus-sum reduction, legacy residency composition, and
effector resizing/reloading/ghost behavior, and stale sharp/search preview rejection. A short real-map browser check at
N=50 found 7,661 filtered resident instances with no visible cube/cage leaks,
2,244 surviving instances, and no invalid visible hierarchical cells. Independent
panel layout checked at 1,000 / 600 / 400 px viewport heights. No JS exceptions.
