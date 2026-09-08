# Streaming packs and 100M-row support

Default development dataset: `monet-sscd-512`. Release paths and capabilities live
in `frontend/src/datasets/registry.ts`; standalone builds set `VITE_DEMO_DATASET`.
The old 96-grid entries are no longer in the picker. Existing data directories
were preserved. The new builder accepts 160, 192, 256, etc. (multiples of 16).

## What is loaded

The manifest and proxy hierarchy load first. A view-dependent octree cut picks
visible regions. Nearby leaf regions range-load proxy bricks at 4-, 2-, or
1-voxel cell widths; internal nodes stand in for distant regions. An unloaded
brick keeps a coarse fallback visible. Textured chunks replace their proxies
only after loading finishes. Neither point count nor total fine-voxel count
determines resident instance count.

The v2 streaming summary is 65,568 bytes per 16³ chunk; v3 stores occupied records
only, using `32 + 18 × occupied_voxels` bytes where that is smaller. Counts remain
u32. Runtime arrays expand to the same bounded 4096-slot layout. Postings remain
separate and are fetched only for hovered/mined voxels.

| Resource | Working-set policy |
| --- | --- |
| Textured chunks | Desktop ≤96 chunks, ≤98,304 voxels, ≤384 MiB conservative reservation; mobile ≤12 / 24,576 / 96 MiB |
| Reservation estimate | RGBA atlas pixels + summary bytes + 1 KiB per occupied voxel |
| Chunk loads | Six; cancelled non-abortable transcodes retain their slot until cleaned up |
| Proxy cut | ≤1,024 tree nodes; desktop ≤128 visible bricks / 65,536 instances; mobile ≤48 / 16,384 |
| Proxy cache | Desktop 256 bricks / 131,072 instances; mobile 96 / 32,768; active cut protected from eviction |
| Shared range cache | ≤16 MiB / 512 entries; six active requests; ≤128 pending keys |
| Mining postings | 4,096 u32 IDs per page (16 KiB); next batch ≤100 IDs |
| Thumbnail identity | 256 records per page (2 KiB legacy, 1.25 KiB compact); ≤8,192 decoded identities |
| Minimap | Page bounds in memory; 4,096 spatial records per page (64 KiB); ≤16,384 decoded rows |
| Inventory UI | 100 block rows per page; 60 thumbnails in the focused block |
| Sharp previews | Desktop ≤128 layers at 128px, ~10.67 MiB GPU + 8 MiB CPU pixels; mobile one held 256px DOM image, no automatic band |

These are application working-set bounds, **not a promise about total browser
RSS or GPU-driver allocations**. Scene infrastructure, containers, lighting,
decoder workers and in-flight buffers also consume memory. The lightbox retains
its existing separate original-image cache budget.

## Mining and inventory

A voxel has a monotonic posting cursor, a net extracted count, and a sparse
queue of returned IDs. Mining consumes returns first, then the next IDs from
the posting stream. A cold page pauses extraction without consuming the hold;
the ring does not invent mined items. Returning a whole stack drops its state.

The inventory owns paged u32 IDs independent of chunk/cache eviction. A million
mined IDs occupy approximately 4 MB, rather than a boxed array plus a duplicate
Set. Appends and normal mining are linear in newly mined points, not in the
already-extracted prefix. Individual returns scan the compact pages and compact
one 4K page; browsing never materializes a whole stack. Session inventory still
grows with **what the user has actually mined**: mining all 100M rows would need
about 400 MB of ID storage plus stack bookkeeping. Normal collections persist in
localStorage with quota errors surfaced; CSV provides import/export. Browser
storage is not intended to hold an entire 100M-image collection.

The hovered block displays the next image to mine, using the original thumbnail
instead of enlarging every atlas tile. Mining focuses that block's inventory,
shows the last extracted image large, and refreshes its thumbnail page. Other
blocks reduce to compact rows. The minimap is a non-scrolling child of the
inventory; only the block list scrolls.

## Minimap accuracy

`spatial.bin` carries quantized XY, row identity and voxel identity together.
Its page index has XY bounding boxes. Nearest-point queries visit pages in
lower-bound-distance order and stop only when remaining bounds cannot beat the
best result. Click/teleport is exact in quantized coordinates; equidistant rows
may resolve to any tied row. Row-to-XY and row-to-voxel lookups are independently
paged, so the avatar and inventory highlight do not require a global scatter.

The flashlight is explicitly a **bounded sample**, not an exhaustive selection
of every image in its radius. It samples at most four pages / 8,192 rows;
nearest-point correctness can require additional pages. The caption labels the
sample. Obsolete hover queries are cancelled and cannot steer a later click.
Pathologically overlapping page bounds can still make exact search expensive;
the existing pack uses tile/Morton order, which keeps ordinary pages spatially
local. There is no claim of constant-time exact nearest search for arbitrary
input distributions.

## Binary contract

All fields are little-endian. Offsets use JS safe integers, never signed bitwise
byte arithmetic. Spatial row identity remains limited to 28 bits by the input
minimap format (100M fits; 268,435,456 does not).

`meta.bin` v2 keeps the 32-byte LSV1 header, with version=2 and total n_points.
Each dense 16-byte voxel record is:

```
count:u32 | posting_offset:u32 | RGB:u8[3] | flags:u8 | repr_row_id:u32
```

There is no point-ID tail. `postings.bin` is a u32 array of exactly n_points
IDs; each voxel's offset/count addresses a contiguous span. Manifest entries
carry the posting path, byte count and SHA-256. The optional `streaming`
manifest object selects this browser path; old v1 packs remain readable.

`bricks.bin` records are 16 bytes:

```
local_x:u16 | local_y:u16 | local_z:u16 | representative_local_id:u16
count:u32 | RGB:u8[3] | pad:u8
```

Hierarchy JSON stores each brick's byte offset, count and cell step, plus the
chunk octree. Every level conserves the chunk's point count; coarse colors are
weighted by occupancy. Internal tree fallback boxes currently use a neutral
color rather than atlas imagery.

`spatial.bin` records are 16 bytes:

```
qx:u16 | qy:u16 | row_id:u32 | chunk_id:u32 | local_id:u16 | corpus:u8 | pad:u8
```

`row_xy.bin` has qx/qy u16 pairs in row order. Legacy point-index and row-to-voxel
records are 8 bytes. Compact `point-u32-u8` records are `local_idx:u32 | subset:u8`
(5 bytes), and `voxel-u32` packs `(chunk_id << 12) | local_voxel_id` into 4 bytes.
Packed voxels require 16³ chunks and chunk IDs below 2²⁰. Sparse summary v3 adds
`local_voxel_id:u16` before each v2 record, sorted ascending; the header stores its
occupied record count at byte 22. It retains the dense grid count at byte 10.

The server implements single
closed/open/suffix ranges, 206, 416, HEAD and If-Range fallback. The client
validates Content-Range and length and rejects 200 without reading the body.
HEAD ignores Range and describes the complete resource, following
[RFC 9110 §14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2).
Partial/oversized bodies are rejected. Cross-origin deployments must preserve
Range and expose Content-Range/Content-Length.

Release directories must be immutable: build a fresh release, then change the
registry path. Do not rewrite files in a live release, because independently
cached pages could otherwise span generations. Publication writes the manifest
last. The server conservatively revalidates responses (`Cache-Control: no-cache`).

## Disk and resolution calculations

Legacy streaming sidecars total 40 bytes per row. Compact sidecars total **33 bytes
per row**: postings 4 + thumbnail lookup 5 + row-to-voxel 4 + row-to-XY 4 + spatial
records 16. That is **0.66 GB at 20M** or **3.3 GB at 100M**, excluding images, render summaries, proxy bricks, density
tiles, indexes and retained source packs. These files are not whole-file browser
downloads. Their duplication trades modest server storage for fewer dependent
requests during interaction.

| Grid | Possible fine voxels | Full-occupancy RGBA atlases at 32px tiles | Full proxy bricks (all 3 levels) |
| --- | ---: | ---: | ---: |
| 160³ | 4,096,000 | 16.78 GB | 74.75 MB |
| 256³ | 16,777,216 | 68.72 GB | 306.18 MB |

These are whole-pack maxima, not resident requirements. Compact atlases store
only occupied cells, rounded to power-of-two squares. Compressed KTX2 files
are smaller; GPU residency depends on the device's transcode format. Increasing
the grid does not require raising browser budgets, at the cost of more server-side
bricks/chunks and more frequent LOD transitions. Current full-corpus releases use
512³; see [full-corpus MONET](full-corpus-monet.md) for measured DINO costs.

## Build and verification

Build from an existing MONET points table and completed projections:

```bash
cd pipeline
.venv/bin/python scripts/run_streaming_monet.py sscd --release myrelease --voxels 160
# Or --voxels 256. Release IDs must be fresh and alphanumeric.
```

The script builds wide-count metadata and compact atlases, then the streaming
sidecars, and prints the immutable output path for the registry. The existing
offline assignment/representative selection still uses NumPy/pandas memory
proportional to N; this work bounds browser/serving memory, not the offline
builder's RAM. A 100M offline build needs separate RAM/disk provisioning.
The minimap projection must have identical row identity and count.

To convert an existing pack without rebuilding its atlases:

```bash
.venv/bin/python -m lsvoxel.chunkpack.streaming SOURCE NEW_RELEASE --minimap MINIMAP_PACK
```

SSCD release measurements: 2,000,000 rows; 229 chunks; 29,030 occupied voxels;
313 hierarchy nodes; 622,176 proxy-brick bytes; 5,649,285 compressed atlas bytes;
15,015,072 summary bytes; 8,000,000 posting bytes. All compact atlases together
would occupy 252,559,360 bytes as RGBA, but only nearby chunks are admitted.
31 representatives (0.1%) lacked thumbnails during the rebuild and retain blank
atlas tiles; missing source images are not invented.

Checks include range validation (including offsets above 2 GiB), a logical
100M-row minimap index, paged mining near row 99M, complete million-image mining,
returns, compact inventory storage, and wide-count pipeline roundtrips. A short
Chromium smoke check on SSCD confirmed zero whole lookup-table downloads,
hover previews before mining, minimap flashlight/lookup, 100-item extraction,
60 live thumbnails, focused/compact inventory rows and the docked map. Headless
render timings are not a hardware-GPU frame-rate benchmark.

**The real data tested is the 2M SSCD pack.** 100M is covered by format/addressing
and algorithmic fixtures, not a completed real 100M projection/thumbnail dataset.
That full corpus still needs to be supplied and packed before production-scale
visual quality, exact-search tail latency and device-specific FPS can be measured.
