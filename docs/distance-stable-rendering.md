# Distance-stable rendering — September 5, 2026

## Why forward/back movement caused replacements

There were several independent limits, not a deliberate round-robin queue:

- Proxy detail admitted up to 64 *ready* bricks / 32,768 instances. A missing
  near brick did not reserve its slot; fine upgrades could displace existing
  coverage. The octree ranked projected node size, favoring some large distant
  regions over smaller near ones.
- Streaming admission used view-biased priority within each ring and skipped
  expensive chunks that did not fit, allowing cheaper farther chunks through.
- One unfinished nearby download retracted the entire thumbnail horizon,
  turning unrelated images back into gray proxies.

The octree now prioritizes distance to the node's nearest surface, independent
of rotation, with a 1,024-node cover. Leaf bricks are sorted by center distance
(ties by identity). Metadata reserves base coverage for the nearest 128 leaves
before allocating step-2/1 upgrades, regardless of cache/download readiness.
Missing detail retains a cached lower level or its coarse node. Selected base
bricks stay protected in cache. LOD exit deadbands of 0.2/0.25 chunk edges avoid
repeated switches around the 2/4-chunk thresholds. Capacity boundaries can still
replace similarly distant regions; budgets are intentionally finite.

Textured admission is a nearest-first prefix: no view bias or cheap far jumps.
Explicit teleport destination prefetch remains an intentional priority override.
Each downloaded chunk becomes visible within 2.2 chunk edges (35.2 voxels),
stays visible until 2.4 (38.4 voxels), and prefetch starts within 2.5. A missing
resource affects only its own gray fallback, never the world's display radius.
Streaming reclassification now follows half-voxel movement rather than a fixed
1.5 world units (7.68 voxels at 512³), avoiding abrupt multi-voxel horizon jumps.

| Budget | Before | Now |
| --- | ---: | ---: |
| Textured chunks | 64 | 96 |
| Textured instances | 65,536 | 98,304 |
| Conservative atlas + geometry admission | 256 MiB | 384 MiB |
| Detailed gray bricks shown | 64 | 128 |
| Gray instances shown | 32,768 | 65,536 |
| Gray instances cached | 65,536 | 131,072 |
| Gray bricks cached | 96 | 256 |
| Coarse hierarchy cover | 512 | 1,024 |

Admission estimates are not total tab memory and are not CDN transfer sizes.
They reserve decoded RGBA, metadata and a conservative 1 KiB/occupied voxel.
The 128px preview array remains 128 slots: 8 MiB CPU pixels, 10.67 MiB GPU with
mips, four fetches and two uploads/frame. Effector ghost matrices now match the
98,304 textured-instance limit: 6 MiB CPU + 6 MiB GPU capacity, one draw.

## Physical markers and lighting

Eighteen closed, beveled rectangles form three sparse rings. Each stays
**0.25 × 0.05 × 0.05 voxel units**, with its center exactly R voxels from the
camera. The previous radius-dependent size/aperture and FOV compensation are
gone. Ring slots keep fixed polar angles; rectangles get smaller on screen as
their actual distance increases. A quarter-voxel length leaves clearance at the
minimum one-voxel radius. They use non-emissive lit metal, the scene environment
and depth testing, merged into one draw; they still fade after scrolling.

Atlas blocks now have derivative-filtered virtual bevel normals and smoother
edges around a satin face. This is a lighting effect, not a changed silhouette.
Stronger warm/cool environment cards and a low bounce card give reflections
shape, with slightly less hemisphere fill. No added per-frame passes, shadow
maps, texture downloads or block geometry. Sharp 128px image colors are unchanged.

## Different high-resolution image

The atlas builder selects the point nearest the voxel center; postings are
sorted by row ID. SharpBand previously fetched posting row zero even before
mining, so merely hovering could replace the representative with another image.
Unmined sharp previews now use `meta.reprRowId`, matching the atlas and avoiding
a posting lookup. Once mining starts, the preview intentionally uses the next
remaining/returned row. The immutable 32px atlas still represents the original
voxel after mining; updating every distant mined tile would require a separate
dynamic-atlas policy and is not part of this fix.

## Verification

Correctness tests cover distance ordering, per-chunk display deadbands, delayed
near downloads, base reservations, capacity accounting, LOD hysteresis, physical
marker dimensions/depth, representative identity, cancellation, and shader
patch preservation. Focused browser checks use the published 19.3M pack, not
synthetic data. Software WebGL verifies shader compilation and bounded state;
it is not a hardware FPS benchmark.

Final checks: 80 tests across 25 files, TypeScript and production build passed
(existing large-bundle warning remains). The 19.3M browser mining check extracted
100 rows, advanced the preview, and recorded no JS/shader errors; lookup range
responses were 206 with a maximum 32 KiB response. Repeated ±0.15-chunk movements
verified all 128 reserved proxy slots were a nearest-first leaf prefix, with no
closer eligible leaf skipped. That path held 42–43 resident chunks, about 20.3K
textured instances and 159–160 MiB reported resident bytes. Some proxy detail was
still arriving during the movement check; allocation invariants do not depend on
those downloads finishing. Empty-space screenshots at R=2/8/24 verified the same
5,832-vertex marker mesh size and lit-material type at each physical radius.
