# Streaming transitions and 103.8M readiness — September 5, 2026

The streaming limits and global horizon behavior below have been superseded by
[distance-stable rendering](distance-stable-rendering.md). The 103.8M measurements
and readiness notes remain unchanged.

## Consistent detail boundaries

Downloaded chunks no longer imply visible thumbnails. The camera-centered
thumbnail horizon is 1.9 chunk edges (30.4 voxels); prefetch still reaches 2.5.
An unfinished nearer chunk temporarily holds that horizon back rather than
revealing farther chunks out of download order. A permanently failed resource
stays a proxy without indefinitely holding everything else back.

Chunk residency still initializes mining/X-ray/effector state. A separate display
event swaps between proxies and textures. Hidden prefetched chunks cannot be
raycast or show sharp overlays. Existing admission limits remain 64 chunks,
65,536 instances and 256 MiB of conservative decoded/geometry cost.

Proxy detail now uses a best-first, camera-centered 360-degree octree cut instead
of depth-first, view-dependent budget allocation. Turning alone does not change
the cut, brick requests or selected LOD; normal instanced frustum culling still
rejects offscreen draws. Cheap step-4 bricks arrive before step-2/1 refinements.
Fine detail stays within 2 chunk edges, intermediate within 4. Cached coarse
bricks also fill in when fine detail would exceed the instance budget.
The existing 512 coarse / 32,768 shown fine / 65,536 cached fine limits remain.

## Interaction changes

- Clicking the world explicitly focuses its canvas after preventing the native
  pointer default, releasing Settings sliders/selects from keyboard input.
- X-ray hover has an immediate opaque atlas fallback and an opaque 128px
  replacement when ready. These write depth before glass geometry. The focused
  sharp image shares the existing array texture; no extra image cache is added.
- The effector retains the hidden/non-pickable source instance and replaces it
  with an untextured gray ghost at `XRAY_OPACITY / 3` = 13.33% opacity. Ghosts
  do not write depth or intercept picking. Their one draw is capped at 65,536
  instances, with 4 MiB CPU + 4 MiB GPU matrix capacity, uploaded only when the
  affected set changes. Containers and sharp thumbnails stay suppressed inside.

## Actual 103.8M heatmap measurement

The ready 4M-trained **2D** projection contains **103,816,750** rows:
`/data/latent-basemap/sandbox/monet-clip-fullcorpus-proj-4m-20260905/coords.f32.npy`.
Checkpoint hash prefix: `2a2597e2ce49b14f`.

`pipeline/scripts/build_basemap_overview.py` counted every one of those rows into
a 512×512 grid. A deterministic one-million-row sample estimates the trimmed
square frame; **the heatmap counts are not sampled**. Coordinates are quantized
and counted in batches of at most one million rows. All coordinates were finite
and totals at both levels equal 103,816,750.

| Quantity | Measured cost |
| --- | ---: |
| Four z1 PNG tiles transferred for display | 192,583 bytes (188.1 KiB) |
| Complete z0/z1 density overview, including indexes | 253,786 bytes (247.8 KiB) |
| Decoded 512² RGBA canvas | 1 MiB |
| Offline u32 count grid | 1 MiB |
| Occupied bins / total bins | 97,360 / 262,144 |
| Largest bin count | 90,838 |

Each PNG pixel represents one density bin. Log-scaled counts preserve both sparse
and dense areas. The cockpit already draws a static binned canvas; there are no
100M point sprites. The new `overview_only` build mode also avoids unused raw
per-source count planes, high-resolution density levels and point-sprite LODs.
Full row identities are retained in the spatial build input, so ranged hover,
teleport and mined-point links are independent of heatmap display resolution.

The preview and receipt are under
`/data/latent-scope-3d/previews/monet-clip-104m-4m-overview-20260905/`.
This is a verified heatmap preview, **not a published 100M game pack**.

## Remaining publication prerequisites

- The ready full-corpus **3D** projection uses the older 2M-trained head
  (`e3ade766eeed32e8`), not the 4M-trained head. Its 103,816,750-row layout agrees
  with the 2D manifest: 19,344,847 pool rows, then 84,471,903 complement rows.
- At the readiness check, 4,894 of 10,880 thumbnail shards were complete; the
  existing six-worker complement pull was still running. It was not modified.
  Original-image URL metadata had only the initial 2,015 pool shards.
- The current original-URL blob format has u32 offsets: a single blob cannot
  cross 4 GiB. Full-corpus original URLs therefore need partitioned metadata or
  a versioned wider-offset format, not a blind reuse of the 19M writer.

No second 19M dataset was generated. No research projections, models, thumbnail
pulls or existing immutable map packs were overwritten.

## Verification

Frontend unit tests cover the delayed-nearer-chunk horizon, balanced proxy cut,
opaque sharp-hover queue/texture sharing, untextured pass-through ghosts and
explicit canvas focus. Focused browser checks on the 19.34M map verified keyboard
focus transfer, both 32px and 128px X-ray hover paths, 13.33% ghost opacity,
unchanged selected proxy bricks on camera rotation, and the 1.9-chunk display
bound. Mining still extracted 100 and advanced the preview using 206 ranges.

One early screenshot showed a white world during hover. It did not recur in
subsequent explicit fallback/128px render checks at either the same sparse pose
or a dense cluster; no shader errors were reported. Its cause is unconfirmed,
so this is not a claim that a separate white-frame bug was diagnosed and fixed.
