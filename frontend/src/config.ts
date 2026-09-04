// Phase 2 constants. World geometry (extent, voxel/chunk sizes, atlas layout) is
// now read from the pipeline's `manifest.json` at runtime — the only thing that
// stays hardcoded here is how the manifest's normalized `[-1,1]^3` frame maps
// into world units, plus the streaming/feel tuning knobs.

/**
 * Dataset registry. Switching which chunk-pack the explorer renders is a
 * one-line change to `DEFAULT_DATASET` (or a `?dataset=` query param at
 * runtime) — nothing downstream hardcodes "bl".
 *
 * `path` is fetched same-origin (relative to the page) and proxied by Vite's
 * dev server (see `vite.config.ts`'s `server.proxy`) through to the static
 * data server on port 8802. A direct cross-port browser fetch to :8802 was
 * tried first and gets blocked by Chrome's Private/Local Network Access
 * policy once the page is served over plain http from a LAN hostname like
 * gsv.local — proxying through Vite's Node process sidesteps that entirely,
 * and incidentally means the same build works unmodified from localhost, any
 * LAN IP, or gsv.local.
 */
export const CHUNK_SERVER_PORT = 8802;

export interface DatasetConfig {
  /** Path on the chunk server to the directory holding `manifest.json`. */
  path: string;
  /** Human-readable label for the HUD. */
  label: string;
  /**
   * Path to this dataset's 2D minimap pack (Phase 5), or absent for a dataset
   * that has no 2D pack built yet — in which case the app simply runs without
   * a minimap panel rather than failing.
   *
   * Note both BL chunk-packs point at the SAME minimap pack: the 2D pack is
   * built from the 2-component UMAP fit of the points table, which is
   * independent of the 3D fit and completely independent of the voxel
   * resolution a chunk-pack was binned at.
   */
  minimapPath?: string;
  /**
   * Where this dataset's thumbnails are rooted on the chunk server. The
   * manifest's own `thumb_url_template` supplies everything after it, so the
   * two together are the full URL (see `streaming/PointIndex.ts`'s
   * `resolveThumbUrl`). Defaults to `THUMBS_BASE_PATH` (`/thumbs`).
   *
   * BL sets it to `/thumbs/bl` because BL's already-built packs carry a
   * template with no dataset-family segment (`{subset_name}/{local_idx:08d}
   * .webp`) — the family lives in the base for those. MONET's template carries
   * its own `monet/` segment, so it takes the default.
   */
  thumbsBasePath?: string;
}

export const DATASETS: Record<string, DatasetConfig> = {
  bl: {
    path: "/chunks/bl",
    label: "BL · num_voxels=96",
    minimapPath: "/minimap/bl",
    thumbsBasePath: "/thumbs/bl",
  },
  "bl-160": {
    path: "/chunks/bl-160",
    label: "BL · num_voxels=160",
    minimapPath: "/minimap/bl",
    thumbsBasePath: "/thumbs/bl",
  },
  // MONET draw arms (jasperai/monet, 2M points each). Each arm is a different
  // sampling of the same 19.3M-row pool, so they are separate packs end to end
  // — separate points table, UMAP fit, chunk pack and minimap pack. Thumbnails
  // are served by the data server's dynamic `/thumbs/monet/<packed>.webp`
  // route (MONET's are byte ranges inside packed blobs, not files), which the
  // pack's own `thumb_url_template` addresses — hence no `thumbsBasePath`
  // override here.
  "monet-random": {
    path: "/chunks/monet-random",
    label: "MONET · random draw",
    minimapPath: "/minimap/monet-random",
  },
  "monet-sscd": {
    path: "/chunks/monet-sscd",
    label: "MONET · sscd draw",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-annfaiss": {
    path: "/chunks/monet-annfaiss",
    label: "MONET · annfaiss draw",
    minimapPath: "/minimap/monet-annfaiss",
  },
  // `monet-theirfaiss` gets added the same way once the research project
  // produces that draw (its rarity computation is still running).
};

/**
 * Which entry of `DATASETS` to load when no `?dataset=` param is given.
 *
 * `bl` (96^3 grid, 5,880 occupied voxels) -> `bl-160` (160^3, 14,688), after
 * a misread: "smaller blocks" meant HIGHER RESOLUTION — more, finer voxels
 * so the map resolves more structure — not the same voxels drawn smaller
 * (which is what the earlier `VOXEL_FILL` cut did, now reverted; see its doc
 * comment). Resolution is a pipeline-side knob (`num_voxels` in
 * `run_chunkpack_bl.py`), so the frontend just points at the finer pack.
 * Going finer still (256+) needs per-chunk compact atlases first — at 16^3
 * voxels/chunk every chunk carries a full 2048^2 atlas even when it holds a
 * handful of voxels, so VRAM scales with chunk count, not point count.
 */
export const DEFAULT_DATASET = "bl-160";

/**
 * Explicit override for the chunk server origin; `null` (the default) means
 * "same-origin, relative path" — i.e. let Vite's proxy handle it. Only set
 * this to bypass the proxy (e.g. hitting the data server directly from a
 * non-Vite-served context), which will hit the Private Network Access wall
 * described above unless that context is a secure/localhost origin.
 */
export const CHUNK_SERVER_ORIGIN: string | null = null;

/**
 * Half-extent of the rendered world, in world units. The manifest's frame is a
 * normalized `[-1,1]^3` cube, so `worldPos = normalizedPos * WORLD_SCALE` and
 * the full world spans 2 * WORLD_SCALE units per axis.
 *
 * 25 (Phases 1-6) -> 50, from direct feedback: "i kind of want smaller voxels
 * and to be smaller, as in i have to fly farther to get across the map."
 *
 * Read the pair `WORLD_SCALE` / `VOXEL_FILL` together — they are NOT the same
 * knob, and each one alone does the wrong thing:
 *
 *  - A voxel cell is `(2 * WORLD_SCALE) / num_voxels` world units, so raising
 *    WORLD_SCALE alone makes the world bigger AND every voxel proportionally
 *    bigger with it. Nothing about the view changes; only the flight time
 *    across the map does (`FLIGHT_SPEED` is an absolute unit/s rate).
 *  - `VOXEL_FILL` is what actually sets how big a cube looks against its
 *    neighbours and against the cluster, at any framing — WORLD_SCALE cancels
 *    out of that ratio entirely.
 *
 * So: WORLD_SCALE == "how long it takes to cross the map", VOXEL_FILL == "how
 * small a voxel reads". Both moved together here, which is what produces small
 * specks adrift in a large volume rather than the same picture at a different
 * zoom.
 *
 * At 50 the world spans 100 units per axis (173 on the diagonal); at the
 * unchanged `FLIGHT_SPEED` of 16 that is ~6.3s to cross an axis and ~11s
 * corner-to-corner, up from ~3.1s/5.4s. That slower crossing IS the ask, so
 * `FLIGHT_SPEED` deliberately was NOT raised to compensate — see its doc
 * comment. Going much beyond 2x would start to make the empty stretches dead
 * time rather than a sense of scale.
 */
export const WORLD_SCALE = 50;

/**
 * Fraction of a voxel cell the rendered cube fills — i.e. cube edge =
 * `manifest.voxelWorldSize * VOXEL_FILL`.
 *
 * History: 0.92 (Phases 1-6) -> 0.32 (Phase 6.6) -> 0.80. The 0.32 cut was a
 * misread of "smaller blocks": that ask was for higher RESOLUTION (a finer
 * voxel grid, see `DEFAULT_DATASET`), not for the same grid drawn as specks.
 * With the finer `bl-160` pack the cells themselves are 1.67x smaller, so the
 * fill goes back up to read as solid blocks again — discrete (0.8 leaves a
 * clear 20%-of-cell gap between neighbours, so dense regions still show their
 * internal structure rather than fusing into one wall the way 0.92 did) but
 * substantial, not dust. The Phase 6.6 sweep numbers (0.22/0.32/0.42) were
 * taken against the 96^3 pack and don't transfer to this one.
 */
export const VOXEL_FILL = 0.8;

/** Half-texel inset applied inside each atlas tile (in tile-local UV) to keep
 * bilinear filtering from bleeding in the neighbouring tile's edge texels. */
export const ATLAS_TILE_INSET_TEXELS = 0.5;

/**
 * Strength of the voxel material's ground-bounce fill light, as a fraction of
 * a face's own sampled albedo (0 = off, the pre-fix behaviour).
 *
 * Why this exists: the scene lights voxels with one directional sun from above
 * plus a hemisphere light whose ground color is near-black (`main.ts`), so a
 * face whose normal points straight DOWN receives zero direct light and zero
 * hemisphere sky — it rendered as a black square instead of the voxel's
 * thumbnail (measured: luminance 6/255 on the -Y face vs 133 on a side face
 * and 165 on the top face). This term fills that in, weighted by how far the
 * face points downward, so the bottom face gets the full fraction, side faces
 * get half, and the already-well-lit top face gets none.
 *
 * 0.34 was picked by measuring, not by eye. On a real voxel, sampled with
 * `gl.readPixels` at the face center: the -Y face goes 6 -> 127, side faces go
 * 133 -> 157, and the sun-lit +Y face stays bit-identical at 165 (it is
 * weighted out entirely). So the underside lands about where an unlit side
 * face used to sit — plainly legible — and the top > side > bottom ordering
 * survives, which is what keeps the cubes reading as cubes rather than
 * flattening into unshaded sprites.
 */
export const VOXEL_UNDERLIGHT = 0.34;

// ---------------------------------------------------------------------------
// Voxel greebles (Phase 6.7)
// ---------------------------------------------------------------------------
//
// Direct feedback: "i also want to have the cubes to have visual indications of
// contents on their edges, like some kind of cruft/greebles that are
// proportional to how many pics are inside and that get broken as thumbs are
// mined away."
//
// So: small plain-shaded hull-detail pieces clamped along a cube's 12 edges,
// how many of them says how much is in the voxel, and they snap off as it
// drains. Deliberately NOT atlas-textured — the six faces already carry the
// thumbnail, and the whole point of the greebles is to read as a different
// *kind* of thing (hardware bolted to a container) rather than as more picture.
//
// See `voxels/VoxelGreebles.ts` for the placement/orientation math and the
// deterministic seeding; everything below is the tuning surface.

/**
 * Fewest points a voxel needs before it gets any greebles at all.
 *
 * "Indications of contents" implies there is something worth indicating. In the
 * BL num_voxels=96 pack, 11.7% of occupied voxels hold exactly ONE point and
 * 17.8% hold one or two (bl-160: 14.8% / 21.9%) — for those the cube itself,
 * showing that one point's thumbnail, already IS the complete readout. Starting
 * at 3 also buys back a fifth of the instance budget for free.
 */
export const GREEBLE_MIN_POINTS = 3;

/**
 * Most greeble pieces any single voxel gets, however dense it is.
 *
 * A cube has 12 edges and `VoxelGreebles` assigns each piece its own edge (a
 * seeded shuffle, no two pieces sharing an edge below 12), so 8 is already
 * two-thirds of the available real estate — past that the pieces start reading
 * as a lumpy shell instead of as discrete detail, and the instance count grows
 * with nothing to show for it.
 */
export const GREEBLE_MAX_PER_VOXEL = 8;

/**
 * Greeble pieces added per doubling of a voxel's point count — i.e. the slope
 * of the log map in `greebleCountForPoints`. 0.7 means "one more piece per ~1.43
 * doublings".
 *
 * This has to be a log map, not a linear one, because the real spread is huge:
 * across the BL num_voxels=96 pack's 5,917 occupied voxels the counts run 1 …
 * 7,098 (mean 183, median 27, p75 174, p90 574, p99 1,799). Anything linear
 * either leaves the median voxel bare or gives the densest one thousands of
 * pieces.
 *
 * 0.7 was picked by running the candidate formulas over the actual per-voxel
 * counts in both packs rather than reasoned about in the abstract. It spreads
 * the population across the whole 0-8 range instead of piling it at the ends
 * (`round(log2(n+1))` with the same cap puts 24.5% of voxels at the cap; this
 * puts 1.3%):
 *
 *   pieces:   0     1     2     3     4     5     6     7    8
 *   bl:     17.8%  6.9% 12.2% 15.0% 14.2% 12.6% 12.4%  7.6% 1.3%
 *   bl-160: 21.9%  7.9% 14.0% 16.4% 16.9% 14.6%  7.0%  1.3% 0.1%
 *
 * and the cap only binds above ~1,677 points, which is the top ~1% of voxels.
 */
export const GREEBLES_PER_OCTAVE = 0.7;

/**
 * How many greeble pieces a voxel holding `points` points gets.
 *
 * `round(GREEBLES_PER_OCTAVE * log2(points))`, floored at 1 above the
 * threshold and capped at `GREEBLE_MAX_PER_VOXEL`. Worked examples from the
 * real distribution:
 *
 *     1 → 0     16 → 3    256 → 6    2,048 → 8
 *     3 → 1     32 → 4    512 → 6    4,096 → 8 (capped)
 *     8 → 2    128 → 5  1,024 → 7    7,098 → 8 (capped, the pack's densest)
 *
 * Whole-pack cost at these numbers (every chunk resident, which is what
 * actually happens for BL — 98 chunks all sit inside the keep ring):
 * 19,739 greeble instances for `bl` (3.34 per occupied voxel, worst chunk
 * 2,361) and 40,680 for `bl-160` (2.77 per voxel, worst chunk 5,730).
 */
export function greebleCountForPoints(points: number): number {
  if (points < GREEBLE_MIN_POINTS) return 0;
  const scaled = Math.round(GREEBLES_PER_OCTAVE * Math.log2(points));
  return Math.max(1, Math.min(GREEBLE_MAX_PER_VOXEL, scaled));
}

/**
 * Greeble archetypes. Sizes are `[along the edge, outward, tangential]` as
 * fractions of the CUBE EDGE (`manifest.voxelWorldSize * VOXEL_FILL`), so they
 * re-derive themselves from whatever `VOXEL_FILL` is — which matters, because
 * this landed immediately after `VOXEL_FILL` went 0.92 → 0.32 and a value tuned
 * in world units against the old cube would now be ~3x oversized.
 *
 * Everything here is a box (a single `BoxGeometry` per chunk, non-uniformly
 * scaled per instance): three visually distinct silhouettes for one geometry,
 * one draw call and no extra mesh per shape. Nothing exceeds 0.30 of a cube
 * edge in any dimension, and the widest is 0.22 — at browsing distance that is
 * a few pixels of trim on a cube that is a few dozen, i.e. surface detail
 * rather than a bolt-on that changes the cube's apparent size.
 */
export interface GreebleArchetype {
  name: string;
  /** Relative selection weight. */
  weight: number;
  size: [number, number, number];
}

export const GREEBLE_ARCHETYPES: readonly GreebleArchetype[] = [
  /** A chunky block clamped over the edge — the workhorse "greeble". */
  { name: "bracket", weight: 5, size: [0.16, 0.09, 0.09] },
  /** A thin blade standing out from the edge — reads as a fin/heat sink. */
  { name: "fin", weight: 3, size: [0.045, 0.16, 0.12] },
  /** A thin spike — antenna/mast. The longest piece, but only 4% thick, so it
   * never reads as making the cube bigger. */
  { name: "mast", weight: 2, size: [0.04, 0.22, 0.04] },
];

/**
 * How far out of the cube a piece sits, as a fraction of its own outward
 * half-depth: 0 centres it exactly on the edge line (half buried), 1 puts its
 * inner face flush against the edge (fully outside, looking balanced there).
 * 0.4 leaves ~30% of the piece inside the cube, which is what makes it read as
 * welded into the hull rather than glued onto it.
 */
export const GREEBLE_PROTRUSION = 0.15;

/** Keep-out at both ends of an edge, as a fraction of its length, so pieces
 * don't hang off the corners where two edges' greebles could interpenetrate. */
export const GREEBLE_EDGE_MARGIN = 0.18;

/** Per-instance size jitter, ± this fraction — same archetype, not identical
 * twins. */
export const GREEBLE_SIZE_JITTER = 0.22;

/** Base greeble tint (sRGB). A cool neutral grey: unmistakably "not the
 * thumbnail" against the BL book scans, which are overwhelmingly warm
 * paper/ink. */
export const GREEBLE_COLOR = 0x9aa6b4;

/** Per-instance brightness jitter, ± this fraction of the base tint — a panel
 * of identically-shaded boxes reads as one object, a slightly varied one reads
 * as assembled parts. */
export const GREEBLE_SHADE_JITTER = 0.28;

/** Greeble surface. Metalness stays low deliberately: the scene has no
 * environment map, and a `MeshStandardMaterial` with high metalness and nothing
 * to reflect renders nearly black. 0.2/0.55 gives a dull machined look that
 * still catches the sun light. */
export const GREEBLE_METALNESS = 0.2;
export const GREEBLE_ROUGHNESS = 0.55;

// ---------------------------------------------------------------------------
// Streaming rings
// ---------------------------------------------------------------------------

/**
 * Ring radii, expressed in *chunk edge lengths* from the camera to a chunk's
 * center, so they stay meaningful across datasets with different
 * `chunks_per_axis`. R0 = fetch now, R1 = background prefetch, R2 = keep
 * resident if already loaded, beyond R2 = evict.
 */
export const RING_R0_CHUNKS = 3.0;
export const RING_R1_CHUNKS = 5.0;
export const RING_R2_CHUNKS = 8.0;

/** Max chunk fetches in flight at once. */
export const MAX_CONCURRENT_CHUNK_LOADS = 6;

/**
 * Hard caps on residency, enforced farthest-first once the ring pass is done.
 *
 * Sizing note: every chunk carries a full 2048px atlas regardless of how few
 * voxels it actually occupies, so resident VRAM is driven by chunk *count*,
 * not by point count. Measured on the BL num_voxels=96 pack: ~5.7 MB per
 * decoded atlas, so all 98 chunks ≈ 553 MB. 1.25 GB leaves room for that plus
 * a denser pack without the budget biting during normal flight.
 */
export const MAX_RESIDENT_CHUNKS = 512;
export const MAX_RESIDENT_ATLAS_BYTES = 1280 * 1024 * 1024;

/** Re-run the ring classification only after the camera has moved this far
 * (world units) — the pass is O(occupied chunks) and doesn't need to run at
 * 120 Hz while hovering in place. */
export const CHUNK_UPDATE_MOVE_EPSILON = 1.5;

// ---------------------------------------------------------------------------
// Proxy cloud
// ---------------------------------------------------------------------------

/**
 * Opacity of the always-resident coarse proxy cubes.
 *
 * 0.3 -> 0.18, purely as a consequence of the `VOXEL_FILL` 0.92 -> 0.32 change.
 * The proxy layer's sizing needed nothing (it is chunk-scale, and
 * `manifest.chunkWorldSize` scales with `WORLD_SCALE` on its own), but its
 * relative visual WEIGHT inverted: 0.3 read as a light haze behind a solid wall
 * of thumbnails, and against the new sparse specks the same cubes became the
 * heaviest thing on screen — the coarse placeholder outshouting the real data
 * it stands in for. 0.18 restores the hierarchy while still drawing a clearly
 * readable silhouette of the un-streamed world from across the map (verified on
 * the same wide screenshot vantage used to pick VOXEL_FILL).
 */
export const PROXY_OPACITY = 0.18;
/** Proxy cube edge as a fraction of a chunk edge, at min and max density. */
export const PROXY_MIN_FILL = 0.3;
export const PROXY_MAX_FILL = 0.94;
/** `density_log2` value treated as "fully dense" when scaling proxy cubes. */
export const PROXY_DENSITY_LOG2_MAX = 18;

// ---------------------------------------------------------------------------
// Environment — depth cues (Phase 6.6)
// ---------------------------------------------------------------------------
//
// Direct feedback: judging distance in an otherwise-black void is hard, and the
// reference is space-flight games (Descent; more recently Elite Dangerous / No
// Man's Sky). Both knobs below are the two cheapest, most standard cues from
// that genre — atmospheric attenuation with distance, and a fixed backdrop to
// move against. Both are deliberately near the threshold of noticing: the ask
// was explicitly "some fog (but keep it subtle)".

/**
 * Fog color. Identical to the renderer's clear color (`Engine`'s
 * `setClearColor(0x05060a)`) on purpose — fog that doesn't match the background
 * reads as a visible grey wall hanging in space at the fade distance instead of
 * as depth, because geometry fades toward one color while the void behind it
 * stays another.
 */
export const FOG_COLOR = 0x05060a;

/**
 * `THREE.FogExp2` density. Exponential-squared rather than linear `THREE.Fog`:
 * linear fog has a hard near plane where the effect switches on, which is
 * exactly the "visible wall" artifact subtlety rules out, whereas exp2 starts
 * attenuating immediately and ramps smoothly — the haze look this wants.
 *
 * Expressed as a fraction of `WORLD_SCALE` so it re-derives itself if the world
 * is ever rescaled again (fog density is 1/length, so it must scale inversely
 * with the world; a hardcoded value tuned at one WORLD_SCALE is silently wrong
 * at another). The attenuation `f = 1 - exp(-(d * density)^2)` at
 * 0.36/WORLD_SCALE = 0.0072 works out to:
 *
 *     d =  10 (arm's length)          -> 0.5% dimmed
 *     d =  25 (a quarter world axis)  -> 3.2%
 *     d =  50 (a world half-extent)   -> 12%
 *     d = 100 (a full world axis)     -> 40%
 *     d = 133 (the R2 residency edge) -> 60%
 *     d = 173 (the world diagonal)    -> 79%
 *
 * So the voxel you're about to mine is untouched, a cluster on the far side of
 * the map is plainly hazier than the one in front of you, and the edge of the
 * streamed world sits back in the mist — with nothing actually vanishing at any
 * distance you'd navigate at.
 *
 * Picked by measurement plus a density sweep from a fixed pose, not by eye:
 * `gl.readPixels` on ~100 real voxel-face pixels (bucketed by their raycast
 * distance) tracks the analytic curve above to within ~2 points, and comparing
 * renders at 0.005 / 0.0072 / 0.010 showed 0.005 to be imperceptible at
 * browsing distances (6% at 50 units) while 0.010 starts flattening the far
 * field into grey. 0.0072 is the value where near-vs-far ordering is legible in
 * a single frame and the effect still reads as air rather than as a filter.
 */
export const FOG_DENSITY = 0.36 / WORLD_SCALE;

/**
 * Radius of the starfield shell, in `WORLD_SCALE`s. 12 puts it at 600 units —
 * far outside both the world (half-extent 50) and the R2 residency ring (133),
 * so stars always read as "infinitely far away" and can never be flown into or
 * mistaken for data. It has to stay comfortably inside `CAMERA_FAR` (1200) from
 * wherever the camera is, including its own far side: 600 + 600 = 1200 exactly
 * at the origin, so the shell's back half fades out right at the far plane
 * rather than popping — which is fine (and invisible) because fog is disabled
 * on the stars and they are drawn behind everything anyway.
 *
 * The shell is at FIXED world positions rather than pinned to the camera. A
 * camera-pinned skybox gives rotation cues only; leaving it in the world means
 * crossing the map sweeps the stars by a few degrees of real parallax, which is
 * the half of the cue that tells you you're translating and how fast.
 */
export const STARFIELD_RADIUS_WORLD_SCALES = 12;

/** Star count. Sparse on purpose — this is a depth cue, not a nebula. */
export const STARFIELD_COUNT = 1400;

/** On-screen star size in pixels (`sizeAttenuation` is off — at 600 units,
 * perspective-attenuated points would be sub-pixel and alias into flicker). */
export const STARFIELD_SIZE_PX = 1.6;

/** Peak star opacity. Individual stars are additionally dimmed by a random
 * per-star brightness (see `engine/Starfield.ts`), so this is the brightest any
 * of them gets — dim enough that the field never competes with the data. */
export const STARFIELD_OPACITY = 0.55;

/** Star tint — the same cool blue-white the scene's hemisphere fill uses, so
 * the backdrop belongs to the same lighting world as the voxels. */
export const STARFIELD_COLOR = 0xbcd0ff;

// ---------------------------------------------------------------------------
// Phase 1 synthetic field (kept for the `?synthetic=1` fallback view)
// ---------------------------------------------------------------------------

/** Half-extent of the synthetic world cube, in world units. */
export const WORLD_HALF_EXTENT = 25;

/** Voxel edge length, world units (synthetic field only). */
export const VOXEL_SIZE = 1;

/** Chunk size (voxels per axis per chunk). The pipeline fixes this at 16 and
 * reports it as `world.voxels_per_chunk`; kept here as the fallback default. */
export const CHUNK_SIZE_VOXELS = 16;

/** How many synthetic cubes to scatter for the Phase 1 perf/feel proof. */
export const SYNTHETIC_INSTANCE_COUNT = 150_000;

// ---------------------------------------------------------------------------
// Camera / controls
// ---------------------------------------------------------------------------

/**
 * Camera flight speed, world units / second.
 *
 * Round-tripped: 12 (Phase 1-3.5 baseline) -> 30 (first "make it faster"
 * pass, which also absorbed the old Shift-boost multiplier when Shift became
 * "descend") -> 16 (this value), after real feedback that 30 felt too
 * fast/sudden. 16 sits closer to the original baseline than to 30 — the
 * *sudden* half of that complaint is mostly addressed by `FLIGHT_ACCEL_TAU_S`
 * below (30 with easing might have been fine on its own), but the plan to
 * also shrink voxels / grow the effective world (making distances feel
 * bigger) means a modest speed suits that direction better than a fast one.
 *
 * That scale change has now landed (`WORLD_SCALE` 25 -> 50) and 16 is
 * deliberately UNCHANGED. The feedback that motivated the bigger world was "i
 * have to fly farther to get across the map" — i.e. more sense of distance, not
 * the same trip at a higher speed, and raising the speed to compensate would
 * cancel exactly the thing that was asked for. What the doubling actually costs
 * is bounded and small: crossing a world axis goes ~3.1s -> ~6.3s, and the full
 * corner-to-corner diagonal ~5.4s -> ~11s. That is a journey, not dead time,
 * and the R2 residency ring (8 chunk edges, which scales with the world) still
 * keeps two-thirds of an axis streamed in around you the whole way.
 */
export const FLIGHT_SPEED = 16;

/** Vertical (Space/Shift, or the legacy E/Q) speed, world units / second.
 * Matched to `FLIGHT_SPEED` on purpose: with vertical bound to the same hand
 * position as in Minecraft creative, a slower climb than cruise reads as the
 * controls sticking rather than as a deliberate axis difference. */
export const FLIGHT_VERTICAL_SPEED = 16;

/**
 * Exponential time constant (seconds) the actual flight velocity takes to
 * ease toward the held-keys' target velocity, in both directions (spin-up on
 * press, spin-down on release) — see `FlightControls.update()`. 0.15s is
 * short enough to still feel responsive (not floaty/laggy input) but long
 * enough to round off the instant on/off snap that read as "sudden" in real
 * feedback. Also doubles as a bit of space-sim-appropriate thruster inertia,
 * matching this project's Descent-adjacent framing.
 */
export const FLIGHT_ACCEL_TAU_S = 0.15;

/** Camera near/far planes and FOV.
 *
 * `CAMERA_FAR` 500 -> 1200 alongside the `WORLD_SCALE` 25 -> 50 change. The
 * world now spans 100 units per axis / 173 on the diagonal, and the R2 keep-ring
 * reaches 8 chunk edges = 133 units, so 500 was no longer the comfortable ~6x
 * margin it used to be — and the starfield shell below deliberately sits far
 * outside the play area, which needs the depth range to reach it from anywhere
 * a player is likely to be (`STARFIELD_RADIUS_WORLD_SCALES * WORLD_SCALE` plus
 * the distance they've strayed from the origin).
 *
 * Raising `far` costs essentially nothing in depth precision here: with a near
 * plane of 0.05 the `1/near - 1/far` term is 20.0 at far=500 and 19.999 at
 * far=1200, i.e. the near plane dominates by four orders of magnitude. */
export const CAMERA_FOV_DEG = 70;
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 1200;

/** Raycast max distance from the camera, world units. */
export const RAYCAST_MAX_DISTANCE = 200;

// ---------------------------------------------------------------------------
// Free-mouse look (Phase 3.5) — click-and-drag rotates the camera instead of
// PointerLockControls' full-capture mouse-look. See `FlightControls.ts` and
// the new `interaction/PointerController.ts`, which owns the raw pointer
// stream and decides drag-to-look vs. hold-to-mine.
// ---------------------------------------------------------------------------

/** Radians of yaw/pitch per pixel of mouse-drag delta. Tuned by feel against
 * a 1920px-wide viewport; a plain constant rather than DPI-aware since
 * `movementX/Y` is already reported in CSS pixels by the browser. */
export const LOOK_SENSITIVITY_RAD_PER_PX = 0.0028;

/** Pitch clamp, symmetric around the horizon — stops just short of ±90° to
 * avoid the yaw axis becoming degenerate (straight up/down) under the 'YXZ'
 * Euler order FlightControls composes yaw/pitch with. */
export const LOOK_PITCH_LIMIT_RAD = Math.PI / 2 - 0.02;

/** How far the pointer must move from its mousedown position, in CSS pixels,
 * before a candidate mine/restore hold is abandoned and reinterpreted as a
 * look-drag instead. Small enough to not feel laggy, big enough to absorb
 * sub-pixel jitter from an otherwise-still hand. */
export const LOOK_DRAG_THRESHOLD_PX = 6;

// ---------------------------------------------------------------------------
// Mining / extraction / inventory (Phase 3, extended 3.5, reworked 6.5)
// ---------------------------------------------------------------------------

/**
 * Duration of ONE extraction cycle, in milliseconds — the time a hold has to
 * be sustained before the next batch of points is pulled out of the voxel
 * under the cursor.
 *
 * 533 = Phase 3.5's `MINE_HOLD_DURATION_MS` (1600) / 3, the reduction the
 * user asked for directly; then halved again to 267 ("we can make the mining
 * for a single image 2x as fast") once the hold ring switched to showing the
 * voxel's overall drain rather than per-cycle fill. The important change
 * isn't the number though, it's what a completed hold now *does*: 3.5's hold
 * moved a voxel's entire point list into the inventory in one shot and
 * flipped a boolean. A hold now runs this timer repeatedly for as long as the
 * button is down, extracting one point per cycle, so a voxel drains
 * continuously rather than popping.
 */
export const EXTRACTION_CYCLE_MS = 267;

/**
 * How many points one extraction cycle pulls out of a voxel. Always **1**.
 *
 * The first pass at this made the batch scale with a voxel's total point
 * count (up to ~710/cycle for the densest BL voxel), aimed at keeping any
 * voxel's full-drain time roughly constant. Overridden by more specific
 * follow-up feedback: extraction should grab exactly one thumbnail at a
 * time, full stop, even for a voxel with thousands of points — "even for
 * lots and lots its ok as we are creating a human scale interface to this
 * large dataset." A big voxel taking a long time to fully empty one hold at
 * a time is the intended feel, not a problem to engineer around; you're not
 * expected to fully drain the densest voxel in one sitting.
 *
 * Kept as a function (not a bare constant) so call sites don't care that the
 * batch is fixed — and because the "communicates size" property the earlier
 * scaling formula was solving for still holds, just via a different
 * mechanism: each cycle now fades a voxel by `(1 - EXTRACTION_FLOOR_OPACITY)
 * / totalPoints`, which is already imperceptibly small for a huge voxel and
 * clearly visible for a small one — size is still legible from how fast the
 * fade moves, without batching.
 */
export function extractionBatchSize(_totalPoints: number): number {
  return 1;
}

/**
 * How long a hold on an ALREADY-fully-drained voxel must be sustained to push
 * its entire extracted stack back into it (the whole-voxel inverse of
 * extraction; the per-point inverse lives in the inventory panel).
 *
 * Deliberately still 1600ms — Phase 3.5's original hold duration — rather than
 * `EXTRACTION_CYCLE_MS`. Extraction got faster because it's incremental and
 * self-limiting (let go and you keep exactly what you pulled); a restore is a
 * single irreversible-feeling bulk action that also empties an inventory
 * stack, so it keeps the longer, more deliberate hold.
 */
export const RESTORE_HOLD_DURATION_MS = 1600;

/**
 * Opacity a FULLY drained voxel renders at. A partially drained one sits at
 * `lerp(1, EXTRACTION_FLOOR_OPACITY, extractedFraction)` — see
 * `combinedVoxelOpacity()` in `voxels/VoxelOpacity.ts`.
 *
 * Replaces Phase 3.5's `MINED_OPACITY` (0.55), per the user's "should be
 * pretty faded" — 0.55 was tuned as the *binary* mined state's single value,
 * and as a floor it left a drained block looking barely touched.
 *
 * Picked by sweeping candidates against a real screenshot AND a `gl.readPixels`
 * measurement, on the hardest case available: an ISOLATED voxel (all six
 * neighbours empty, so it composites against pure void rather than against the
 * bright cluster behind it, which is where a low opacity looks worst). Face-
 * center luminance on that voxel, /255:
 *
 *     untouched 178.8 · 0.55 → 101.3 · 0.45 → 84.0 · 0.38 → 71.9
 *     0.30 → 57.9 · 0.28 → 54.5 · 0.22 → 43.9 · empty void 0.0
 *
 * 0.30 is 3.1x dimmer than untouched (0.55 was only 1.8x — the "barely
 * touched" complaint, confirmed) while staying unmistakably present against a
 * void that measures a literal 0. Below ~0.28 the block stops reading as a
 * translucent ghost and starts reading as a black box, i.e. as a rendering
 * artifact rather than as state.
 *
 * The upper bound is not a taste call: it MUST stay meaningfully below
 * `XRAY_OPACITY` (0.40). `combinedVoxelOpacity()` composes the two with
 * `min()`, so a floor at or above 0.40 would render a fully drained voxel
 * IDENTICALLY to an untouched one whenever X-Ray is equipped — silently
 * deleting the extraction readout in exactly the mode built for looking inside
 * a cluster. 0.30 keeps a visible gap; 0.38 would technically pass with none.
 */
export const EXTRACTION_FLOOR_OPACITY = 0.3;

/** Duration of the fly-to-inventory animation, ms (see
 * `ui/ExtractionFlight.ts`). One tile per extraction cycle, not per point —
 * animating a fully-drained 7,098-point voxel's worth of extractions as 7,098
 * DOM elements (even one at a time, accumulated) would be a browser hang,
 * not polish. */
export const EXTRACTION_FLIGHT_MS = 620;

/**
 * Default base path for full-resolution per-point thumbnails, proxied
 * same-origin exactly like the chunk-pack paths above (see `vite.config.ts`'s
 * `server.proxy["/thumbs"]`). A dataset overrides it with
 * `DatasetConfig.thumbsBasePath`; the rest of each URL comes from that
 * dataset's chunk-pack manifest `thumb_url_template`, applied in
 * `streaming/PointIndex.ts`.
 *
 * Datasets differ in how their thumbnails are stored, and the split between
 * this base and the template is what absorbs that: BL is one webp file per
 * point under `/thumbs/bl/<subset>/…` (a static tree, symlinked in on the data
 * server), MONET is byte ranges inside packed per-shard blobs served by the
 * data server's dynamic `/thumbs/monet/<packed_ref>.webp` route. Both stay
 * under `/thumbs`, so one Vite proxy rule covers both.
 */
export const THUMBS_BASE_PATH = "/thumbs";

/** How many thumbnails an expanded inventory stack renders up front, and how
 * many more each "show more" click reveals — keeps a stack of thousands of
 * points from creating thousands of `<img>` elements at once. */
export const INVENTORY_THUMBS_PAGE_SIZE = 60;

// ---------------------------------------------------------------------------
// Hotbar / equippable tools (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Opacity all resident voxels render at while the "X-Ray" hotbar item is
 * equipped (1 = fully opaque, matching a normal untouched voxel). Combined
 * with a voxel's own extraction-derived opacity via `combinedVoxelOpacity()`
 * (`voxels/VoxelOpacity.ts`) using min(), not product — see that function's
 * doc comment for why. Tuned by eye the same way the extraction floor was: high
 * enough that an X-rayed cluster still reads as "made of voxels" rather than
 * a formless haze, low enough that whatever is behind the front layer is
 * actually visible through it.
 */
export const XRAY_OPACITY = 0.4;

/**
 * Effector Field (Item 2) sizing — expressed as multiples of the manifest's
 * own voxel/chunk world sizes (resolved once, at `EffectorFieldController`
 * construction, when the manifest is known) rather than fixed world units,
 * so the field is sized sensibly whether the active dataset is
 * num_voxels=96 or num_voxels=160.
 *
 * Position model: the field is a sphere anchored at `distance` world units
 * directly in front of the camera (`camera.position + forward * distance`),
 * so flying/looking around moves it with you — that's the "movable" part.
 * `distance` alone is what "push it further out / pull it in" adjusts (`[`/`]`
 * keys); `radius` is the separate "grow/shrink the field itself" control
 * (mouse wheel, or `-`/`=` keys) — see `EffectorFieldController`'s doc comment
 * for the exact bindings.
 *
 * The field is CENTERED ON THE CAMERA ("the effector field should be centered
 * on the camera so the field just goes outwards"): it's a bubble around you,
 * not a probe held out in front. There is no standoff/distance control any
 * more — flying moves the bubble, and its only parameter is the radius. That
 * is why the default radius went 3 -> 8 voxels: a 3-voxel bubble around your
 * own head clears almost nothing you can see, whereas at 8 the immediate
 * shell around you opens up as you push into a dense region, which is the
 * "reach through" the tool exists for. Expressed in voxels so it scales with
 * the pack's resolution (a voxel is the natural unit of "one thing in the
 * way"); the max is in chunks for the same reason the streaming rings are.
 */
export const EFFECTOR_DEFAULT_RADIUS_VOXELS = 8;
export const EFFECTOR_MIN_RADIUS_VOXELS = 1;
export const EFFECTOR_MAX_RADIUS_CHUNKS = 3;
export const EFFECTOR_RADIUS_STEP_VOXELS = 0.75;

/** A keypress (`-`/`=`) resizes by this many wheel-steps' worth at once — a
 * single wheel "notch" (`deltaY` tick) is a much smaller, higher-frequency
 * input than a discrete key tap, so a keypress needs a bigger per-event step
 * to feel comparably responsive rather than glacial. */
export const EFFECTOR_KEY_STEP_MULTIPLIER = 4;

/** How far (world units) the field's computed sphere center has to move
 * before its suppression set is recomputed — mirrors
 * `CHUNK_UPDATE_MOVE_EPSILON`'s "don't redo O(instances) work every single
 * frame when nothing meaningfully changed" role, just sized to a fraction of
 * a voxel instead of a fraction of a chunk, since this test is per-voxel. */
export const EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC = 0.25;

/** Gizmo sphere color — deliberately distinct from the hover-highlight teal
 * (`#7fffe0`) and the mine/restore hold-ring colors, so the field reads as
 * its own thing rather than blending into existing HUD accents. */
export const EFFECTOR_GIZMO_COLOR = 0x9d7bff;

// ---------------------------------------------------------------------------
// 2D minimap (Phase 5)
// ---------------------------------------------------------------------------

/** On-screen edge of the square minimap panel, CSS pixels. Small and
 * unobtrusive by design — it's an overview, not a second viewport. */
export const MINIMAP_SIZE_PX = 220;

/**
 * Which density zoom level to composite the static base image from.
 *
 * z1 is 2x2 tiles = 512x512 bins, which at a 220px panel on a 2x-DPR display
 * (440 device px) is a slight, clean downscale — sharp with nothing wasted.
 * z0 (256px) would be upscaled and visibly blocky at 2x DPR; z2 (1024px, 16
 * tiles) is 4x the pixels and 4x the fetches to then throw away in a 2.3x
 * downscale. Nothing here depends on the choice beyond image sharpness: the
 * pyramid tiles the same quantized coordinate space at every level, so all
 * the panel-pixel↔q math is level-independent.
 */
export const MINIMAP_BASE_ZOOM = 1;

/** Flashlight query radius around the cursor, in panel pixels. Converted to
 * the pack's quantized units by the panel (which knows its own size), so this
 * stays "how big does the lit spot look" rather than a magic q value. Tuned
 * by feel: big enough to reliably catch points in the sparse outskirts, small
 * enough that a dense region still lights up a readable handful of voxels
 * rather than half the world. */
export const MINIMAP_FLASHLIGHT_RADIUS_PX = 5;

/** Caps on one flashlight query: how many row_ids the linear scan collects,
 * and how many DISTINCT voxels get glow boxes. The row cap only bounds work
 * (the rows are deduped down to voxels immediately); the voxel cap bounds
 * both the glow-box pool and how legible the highlight is — lighting up
 * thousands of cubes at once conveys nothing. */
export const MINIMAP_FLASHLIGHT_MAX_ROWS = 60_000;
export const MINIMAP_FLASHLIGHT_MAX_VOXELS = 384;

/** Glow-box edge as a multiple of a voxel cell, and its additive opacity.
 * Slightly larger than `VOXEL_FILL` so the glow reads as a halo around the
 * voxel rather than a re-tint of it.
 *
 * The opacity was tuned down from a first pass at 0.45 after looking at a real
 * screenshot: additive blending compounds, so where the lit voxels happen to
 * be adjacent (which is common — a small 2D neighbourhood often maps to a
 * contiguous 3D blob) a dozen overlapping boxes saturated to flat white and
 * lost both the amber identity and any sense of individual cubes. 0.32 keeps
 * a lone lit voxel obvious while a cluster still reads as cubes. */
export const MINIMAP_FLASHLIGHT_CUBE_FILL = 1.35;
export const MINIMAP_FLASHLIGHT_CUBE_OPACITY = 0.32;

/** Marker colors. The flashlight's amber is shared by the 2D circle and the
 * 3D glow boxes on purpose — same color, both ends of the same link. The
 * crosshair reuses the 3D hover box's teal for the same reason, in the other
 * direction. */
export const MINIMAP_FLASHLIGHT_COLOR = "#ffb347";
export const MINIMAP_FLASHLIGHT_COLOR_3D = 0xffb347;
export const MINIMAP_CROSSHAIR_COLOR = "#7fffe0";
export const MINIMAP_AVATAR_COLOR = "#ffffff";

/** How often the avatar's "nearest resident voxel to the camera" search runs.
 * A few times a second is plenty for a 220px panel — the marker moves less
 * than a pixel for most of a second's worth of flight — and it keeps an
 * O(occupied voxels in the nearest chunks) search well off the frame budget. */
export const MINIMAP_AVATAR_UPDATE_MS = 250;

/** Don't redo the avatar search at all until the camera has moved this far
 * (world units) — hovering in place shouldn't spend anything. */
export const MINIMAP_AVATAR_MOVE_EPSILON = 0.75;

// ---------------------------------------------------------------------------
// Teleport (Phase 5)
// ---------------------------------------------------------------------------

/**
 * How far back from the target voxel the camera comes to rest, as a multiple
 * of a chunk edge. The camera arrives looking AT the voxel from this distance
 * rather than inside it — landing exactly on a voxel center would put the
 * near plane inside a textured cube.
 */
export const TELEPORT_STANDOFF_CHUNKS = 0.45;

/** Teleport flight duration, derived from distance and clamped: long enough
 * to read as movement (and to give the destination's chunks time to arrive),
 * short enough not to feel like a cutscene. */
export const TELEPORT_MS_PER_WORLD_UNIT = 9;
export const TELEPORT_MIN_MS = 260;
export const TELEPORT_MAX_MS = 800;

/**
 * Resolves the chunk-pack base URL for a dataset key, honouring
 * `CHUNK_SERVER_ORIGIN` and falling back to the page's own hostname.
 */
export function resolveDatasetBaseUrl(datasetKey: string): string {
  const dataset = DATASETS[datasetKey];
  if (!dataset) {
    throw new Error(
      `Unknown dataset ${JSON.stringify(datasetKey)} — known: ${Object.keys(DATASETS).join(", ")}`,
    );
  }
  // Default: same-origin relative path, proxied by Vite (see vite.config.ts) to
  // the data server on CHUNK_SERVER_PORT. This avoids the browser ever making a
  // cross-port request, which is what triggers the Private Network Access block.
  const origin = CHUNK_SERVER_ORIGIN ?? "";
  return `${origin}${dataset.path}`;
}

/**
 * Resolves the 2D minimap-pack base URL for a dataset key, or `null` if that
 * dataset has no minimap pack. Same same-origin/Vite-proxy reasoning as
 * `resolveDatasetBaseUrl` (see `vite.config.ts`'s `/minimap` route).
 */
export function resolveMinimapBaseUrl(datasetKey: string): string | null {
  const dataset = DATASETS[datasetKey];
  if (!dataset?.minimapPath) return null;
  const origin = CHUNK_SERVER_ORIGIN ?? "";
  return `${origin}${dataset.minimapPath}`;
}

/**
 * Base URL this dataset's thumbnails hang off — `DatasetConfig.thumbsBasePath`
 * if it sets one, else `THUMBS_BASE_PATH`. Same same-origin/Vite-proxy
 * reasoning as `resolveDatasetBaseUrl` (see `vite.config.ts`'s `/thumbs`
 * route). What gets appended comes from the manifest's `thumb_url_template`.
 */
export function resolveThumbsBaseUrl(datasetKey: string): string {
  const dataset = DATASETS[datasetKey];
  const origin = CHUNK_SERVER_ORIGIN ?? "";
  return `${origin}${dataset?.thumbsBasePath ?? THUMBS_BASE_PATH}`;
}
