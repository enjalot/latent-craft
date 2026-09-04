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
  // 160^3 variants of the same three arms ("I want 160 for monet"), built
  // next to the 96^3 packs the way `bl-160` sits next to `bl`. Same points
  // table, fit and minimap pack per arm — only the voxel binning differs.
  "monet-random-160": {
    path: "/chunks/monet-random-160",
    label: "MONET · random draw · num_voxels=160",
    minimapPath: "/minimap/monet-random",
  },
  "monet-sscd-160": {
    path: "/chunks/monet-sscd-160",
    label: "MONET · sscd draw · num_voxels=160",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-annfaiss-160": {
    path: "/chunks/monet-annfaiss-160",
    label: "MONET · annfaiss draw · num_voxels=160",
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
 * `FLIGHT_SPEED` of 16 this was tuned against, that was ~6.3s to cross an axis
 * and ~11s corner-to-corner, up from ~3.1s/5.4s. That slower crossing IS the
 * ask, so `FLIGHT_SPEED` deliberately was NOT raised to compensate — see its
 * doc comment (it has since been halved again on request, with a sprint
 * gesture covering the long trips). Going much beyond 2x would start to make
 * the empty stretches dead time rather than a sense of scale.
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

/**
 * Strength of the per-pixel ordered dither applied to a faded voxel's alpha
 * before alpha-to-coverage (see `VoxelMaterial.ts` for why translucency goes
 * through coverage at all), in units of alpha. 0.25 is exactly one coverage
 * step of the renderer's 4x MSAA — the smallest amount that lets neighbouring
 * pixels land on adjacent coverage levels and average out to the requested
 * opacity, so the continuous extraction fade reads as continuous instead of
 * stepping through 100/75/50/25%. Larger values only add visible noise; 0
 * disables the dither entirely.
 */
export const VOXEL_COVERAGE_DITHER = 0.25;

// ---------------------------------------------------------------------------
// Light rig
// ---------------------------------------------------------------------------
//
// Three lights: a cool hemisphere fill, one warm directional "sun", and (Phase
// 7) a warm headlamp riding with the camera. The first two are distance-
// independent and give the cubes their form; the headlamp is the only light
// whose contribution depends on how far away a cube is, which — together with
// the fog — is what makes distance readable ("add fog and lighting to make
// distance easier to judge like in a videogame"). The three are tuned as a
// set: the fill + sun are set BELOW full brightness so the headlamp has
// headroom to add to, and the headlamp's intensity is what brings a cube at
// browsing distance back up to the brightness it had before.

/**
 * Direction the scene's one directional "sun" shines FROM (un-normalized;
 * `main.ts` sets the light's position to it, `voxels/VoxelContainers.ts`
 * normalizes it into a shader uniform). One constant rather than two literals
 * so the container cages shade from the same side as the cubes they wrap — a
 * cage lit from the left around a cube lit from the right reads as two objects
 * in two scenes.
 */
export const SUN_DIRECTION: readonly [number, number, number] = [1, 1.4, 0.8];

/**
 * Sun and hemisphere fill. Colors: a warm sun over a cool sky fill is the
 * default outdoor rig, and the hemisphere's ground color is near-black because
 * there is no ground to bounce off (the voxel material fills its own
 * undersides in, see `VOXEL_UNDERLIGHT`). Dimmer than the Phase 1 synthetic
 * field on purpose — most BL book illustrations are dark ink on near-white
 * paper, and Phase 1's intensities blew the paper out to flat white.
 *
 * Intensities 1.35 / 1.55 -> 1.0 / 1.2 with the headlamp: measured on a real
 * voxel's camera-facing face (`gl.readPixels`, fog off), the old rig lit it to
 * luminance 151/255 regardless of distance. This rig alone lights the same
 * face to 141-145 (everything is ~7% darker at every distance — less than the
 * intensity cut suggests because `VOXEL_UNDERLIGHT` is independent of the
 * lights), and the headlamp then adds back +45 at 1 unit, +25 at 3 and nothing
 * beyond 25 — so the near field ends up brighter than before, the far field a
 * little darker, and the difference between the two is the cue. Going lower
 * than this made the mid-field (10-25 units, where the headlamp has already
 * fallen off and the fog has barely started) read as murky rather than
 * distant.
 */
export const HEMISPHERE_SKY_COLOR = 0xbcd0ff;
export const HEMISPHERE_GROUND_COLOR = 0x14141f;
export const HEMISPHERE_INTENSITY = 1.0;
export const SUN_COLOR = 0xfff2e0;
export const SUN_INTENSITY = 1.2;

/**
 * Headlamp: a `THREE.PointLight` that follows the camera (`Engine` re-places
 * it every frame, just before the render). Physically-based falloff — `decay`
 * 2 is inverse-square, three's default and the only value under which
 * `intensity` means candela — so near cubes are brighter than far ones by the
 * same law a real lamp obeys. Warm-white, a touch warmer than the sun: things
 * close to you get warm, things far away stay in the cool fill, which is the
 * warm-near / cool-far half of atmospheric perspective and stacks with the fog.
 *
 * `HEADLAMP_BACKSET` is the important one. A lamp exactly AT the eye is
 * inverse-square from zero, so a block you have flown right up to (0.3 units,
 * a normal mining distance) is 100x brighter than one at 3 units, and anything
 * strong enough to read at 10 units whites out everything you are about to
 * touch. Carrying the lamp `BACKSET` units BEHIND the camera makes the falloff
 * seen from the eye `1 / (d + BACKSET)^2` — the standard "light radius"
 * softening of a punctual light, done with a real light instead of a custom
 * shader — which caps the peak (at d = 0 the lamp is still BACKSET away) and
 * stretches the gradient over 0-15 units instead of 0-2. The only geometric
 * consequence is that a lamp behind you lights what faces you a little more
 * evenly than one at your eye, which is what a headlamp should do anyway.
 *
 * `HEADLAMP_RANGE` is how far in front of the camera the light reaches (the
 * light's cutoff `distance` is `RANGE + BACKSET`, measured from the lamp).
 * Half a `WORLD_SCALE` = 25 units = 2.5 chunk edges on bl-160 — about the
 * textured-chunk ring the LOD work after this shrinks to, so the lamp runs out
 * where the textures do. Three's cutoff window `(1 - (r/cutoff)^4)^2` fades it
 * out over the last third rather than clipping.
 *
 * Intensity: with the rig above, measured on the same voxel face, lamp on vs
 * lamp off (luminance /255, fog off): 1 unit 190 vs 145, 3 units 166 vs 141,
 * 5 units 157 vs 141, 8 units 153 vs 143, 12 units 150 vs 145, 20 units 150
 * vs 149, 30 units identical. With the fog as shipped on top, the same face
 * reads 188 / 160 / 147 / 137 / 128 / 115 / 104 at 1 / 3 / 5 / 8 / 12 / 20 /
 * 30 units: a cube at 5 units is ~40 brighter than one at 25, the gradient is
 * continuous from 0 to ~15 units, and with the camera 0.4-1 units from a
 * paper-white face the brightest pixels top out at 224-229 with none clipped
 * — bright, not white. 36 (the first value tried) gave +29 / +16 / +10 at
 * 1 / 3 / 5 with the lamp 5 back, which was a gradient you had to look for.
 */
export const HEADLAMP_COLOR = 0xffe9cc;
export const HEADLAMP_INTENSITY = 70;
export const HEADLAMP_DECAY = 2;
export const HEADLAMP_BACKSET = 6;
export const HEADLAMP_RANGE = WORLD_SCALE * 0.5;

// ---------------------------------------------------------------------------
// Voxel containers (Phase 6.8)
// ---------------------------------------------------------------------------
//
// Direct feedback, replacing Phase 6.7's edge-bolted detail pieces (shipped,
// then removed — "i dont like the greebles"): "i think they should be like a
// container around the box (we have
// the light green hover cube border, can we make that something textured that
// also has visual indication of how much is in it?)"
//
// So: every voxel cube sits inside a persistent cage — the hover wireframe's
// idea generalized into a shell with real rails, corner brackets and surface
// detail — whose weight says how many thumbnails are inside and whose lit
// fill-line drains as they are extracted. All of it is drawn procedurally in
// one shader (`voxels/VoxelContainers.ts`) from two per-instance numbers,
// `capacity` and `fullness`; everything below is the tuning surface.

/**
 * Container edge as a multiple of the cube edge (`manifest.voxelWorldSize *
 * VOXEL_FILL`). 1.08 leaves a 4%-of-edge gap on every side — enough that the
 * cage reads as a shell AROUND the block rather than paint ON it, and small
 * enough that with `VOXEL_FILL` at 0.8 neighbouring cages (0.864 of a cell
 * each) still clear each other by 13% of a cell.
 */
export const CONTAINER_SCALE = 1.08;

/**
 * `log2(points)` that maps to a container's full capacity (1.0); everything
 * above clamps. `capacityForPoints` below is the map.
 *
 * Picked from the real per-voxel counts of the bl-160 pack (all 246 chunks,
 * 14,688 occupied voxels): they run 1 … 3,129 (mean 73.6, median 17, p75 77,
 * p90 200, p99 721), i.e. log2 tops out at 11.61. At 12 the pack's densest
 * voxel lands at 0.97, the median at 0.34 and the 14.8% of voxels holding a
 * single point at exactly 0 — and because the population is close to flat per
 * octave (2^0 … 2^6 each hold 11-15% of voxels) a log map spreads it evenly
 * across the whole visual range, where anything linear would leave the median
 * voxel indistinguishable from the emptiest. The coarser `bl` pack tops out at
 * 7,098 points (log2 12.8), which clamps — that is its top ~0.2%, all of which
 * should read as "as heavy as it gets" anyway.
 */
export const CONTAINER_CAPACITY_LOG2_MAX = 12;

/**
 * Normalized capacity, 0..1, for a voxel holding `points` points. Worked
 * examples from the real distribution:
 *
 *     1 → 0.00    16 → 0.33    256 → 0.67    3,129 → 0.97 (bl-160's densest)
 *     4 → 0.17    64 → 0.50  1,024 → 0.83    7,098 → 1.00 (clamped, bl's densest)
 */
export function capacityForPoints(points: number): number {
  if (points <= 1) return 0;
  return Math.min(1, Math.log2(points) / CONTAINER_CAPACITY_LOG2_MAX);
}

/**
 * Rail width at capacity 0 and 1, as a fraction of the container edge.
 *
 * The cube's thumbnail has to stay the dominant thing on screen, so even the
 * heaviest rail covers only ~11% of an edge per side — at the spawn framing a
 * cube is ~40-60px across, which puts the rails at ~1.5px (a 1-point voxel: a
 * hairline frame that anti-aliases to a faint outline) up to ~6px (a
 * thousand-point voxel: an unmistakable girder). Rails narrower than ~3% of an
 * edge vanish entirely at browsing distance rather than reading as thin.
 */
export const CONTAINER_RAIL_WIDTH_MIN = 0.035;
export const CONTAINER_RAIL_WIDTH_MAX = 0.11;

/**
 * Corner brackets: an L-shaped plate at each of the cube's 8 corners, this far
 * along each edge from the corner (fraction of the container edge, at
 * capacity 0 and 1) and this many rail-widths wide. Brackets grow with
 * capacity for the same reason rails do — a heavy crate is braced at the
 * corners, a light one just has edges — and they carry no tick/rivet texture
 * so they read as solid plates against the segmented rails between them.
 */
export const CONTAINER_BRACKET_LENGTH_MIN = 0.14;
export const CONTAINER_BRACKET_LENGTH_MAX = 0.3;
export const CONTAINER_BRACKET_WIDTH_MULT = 1.75;

/**
 * Segment ticks per rail (dark notches across the rail, with a rivet at each
 * segment's centre) at capacity 0 and 1. More segments == more hardware ==
 * more inside; 3 is the fewest that still reads as a segmented rail rather
 * than a plain bar, and past ~11 the notches on a 6px rail merge into noise.
 */
export const CONTAINER_TICKS_MIN = 3;
export const CONTAINER_TICKS_MAX = 11;

/**
 * Frame tint (sRGB) and the brightness it is scaled by at capacity 0 and 1.
 *
 * The same cool neutral steel Phase 6.7's detail pieces used, for the same
 * reason: unmistakably "not the thumbnail" against BL's warm paper/ink scans, and a
 * step duller/greyer than both the hover teal (`#7fffe0`) and the HUD chrome
 * cyan so a hovered cage still lights up against its neighbours. The
 * brightness ramp is the third capacity cue after rail width and tick count —
 * a 1-point cage is a dim hairline, a dense one gleams — and its floor is set
 * where the thinnest cage is still visible against the void, not below.
 */
export const CONTAINER_FRAME_COLOR = 0x9aa6b4;
export const CONTAINER_FRAME_BRIGHTNESS_MIN = 0.42;
export const CONTAINER_FRAME_BRIGHTNESS_MAX = 1.05;

/**
 * Fill-gauge accent (sRGB): the colour of the lit fill-line that runs along the
 * inner side of every rail and drains from the top down as thumbnails are
 * extracted (see `VoxelContainers` for the level math). Warm on purpose — the
 * frame is cool steel and the two must read as different materials — and a
 * plain orange rather than the minimap flashlight's yellow-amber (`#ffb347`),
 * which is an additive overlay that lights up whole cubes; a cage whose gauge
 * were the same hue would look permanently flashlit. Kept to a narrow line
 * (rather than tinting whole rails) so 14,000 full containers don't turn the
 * world orange: at browsing distance the line blends into a faint warmth in
 * the frame, and only up close resolves into a gauge.
 */
export const CONTAINER_FILL_COLOR = 0xff8c42;

/**
 * Container opacity while X-Ray is equipped. Cages are deliberately NOT faded
 * to `XRAY_OPACITY` along with their cubes: the whole point of a persistent
 * frame is to stay legible when the thing inside it goes translucent, and the
 * rails are narrow enough (see `CONTAINER_RAIL_WIDTH_*`) that a fully-opaque
 * lattice still shows the cluster behind it. 1 == unchanged.
 */
export const CONTAINER_XRAY_OPACITY = 1;

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
// Environment — depth cues (Phase 6.6, retuned Phase 7)
// ---------------------------------------------------------------------------
//
// Direct feedback: judging distance in an otherwise-black void is hard, and the
// reference is space-flight games (Descent; more recently Elite Dangerous / No
// Man's Sky). The knobs below are the standard cues from that genre —
// atmospheric attenuation with distance, a fixed backdrop to move against, and
// (Phase 7) a backdrop with enough structure to steer by. Phase 6.6 tuned the
// fog "subtle" on request and it ended up imperceptible in practice ("I thought
// we were going to add fog and lighting to make distance easier to judge like
// in a videogame"); Phase 7 retunes it to actually do the job, alongside the
// headlamp in the light rig above.

/**
 * Fog color. Identical to the renderer's clear color (`Engine`'s
 * `setClearColor(FOG_COLOR)`) on purpose — fog that doesn't match the void
 * reads as a visible grey wall hanging in space at the fade distance instead of
 * as depth, because geometry fades toward one color while the void behind it
 * stays another. The nebula sky (below) is a few luminance points brighter
 * than this in places, so at the very limit of the fog a block becomes a
 * faintly darker silhouette against the glow rather than vanishing outright —
 * that is the far-structure-still-readable behaviour the retune wants, and it
 * is only possible because the sky stays this dark.
 */
export const FOG_COLOR = 0x05060a;

/**
 * Fog density, in 1/world-units. The curve is Beer-Lambert, `T = exp(-d *
 * density)` (transmittance; attenuation is `1 - T`) — see `engine/Fog.ts`
 * for how that replaces three's exp2 evaluation while keeping `THREE.FogExp2`
 * as the scene object.
 *
 * Why not three's built-in exp2 (`exp(-(d * density)^2)`), which Phase 6.6
 * used: its shape can't meet the brief. The targets are ~50% attenuation at
 * 40-50 units (the textured ring the LOD pass shrinks to), clearly dim by 100,
 * and the far structure of the map still faintly there at 150-200 (the map is
 * 100 units per axis, 173 on the diagonal). An exp2 that is 50% at 48 units
 * is 98% at 100 and 99.99% at 175 — the far half of the map is simply gone —
 * and one that leaves 8% at 175 is only 25% at 48. Exp2's tail is quadratic;
 * the brief needs a long one. Plain exponential is also what a uniform medium
 * actually does, so nothing about the look is invented.
 *
 * Expressed as a fraction of `WORLD_SCALE` so it re-derives itself if the world
 * is ever rescaled (density is 1/length, so it must scale inversely with the
 * world). Attenuation `1 - exp(-d * density)` at 0.72/WORLD_SCALE = 0.0144:
 *
 *     d =  10 (arm's length)          -> 13% dimmed
 *     d =  25 (a quarter world axis)  -> 30%
 *     d =  50 (a world half-extent)   -> 51%
 *     d = 100 (a full world axis)     -> 76%
 *     d = 133 (the R2 residency edge) -> 85%
 *     d = 175 (the world diagonal)    -> 92%
 *
 * So the block you are mining is essentially untouched, the far side of a
 * cluster is visibly behind its near side, a cluster a world axis away is a
 * dim shape, and the corner of the map is still there — a ghost, but there.
 * Verified headlessly with `gl.readPixels` on a real voxel with the fog toggled
 * (coverage-weighted transmittance, fog on / fog off): measured 0.87 / 0.70 /
 * 0.49 / 0.24 / 0.08 at 10 / 25 / 50 / 100 / 175 against the analytic 0.866 /
 * 0.698 / 0.487 / 0.237 / 0.080.
 */
export const FOG_DENSITY = 0.72 / WORLD_SCALE;

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
// Nebula sky (Phase 7)
// ---------------------------------------------------------------------------
//
// Direct feedback: "I also want a world box for the night sky that has subtle
// color effects in all cardinalities so that the eye has some directional
// orientation for navigation. I like the star box now but it should have some
// color swirls like galaxies or nebulas in different areas so one can navigate
// by the stars so to speak."
//
// So: a procedural cubemap (`engine/NebulaSky.ts`), rendered once at startup
// and set as `scene.background`, in which every cardinal direction has its own
// hue, a pale band arcs overhead, and a few brighter knots sit at fixed
// bearings. The starfield draws on top of it unchanged. `?sky=0` falls back to
// the flat clear color for A/B; `window.lsv.sky.regenerate(seed)` re-rolls the
// nebulae from the console.

/**
 * Nebula hue per cardinal direction, as sRGB hex, in the order
 * `+X, -X, +Y, -Y, +Z, -Z`. This is the navigation contract: a glance at the
 * sky says which way you face, so the six must be far apart on the hue wheel
 * and each must be nameable —
 *
 *     +X  warm amber          -X  deep blue
 *     +Y  pale (the band)     -Y  dull red, the darkest region
 *     +Z  violet / magenta    -Z  teal / green
 *
 * — with opposites chosen as complements (amber/blue, violet/teal) so turning
 * around is the biggest colour change of all. Between cardinals the shader
 * blends by the squared direction components, so a diagonal is an even mix of
 * its two neighbours and there are no seams. The values are muted on purpose:
 * `SKY_BRIGHTNESS` scales the whole sky and the hues here only set the
 * proportions, but a saturated hue at low brightness still reads as garish
 * where two nebulae overlap.
 */
export const SKY_CARDINAL_COLORS: readonly [number, number, number, number, number, number] = [
  0xd8903c, 0x3a5cd0, 0xa9bbdc, 0x7a2e2e, 0xa24cd2, 0x2fb89a,
];

/** The overhead band's own colour — a pale, slightly cool off-white, so it
 * reads as a distant Milky Way rather than as another nebula. */
export const SKY_BAND_COLOR = 0xc9d3e8;

/** Core colour of the galaxy knots — near-white, warm, so a knot is the one
 * thing in the sky that reads as a light rather than a glow. Each knot is
 * still tinted by the nebula hue of the region it sits in. */
export const SKY_KNOT_COLOR = 0xfff0dc;

/**
 * Global sky brightness, a linear-light multiplier on everything the shader
 * draws. The sky is a backdrop and a compass, not a subject: the cubes and the
 * HUD must stay the brightest things on screen. Measured headlessly at 0.075,
 * looking along each axis from the world centre with the world hidden: mean
 * sky luminance 19 / 8 / 23 / 2 / 6 / 12 (/255) for +X / -X / +Y / -Y / +Z /
 * -Z (+Y is the band, -Y the nadir), 99th percentile 40-52, and not a single
 * sky pixel above 90 — against the HUD's dimmest text at 146
 * (`--hud-text-dim`), a fogged cube at 25 units at ~105, and a lit one up
 * close at 150-190. The clear colour it replaces is 6. The first pass at 0.16
 * put the band at a mean of 43 and the knots at 200: a grey smear you looked
 * at instead of a glow you steered by.
 */
export const SKY_BRIGHTNESS = 0.075;

/**
 * Cubemap face size in pixels. 512 per 90° face is ~5.7 texels per degree;
 * a 1600 px-wide 70° view magnifies that ~4x, which is invisible on fBm this
 * soft — the finest octave the shader evaluates is ~1.3 cycles per degree,
 * still 4+ texels per cycle — and there are no hard edges anywhere in the sky
 * to reveal it. 1024 would cost 4x the VRAM (6 MB vs 1.5 MB) for a texture
 * that is only ever looked up.
 */
export const SKY_FACE_PX = 512;

/** Default noise seed. Any integer; deterministic so the sky is byte-identical
 * across reloads (the same reason `Starfield` seeds its PRNG — headless
 * before/after comparisons, and a landmark someone noticed is still there next
 * session). Re-roll from the console with `lsv.sky.regenerate(n)`. */
export const SKY_SEED = 7;

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
 *
 * 16 -> 8, from the next round of real use: "the movement speed is still too
 * fast, we should move half as fast in all directions." Cruise is now for
 * browsing — reading thumbnails as they go by — and covering distance is an
 * explicit, opt-in gesture instead: double-tap-and-hold W sprints at
 * `FLIGHT_SPRINT_MULTIPLIER` x this (Minecraft's own sprint binding, so it
 * needs no new key). At 8 an axis takes ~12.5s to cross at cruise, ~5s
 * sprinting.
 */
export const FLIGHT_SPEED = 8;

/** Vertical (Space/Shift, or the legacy E/Q) speed, world units / second.
 * Matched to `FLIGHT_SPEED` on purpose: with vertical bound to the same hand
 * position as in Minecraft creative, a slower climb than cruise reads as the
 * controls sticking rather than as a deliberate axis difference. Halved with
 * it ("half as fast in all directions"). */
export const FLIGHT_VERTICAL_SPEED = 8;

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

/**
 * Sprint: double-tap W and keep it held (Minecraft's sprint gesture) to fly
 * faster until W is released; applies to every axis while it's held, so a
 * strafe or climb during a sprint keeps up with the forward motion instead of
 * lagging it. 2.5x the halved cruise speed lands at 20 units/s — a bit above
 * the 16 that was "too fast" for browsing, which is the right place for a
 * gesture whose whole purpose is getting somewhere. The easing
 * (`FLIGHT_ACCEL_TAU_S`) applies to the sprint transition too, so engaging it
 * is a surge, not a jump cut.
 */
export const FLIGHT_SPRINT_MULTIPLIER = 2.5;

/**
 * Two W presses closer together than this count as the sprint double-tap.
 * 300ms is Minecraft's own window (7 ticks at 20 Hz = 350ms, rounded down
 * slightly): long enough to be reliable on a normal keyboard, short enough
 * that stop-and-go browsing (press W, release, press W a moment later) never
 * triggers it by accident. Auto-repeat keydowns from holding W don't count.
 */
export const FLIGHT_SPRINT_DOUBLE_TAP_MS = 300;

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

// ---------------------------------------------------------------------------
// Minimap hover-pan (Phase 6.9)
// ---------------------------------------------------------------------------
//
// Direct feedback: "i want to try it so that hovering over the 2d map causes
// the camera to pan to that part of the map (where it would teleport you to)
// and have the pan be transitioned not instant and debounced."
//
// So: let the cursor rest on a spot of the 2D map and the camera drifts to
// exactly where a click would have teleported it — same destination
// resolution, same chunk prefetch, same Engine flight (see
// `MinimapBridge.hoverPanToQ`) — only later (debounced), slower (its own
// duration constants below) and revocable (any flight input cancels it,
// whereas a click's teleport is a deliberate command and always lands). The
// flashlight is untouched; the pan is layered on top of it.

/**
 * How long the cursor has to rest on one spot of the minimap before a hover
 * pan fires, ms. Every pointermove over the panel restarts the clock, so a
 * sweep across the map — which delivers a move every ~8-16 ms — never fires
 * one; only a deliberate pause does.
 *
 * 350 is the same order as `FLIGHT_SPRINT_DOUBLE_TAP_MS` (300), the app's
 * other "two events this close are one gesture" window, and about the time it
 * takes to register the flashlight highlight the hover already produced and
 * decide to stay there. Shorter (~200) starts firing on the natural
 * micro-pauses of a scan across the map, turning browsing into a camera that
 * lurches after the cursor; longer (500+) reads as the map not responding,
 * since the flight it then starts takes the better part of a second on top.
 */
export const MINIMAP_HOVER_PAN_DEBOUNCE_MS = 350;

/**
 * Hover-pan flight duration: derived from distance and clamped exactly like
 * the click-teleport's (`TELEPORT_*` above), but gentler on every axis —
 * ~1.5x the ms-per-unit and ~2x both clamps. A click is a command and its
 * flight should feel like arriving; a pan is a consequence of where the cursor
 * happens to rest, so the camera drifts over rather than lunges: for the same
 * unclamped distance its peak speed is 9/14 ≈ 2/3 of the click's. The floor
 * (600) keeps a pan to the next voxel over reading as motion rather than a
 * cut, and the ceiling (1600) is where a corner-to-corner crossing (~173
 * units) starts feeling like waiting on a cutscene — especially since the
 * debounce already sits in front of it.
 */
export const MINIMAP_HOVER_PAN_MS_PER_WORLD_UNIT = 14;
export const MINIMAP_HOVER_PAN_MIN_MS = 600;
export const MINIMAP_HOVER_PAN_MAX_MS = 1600;

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
