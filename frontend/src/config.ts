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
 * data server (port 8802 by default; `LSV_DATA_PROXY_TARGET` overrides it).
 * A direct cross-port browser fetch to :8802 was
 * tried first and gets blocked by Chrome's Private/Local Network Access
 * policy once the page is served over plain http from a LAN hostname like
 * gsv.local — proxying through Vite's Node process sidesteps that entirely,
 * and incidentally means the same build works unmodified from localhost, any
 * LAN IP, or gsv.local.
 */
export interface DatasetConfig {
  /** Path on the chunk server to the directory holding `manifest.json`. */
  path: string;
  /** Human-readable label for the HUD. */
  label: string;
  /**
   * Id of the POINTS TABLE this chunk-pack was binned from — the `<points_id>`
   * segment of the data server's per-row original-image lookup,
   * `GET /meta/<points_id>/<row_id>` (see `streaming/PointMeta.ts`). This is
   * NOT the chunk-pack id: a points table is one UMAP fit's worth of rows,
   * and every voxel resolution built from it shares the same `row_id`s, so
   * `bl` and `bl-160` both look up `bl`, and each MONET arm's 96^3 and 160^3
   * packs both look up that arm (`monet-random`, …). Required rather than
   * defaulted from the key so that a new pack can't silently ask the server
   * about a table that doesn't exist (a 404 there reads as "no original for
   * any row", which is exactly the kind of quiet wrongness a lookup like this
   * should never produce).
   */
  pointsId: string;
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
  pointMetaFile?: { path: string; bytes: number; rows: number };
  searchProfile?: "bl-siglip2-20260907a";
}

const ALL_DATASETS: Record<string, DatasetConfig> = {
  "monet-clip-basemap-full-4m-512": {
    path: "/chunks/monet-clip-basemap-full-4m-20260906a-512-stream",
    label: "MONET · CLIP ViT-B/32 · 4M head · 103.82M · 512³",
    pointsId: "monet-clip-basemap-full-4m-20260906a",
    minimapPath: "/minimap/monet-clip-basemap-full-4m-20260906a",
  },
  "monet-clip-basemap-pool-512": {
    path: "/chunks/monet-clip-basemap-pool-20260905a-512-stream",
    label: "MONET · CLIP ViT-B/32 · basemap · 19.34M · 512³",
    pointsId: "monet-clip-basemap-pool-20260905a",
    minimapPath: "/minimap/monet-clip-basemap-pool-20260905a",
  },
  "monet-clip-basemap-training-512": {
    path: "/chunks/monet-clip-basemap-training-20260905a-512-stream",
    label: "MONET · CLIP ViT-B/32 · basemap · 2.01M · 512³",
    pointsId: "monet-clip-basemap-training-20260905a",
    minimapPath: "/minimap/monet-clip-basemap-training-20260905a",
  },
  // Display the projection embedding separately from the sampling arm. MONET's
  // SSCD label describes how rows were drawn, not the embedding used by UMAP.
  // Verified source/model evidence: docs/dataset-provenance.md. Keep URL keys and
  // points IDs stable so bookmarks and row metadata still address the same data.
  "bl-160": {
    path: "/chunks/bl-160",
    label: "BL · SigLIP 2 · 1.08M · 160³",
    pointsId: "bl",
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
  // 160^3 variants of the same three arms ("I want 160 for monet"), built
  // next to the 96^3 packs the way `bl-160` sits next to `bl`. Same points
  // table, fit and minimap pack per arm — only the voxel binning differs.
  "monet-random-160": {
    path: "/chunks/monet-random-160",
    label: "MONET · CLIP ViT-B/32 · random draw · 2M · 160³",
    pointsId: "monet-random",
    minimapPath: "/minimap/monet-random",
  },
  "monet-sscd-160": {
    path: "/chunks/monet-sscd-160-stream-20260904b",
    label: "MONET · CLIP ViT-B/32 · SSCD draw · 2M · 160³",
    pointsId: "monet-sscd",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-sscd-512": {
    path: "/chunks/monet-sscd-512-stream-20260905a",
    label: "MONET · CLIP ViT-B/32 · SSCD draw · 2M · 512³",
    pointsId: "monet-sscd",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-annfaiss-160": {
    path: "/chunks/monet-annfaiss-160",
    label: "MONET · CLIP ViT-B/32 · ANN-FAISS draw · 2M · 160³",
    pointsId: "monet-annfaiss",
    minimapPath: "/minimap/monet-annfaiss",
  },
  // The fourth arm, the research project's own faiss-based rarity draw. Its
  // packs are built by the same per-arm chain as the other three.
  "monet-theirfaiss-160": {
    path: "/chunks/monet-theirfaiss-160",
    label: "MONET · CLIP ViT-B/32 · their-FAISS draw · 2M · 160³",
    pointsId: "monet-theirfaiss",
    minimapPath: "/minimap/monet-theirfaiss",
  },
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
 * New builds use compact per-chunk atlases, so finer grids no longer force a
 * full 2048² texture on every sparsely occupied chunk. Existing packs remain
 * readable through the legacy local-voxel-id atlas layout.
 */
export const DEFAULT_DATASET = import.meta.env.VITE_DEMO_DATASET || "monet-sscd-512";
export const DATASETS: Record<string, DatasetConfig> = import.meta.env.VITE_DEMO_DATASET === "bl-160"
  ? { "bl-160": { ...ALL_DATASETS["bl-160"], path: "/chunks/bl-siglip2-160-stream-20260907a",
      searchProfile: "bl-siglip2-20260907a",
      pointMetaFile: { path: "/points/bl/point_meta.bin", bytes: 77049305, rows: 1080814 } } }
  : ALL_DATASETS;

/**
 * Optional data-server origin. `VITE_DATA_ORIGIN=https://data.example.org`
 * makes a production build fetch every pack/thumbnail/meta route there;
 * absent means same-origin, which lets Vite's development proxy (or a reverse
 * proxy in production) handle it. Trailing slashes are normalized away.
 */
const configuredDataOrigin = import.meta.env.VITE_DATA_ORIGIN?.trim();
export const CHUNK_SERVER_ORIGIN: string | null = configuredDataOrigin
  ? configuredDataOrigin.replace(/\/+$/, "")
  : null;

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
 * plus a hemisphere light whose ground color is near-black (`main.ts`; the
 * Phase 7 headlamp only reaches an underside while you are beneath it), so a
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
 * A stronger warm key and quieter fill now separate faces more clearly.
 * main.ts adds a cool rim, Engine bakes a small lighting-only environment and
 * rolls off highlights with ACES. No shadow maps or postprocessing passes.
 */
export const HEMISPHERE_SKY_COLOR = 0xbcd0ff;
export const HEMISPHERE_GROUND_COLOR = 0x14141f;
export const HEMISPHERE_INTENSITY = 0.6;
export const SUN_COLOR = 0xfff2e0;
export const SUN_INTENSITY = 1.8;

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
 * Half a `WORLD_SCALE` = 25 units = 2.5 chunk edges on bl-160 — exactly the
 * R1 prefetch ring (`RING_R1_CHUNKS`), so the lamp runs out where the
 * textured chunks give way to flat proxy voxels. Three's cutoff window
 * `(1 - (r/cutoff)^4)^2` fades it out over the last third rather than
 * clipping.
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
// detail — whose weight says how many thumbnails are inside and which dims,
// then fades, as they are extracted. All of it is drawn procedurally in one
// shader (`voxels/VoxelContainers.ts`) from two per-instance numbers,
// `capacity` and `fullness`; everything below is the tuning surface. The cage
// has no X-Ray opacity of its own: X-Ray hides the cages outright (see
// `VoxelContainers.setXrayActive`), which is not a tunable.

/**
 * Container edge as a multiple of the cube edge (`manifest.voxelWorldSize *
 * VOXEL_FILL`). 1.04 leaves a 2%-of-edge gap per face: a close-fitting housing
 * with clearance from the image cube (including its sharp replacement).
 */
export const CONTAINER_SCALE = 1.04;

/** Cages are fine detail, unlike the thumbnail cubes themselves. Past this
 * camera-to-chunk-center distance they contribute mostly fragment discard and
 * visual noise, so the whole per-chunk cage draw is skipped. */
export const CONTAINER_RENDER_DISTANCE_CHUNKS = 2.0;

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
 * 2.5–6.5% keeps the thumbnail dominant. Fine brushed detail is filtered out
 * at distance; broader pale chamfers remain readable around the inset channel.
 */
export const CONTAINER_RAIL_WIDTH_MIN = 0.025;
export const CONTAINER_RAIL_WIDTH_MAX = 0.065;

/**
 * Corner brackets: an L-shaped plate at each of the cube's 8 corners, this far
 * along each edge from the corner (fraction of the container edge, at
 * capacity 0 and 1) and this many rail-widths wide. Brackets grow with
 * capacity for the same reason rails do — a heavy crate is braced at the
 * corners, a light one just has edges. Ceramic shoulder inlays distinguish
 * the corner plates from the seamed rails between them.
 */
export const CONTAINER_BRACKET_LENGTH_MIN = 0.10;
export const CONTAINER_BRACKET_LENGTH_MAX = 0.20;
export const CONTAINER_BRACKET_WIDTH_MULT = 1.45;

/**
 * Fine expansion seams per rail at capacity 0 and 1. More seams == more hardware ==
 * more inside; 3 is the fewest that still reads as a segmented rail rather
 * than a plain bar, and past ~11 the notches on a 6px rail merge into noise.
 */
export const CONTAINER_TICKS_MIN = 3;
export const CONTAINER_TICKS_MAX = 11;

/**
 * Frame tint (sRGB) and the brightness it is scaled by at capacity 0 and 1.
 *
 * A neutral near-white — no hue at all. It was a cool blue-grey steel
 * (`0x9aa6b4`) with a warm orange fill-line running along every rail, until
 * direct feedback: "i dont want orange on the greeble texture, lets use a more
 * neutral white." The cage keeps pale metal and graphite channels, and
 * every tone on it (brushed body, chamfers, ceramic inlays, fine seams) is
 * this colour at some brightness. Still unmistakably "not the thumbnail"
 * against BL's warm paper/ink scans and MONET's paintings — a grey frame reads
 * as hardware around a picture, not as part of it — and still a clear step
 * from both the hover teal (`#7fffe0`) and the HUD chrome cyan, so a hovered
 * cage lights up against its neighbours. The brightness ramp is the third
 * capacity cue after rail width and tick count — a 1-point cage is a dim
 * hairline, a dense one gleams — and its floor is set where the thinnest cage
 * is still visible against the void, not below.
 */
export const CONTAINER_FRAME_COLOR = 0xc4c6c8;
export const CONTAINER_FRAME_BRIGHTNESS_MIN = 0.42;
export const CONTAINER_FRAME_BRIGHTNESS_MAX = 1.05;

/**
 * Depletion ramp: how the WHOLE cage changes as its voxel drains, driven by
 * the per-instance `fullness` (1 untouched … 0 every thumbnail extracted).
 * Two ramps in sequence, per direct feedback ("instead of top-down fading of
 * the greeble lets have brightness then opacity ramp down"):
 *
 *   1. brightness — from fullness 1 down to `CONTAINER_DEPLETION_BRIGHTNESS_END`
 *      the cage's colour is scaled linearly from 1 to
 *      `CONTAINER_DEPLETION_BRIGHTNESS_FLOOR` and then holds there;
 *   2. opacity — from `CONTAINER_DEPLETION_OPACITY_START` down to fullness 0
 *      the cage's alpha is scaled linearly from 1 to
 *      `CONTAINER_DEPLETION_OPACITY_FLOOR`.
 *
 * So the first half of a drain is a cage going dark and the second half is a
 * dark cage going faint, and a drained voxel wears a dim, ghostly frame — a
 * frame, still, so the block reads as "emptied" rather than "gone", which
 * matters now that a drained voxel is pass-through to the cursor (see
 * `engine/Raycast.ts`) and the frame is the only thing left saying it exists.
 * The two breakpoints are the same number so the ramps hand off exactly; they
 * are separate constants so the ramps could overlap or leave a plateau
 * between them without touching the shader. Each ramp needs a nonzero span:
 * the brightness end must stay below 1 and the opacity start above 0 (the
 * shader divides by those spans).
 *
 * Domains: the brightness floor is DISPLAY-referred — the shader multiplies
 * the sRGB-encoded output by it, after the colour-space transform — so 0.35
 * means a cage that looks 35% as bright on screen. (Applied to linear light
 * like `CONTAINER_FRAME_BRIGHTNESS_*` are, the transform would lift the same
 * 0.35 to ~60% on screen and the first half of a drain would barely read.)
 * The opacity floor is a plain alpha, which blends linearly on screen anyway.
 *
 * Floors: on screen, 35% is well under the dimmest untouched cage — a
 * 1-point voxel's `CONTAINER_FRAME_BRIGHTNESS_MIN` of 0.42 in linear light
 * displays at roughly 68% — so a half-drained dense cage can't be mistaken
 * for a full sparse one, and it is above the level where a grey frame merges
 * with the fog. 0.15 alpha over a cube that is itself at
 * `EXTRACTION_FLOOR_OPACITY` (0.3) keeps the frame just visible against the
 * void without the two together reading as a solid.
 */
export const CONTAINER_DEPLETION_BRIGHTNESS_END = 0.5;
export const CONTAINER_DEPLETION_BRIGHTNESS_FLOOR = 0.35;
export const CONTAINER_DEPLETION_OPACITY_START = 0.5;
export const CONTAINER_DEPLETION_OPACITY_FLOOR = 0.15;

// ---------------------------------------------------------------------------
// Streaming rings
// ---------------------------------------------------------------------------

/**
 * Ring radii, expressed in *chunk edge lengths* from the camera to a chunk's
 * center, so they stay meaningful across datasets with different
 * `chunks_per_axis`. R0 = fetch now, R1 = background prefetch, R2 = keep
 * resident if already loaded, beyond R2 = evict.
 *
 * 3 / 5 / 8 -> 1.5 / 2.5 / 3.5 (Phase 8, LOD). Direct feedback: "are we only
 * loading visible chunks for performance, I want to feel like we are in a big
 * universe not able to see the whole thing at once. is there some trick to
 * have distant chunks approximated so we can still highlight when turning to
 * them but not showing images? in Minecraft it's possible to fly for some time
 * before more chunks are loaded."
 *
 * The old radii were sized so the whole pack was effectively resident — at the
 * bl-160 spawn, 190 of 246 chunks inside R1 and all 246 inside R2: every
 * thumbnail in the world on the GPU at once, and nothing left to fly toward.
 * Now every occupied voxel the camera is NOT near is drawn from
 * `voxel_proxy.bin` as a flat mean-coloured block (`voxels/VoxelProxyCloud.ts`,
 * the "distant chunks approximated" half of the ask), so the textured ring
 * only has to cover what you can actually read a thumbnail on. On bl-160
 * (chunk edge 10 units) that is textures within 15 units, prefetch out to 25,
 * keep to 35 — the same numbers the environment pass was tuned around: the
 * headlamp runs out at 25 (`HEADLAMP_RANGE`), and the fog is 30% at 25 and
 * 40% at 35, so a chunk swaps from flat blocks to thumbnails while it is still
 * in the haze rather than popping in sharp. At spawn that is ~45 resident
 * chunks instead of ~190 (measured 44 / 91 inside R1 / R2). The one-edge band
 * between R1 and R2 is the eviction hysteresis: a chunk fetched at 25 units is
 * not dropped until you have backed off to 35, ~1.25 s at cruise.
 *
 * Distances are to a chunk's CENTER, so a chunk at the R0 edge can hold
 * voxels 6 units away (half a chunk diagonal is 8.7) and one just outside R1
 * can hold voxels at 17 — the swap is per chunk, not per voxel, and at these
 * radii it happens well inside the headlamp's reach.
 */
export const RING_R0_CHUNKS = 1.5;
/** Prefetch is not visibility: keep a coherent nearer thumbnail horizon. */
export const THUMBNAIL_SHOW_RADIUS_CHUNKS = 2.2;
export const THUMBNAIL_HIDE_RADIUS_CHUNKS = 2.4;
export const STREAM_MAX_CHUNKS = 96;
export const STREAM_MAX_BYTES = 384 * 1024 * 1024;
export const STREAM_MAX_INSTANCES = 98304;
export const RING_R1_CHUNKS = 2.5;
export const RING_R2_CHUNKS = 3.5;

/** Max chunk fetches in flight at once. */
export const MAX_CONCURRENT_CHUNK_LOADS = 6;

/** Additional attempts for transient chunk/network failures. Corrupt pack
 * data and definitive 4xx responses still fail immediately. */
export const CHUNK_LOAD_MAX_RETRIES = 3;
export const CHUNK_LOAD_RETRY_BASE_MS = 500;
export const CHUNK_LOAD_RETRY_MAX_MS = 4_000;

/**
 * Hard caps on residency, enforced farthest-first once the ring pass is done.
 *
 * Legacy packs carry a full 2048px atlas per chunk (measured around 5.7 MB
 * decoded on BL), so this intentionally remains large enough for them. New
 * compact packs scale each atlas to occupied voxel count and generally sit
 * far below this ceiling.
 *
 * With the Phase 8 rings these almost never bind: a keep sphere of 3.5 chunk
 * edges holds at most ~180 chunk slots (4/3·π·3.5³) and on every current pack
 * far fewer are occupied (bl-160 spawn: 91 inside R2, ~520 MB), so the ring
 * pass alone keeps residency under both caps. They stay as the safety net for
 * a pack with larger atlases, not as a knob anything is tuned against.
 */
export const MAX_RESIDENT_CHUNKS = 512;
export const MAX_RESIDENT_ATLAS_BYTES = 1280 * 1024 * 1024;

/** Re-run the ring classification only after the camera has moved this far
 * (world units) — the pass is O(occupied chunks) and doesn't need to run at
 * 120 Hz while hovering in place. */
export const CHUNK_UPDATE_MOVE_EPSILON = 1.5;

/** Re-prioritize queued chunks after a meaningful stationary camera turn. */
export const CHUNK_UPDATE_TURN_EPSILON_RAD = (3 * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Voxel proxies (Phase 8 — LOD)
// ---------------------------------------------------------------------------
//
// The far-LOD layer: every occupied voxel of the dataset, drawn as a flat cube
// of its mean thumbnail colour from the always-resident `voxel_proxy.bin`
// (`voxels/VoxelProxyCloud.ts`), hidden chunk-by-chunk as the textured chunks
// stream in and shown again as they evict. This replaces the Phase 2 proxy
// cloud (one translucent box per CHUNK from `proxy.bin`), which gave the world
// a silhouette but nothing you could point at: a proxy voxel sits exactly where
// its thumbnail will, at the same size, so the hover box lands on it and the
// minimap flashlight lights it — "still highlight when turning to them but not
// showing images". The two knobs below are the whole look; the proxies take
// the scene lights, the headlamp and the fog through the same
// `MeshStandardMaterial` path the textured cubes use, so nothing about
// distance is tuned separately for them.

/**
 * How much of a proxy voxel's mean-colour saturation survives (1 = the colour
 * as stored, 0 = the equivalent grey) and what its brightness is scaled by, in
 * linear light.
 *
 * The brief is "reads as unloaded next to a loaded voxel without looking
 * broken". A flat matte cube with no cage already reads as a placeholder next
 * to a thumbnail, so this only has to make sure it never reads as the REAL
 * block seen from too far to resolve. Brightness is the knob that does that:
 * BL's mean colours are pale paper (median sRGB luminance ~200), and at full
 * brightness a wall of them is a bright beige mass that outshouts the textured
 * ring in front of it. At 0.6 (≈ 0.79 in sRGB, so that median goes ~200 ->
 * ~160) a proxy face at 26-32 units measured luminance 57-76 against 93-119
 * for a textured face at 21-24 — a clear step behind, still plainly a block.
 * Below ~0.45 the far map went muddy under the fog (a fogged block is already
 * at 50% by 50 units).
 *
 * Saturation turned out to be nearly a no-op on BL — its means are so close to
 * neutral that an in-page A/B of 0.55 vs 0.8 changed 37 pixels of a 900x560
 * crop — and it is what keeps MONET's palette (blues, ochres, whites) readable
 * as a fogged coloured silhouette from across the map, which is the point of
 * drawing the far map in colour at all. So only a light pull toward grey: 0.75
 * takes the edge off a saturated painting's mean without flattening the map.
 * Checked on the wide and browsing-distance screenshots in the Phase 8
 * verification.
 */
export const VOXEL_PROXY_SATURATION = 0.75;
export const VOXEL_PROXY_BRIGHTNESS = 0.6;

/**
 * Flashlight on a proxy voxel: its colour is pulled this fraction of the way
 * toward the minimap flashlight amber (`MINIMAP_FLASHLIGHT_COLOR_3D`) and its
 * brightness multiplied by this much, on top of the additive glow box the
 * flashlight already draws there. The tint makes a lit proxy the same amber
 * as everything else the flashlight touches; the brightness bump is what
 * keeps it visible through the fog at the distances proxies live at.
 * Restored to the base colour when the flashlight moves on.
 *
 * 2.4 -> 1.6: at 2.4 the bump stacked with the additive glow box and clipped
 * to pure white (a (255,255,255) probe pixel at 30 u in the Phase 8 review),
 * so a lit region read as a white-yellow blob rather than as amber blocks.
 * 1.6x on a 0.6-brightness proxy is ~0.96 albedo — the brightness of an
 * unlit textured cube — which the glow box then lifts without saturating.
 */
export const VOXEL_PROXY_LIT_TINT = 0.6;
export const VOXEL_PROXY_LIT_BRIGHTNESS = 1.6;

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
 * stays another. The nebula sky (below) is brighter than this wherever it
 * has structure (per-direction means of 11-29 /255 against 6 here), so at
 * the very limit of the fog a block becomes a darker silhouette against the
 * glow rather than vanishing outright — that is the far-structure-still-
 * readable behaviour the retune wants, and it is only possible because the
 * fog colour stays this dark.
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
 * 40-50 units (just past the R2 keep ring, so the proxy voxels beyond the
 * textured chunks are already half-faded), clearly dim by 100, and the far
 * structure of the map still faintly there at 150-200 (the map is 100 units
 * per axis, 173 on the diagonal). An exp2 that is 50% at 48 units
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
 *     d =  25 (the R1 prefetch edge)  -> 30%
 *     d =  35 (the R2 keep edge)      -> 40%
 *     d =  50 (a world half-extent)   -> 51%
 *     d = 100 (a full world axis)     -> 76%
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
 * far outside the world (half-extent 50, 87 to a corner), so stars always read
 * as "infinitely far away" and can never be flown into or mistaken for data.
 * It has to stay comfortably inside `CAMERA_FAR` (1200) from
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
// hue, each hue's nebula whirls about a fixed centre, a pale band arcs
// overhead, and four spiral galaxies sit at fixed bearings. The starfield
// draws on top of it unchanged. `?sky=0` falls back to the flat clear color
// for A/B; `window.lsv.sky.regenerate(seed)` re-rolls the nebulae from the
// console (the swirl centres, band and galaxies stay put — they are the
// landmarks).
//
// The first pass at this was too dark to steer by (mean sky luminance 2-23
// /255 per direction, the nadir 2) and had no swirls — un-warped noise blobs
// and four out-of-focus discs. This version brings the coloured nebulae up
// to where a hue is unmistakable at a glance, gives them vortex structure,
// replaces the discs with spiral galaxies, and splits the brightness into
// three knobs so the band and galaxies stay accents while the nebulae come
// up.

/**
 * Nebula hue per cardinal direction, as sRGB hex, in the order
 * `+X, -X, +Y, -Y, +Z, -Z`. This is the navigation contract: a glance at the
 * sky says which way you face, so the six must be far apart on the hue wheel
 * and each must be nameable —
 *
 *     +X  warm amber          -X  deep blue
 *     +Y  pale silver-blue    -Y  dull red, the darkest region
 *     +Z  magenta / violet    -Z  teal / sea-green
 *
 * — with opposites chosen as complements so turning around is the biggest
 * colour change of all. Measured on the rendered sky (dominant hue of each
 * axis view = mean of the pixels above luminance 12, in HSL; same setup as
 * `SKY_NEBULA_BRIGHTNESS`): +X 35° / +Z 306° / -X 225° / -Z 158° around the
 * horizon, +Y 227° (pale, saturation 0.14) and -Y 355°. Neighbours on the
 * horizon ring are 67-122° apart; opposites 170° (X), 148° (Z) and 128° (Y).
 * The rendered hue lands 5-15° off the hex because every view blends its
 * neighbours in at the frame edges — that pull toward the blue side is why
 * +Z is set past magenta (`0xdc50c0`) and -Z past teal (`0x34c080`): the
 * earlier violet/teal pair (`0xa24cd2` / `0x2fb89a`) rendered only 111°
 * apart. The nadir red is brighter than it used to be (`0x7a2e2e` ->
 * `0x963848`, hue shifted toward crimson to sit 40° from the amber) because
 * the nadir's hue IS its brightness floor: the nebula there is mostly the
 * faint all-over term, and with the darker red the -Y view could not reach
 * a mean of 10 no matter how that term was set. Between cardinals the shader
 * blends by the squared direction components, so a diagonal is an even mix
 * of its two neighbours and there are no seams. The values are muted on
 * purpose: `SKY_NEBULA_BRIGHTNESS` scales the nebulae and the hues here only
 * set the proportions, but a saturated hue at low brightness still reads as
 * garish where two nebulae overlap.
 */
export const SKY_CARDINAL_COLORS: readonly [number, number, number, number, number, number] = [
  0xdc9a38, 0x3a5cd0, 0xa9bbdc, 0x963848, 0xdc50c0, 0x34c080,
];

/** The overhead band's own colour — a pale, slightly cool off-white, so it
 * reads as a distant Milky Way rather than as another nebula. */
export const SKY_BAND_COLOR = 0xc9d3e8;

/** Core colour of the galaxies — near-white, warm, so a galaxy's core is the
 * one thing in the sky that reads as a light rather than a glow. The disc and
 * arms are tinted 70/30 by the nebula hue of the region the galaxy sits in
 * and this, so each galaxy is also the colour of its cardinal (at 60/40 all
 * four read grey-white; the mix is what keeps the arms bright enough — the
 * cardinal hues are muted, this is not). */
export const SKY_GALAXY_CORE_COLOR = 0xfff0dc;

/**
 * Brightness of the three sky layers, each a linear-light multiplier on what
 * the shader draws for that layer. Three knobs instead of one because the
 * layers want different exposures: turning a single master up until the
 * nebulae were legible put the band at a grey smear and the knots at 200/255
 * (the rejected first pass). The sky is a backdrop and a compass, not a
 * subject: the cubes and the HUD must stay the brightest things on screen.
 *
 * Targets, measured headlessly with the world hidden and the stars on, looking
 * along each axis from the world centre at 1600x900 (full frame): every
 * direction's mean luminance in ~14-32 /255 with the nadir the darkest and no
 * lower than ~10; 99th percentile under ~120 and no sky pixel above 140 — the
 * HUD's dimmest text is 146 (`--hud-text-dim`) and must stay brighter than
 * any sky pixel. For reference a fogged cube at 25 units reads ~105 and a lit
 * one up close 150-190; the clear colour the sky replaces is 6.
 *
 * Measured at these values (mean / p99 / max luminance per axis view, stars
 * off for the max so it is the sky's own):
 *
 *     +X 22.8 / 69 / 112     -X 25.5 / 69 / 114     +Y 24.4 / 65 /  80
 *     -Y 11.0 / 45 /  56     +Z 14.0 / 46 / 109     -Z 28.2 / 67 / 112
 *
 * The maxima are the galaxy cores (109-114 looking straight at each one);
 * `SKY_GALAXY_BRIGHTNESS` is what caps them, and 0.13 puts the cores just
 * under the fogged-cube level so a galaxy reads as a light without competing
 * with a block. The stars themselves peak at 141-215 (1-16 pixels per view;
 * the 215 is one star sitting on the blue galaxy's core — the starfield is
 * additive) — that is `STARFIELD_OPACITY`, unchanged, and the only thing in
 * the sky brighter than the HUD text. With the world visible at the spawn pose the
 * frame reads mean 67, p90 154: the cubes.
 *
 * The nebula value was picked by measuring, not by eye: at 0.16 the
 * horizontal views averaged 16-27 with the magenta side at 16 and the nadir
 * at 8; 0.2 with the hue and swirl changes above lands every direction in
 * range. The band at 0.08 puts the +Y view at 24 (its max 80 is the band's
 * brightest dust-free stretch); at 0.045 the band was there but you had to
 * look for it, and 0.06 was still under the pale nebula around it.
 */
export const SKY_NEBULA_BRIGHTNESS = 0.2;
export const SKY_BAND_BRIGHTNESS = 0.08;
export const SKY_GALAXY_BRIGHTNESS = 0.13;

/** A direction on the sky: azimuth in degrees around +Y measured from +X
 * toward +Z, elevation in degrees above the horizon. */
export interface SkyBearing {
  azimuthDeg: number;
  elevationDeg: number;
}

/**
 * Swirl centres. Before the shader samples any noise it twists the sampling
 * direction about each of these by `twistRad` at the centre falling to zero
 * at `radiusDeg` — a twirl that shears the nebula noise into arcs around the
 * centre — and each centre adds a broad lobe of nebula density, so the
 * densest part of every cardinal's nebula is also the part that visibly
 * whirls. One per horizontal cardinal, ~10° off the exact axis so the vortex
 * reads as an object near where you are looking rather than as a bullseye
 * you are looking down; none at the zenith (the band owns it — a swirl there
 * turned the +Y view into a grey whirlpool with the band lost inside it) and
 * none at the nadir, which stays the darkest region. Twist signs alternate
 * around the horizon so neighbouring vortices turn opposite ways, and each
 * has its own radius / twist so the four are different characters: +X a
 * broad loose swirl, +Z a wide medium one, -X the tightest vortex, -Z in
 * between. Fixed, not seeded: the seed re-rolls the noise inside them.
 *
 * Twist / radius are what make the shear visible: with the smoothstep
 * falloff the ring-to-ring rotation peaks at ~1.5 * twist / radius (rad per
 * rad) halfway out, so a feature 5° across at half radius is drawn into an
 * arc 2-3x its width at these values — enough to read as a vortex, not
 * enough to close into rings. The first pass used twists of 4.5-5 rad: the
 * arcs closed into concentric rings and every direction was a bullseye.
 * Half these twists and the arcs read as ordinary lumpy noise.
 */
export const SKY_SWIRLS: readonly (SkyBearing & { radiusDeg: number; twistRad: number })[] = [
  { azimuthDeg: 10, elevationDeg: 12, radiusDeg: 34, twistRad: 2.2 },
  { azimuthDeg: 98, elevationDeg: -4, radiusDeg: 36, twistRad: -3.2 },
  { azimuthDeg: 188, elevationDeg: 14, radiusDeg: 30, twistRad: 2.8 },
  { azimuthDeg: 276, elevationDeg: -10, radiusDeg: 32, twistRad: -2.4 },
];

/**
 * The four spiral galaxies — the landmarks. Each is an inclined disc with
 * logarithmic spiral arms at a fixed bearing, tinted by the cardinal hue it
 * sits in, so each is nameable by colour and shape:
 *
 *     the amber one    +X side, above the horizon, a broad two-armed spiral
 *     the magenta one  +Z side, below the horizon, tighter, three arms
 *     the blue one     -X side, high, moderately inclined, two open arms
 *     the teal one     -Z side, low, almost edge-on with a dust lane
 *
 * Bearings are 30-38° off the horizontal axes in azimuth and 14-20° above or
 * below the horizon, so that looking exactly along +X / +Z / -X / -Z puts one
 * galaxy WHOLE in the frame (the 70° x 102° view at 16:9 reaches ±35°
 * vertically and ±51° horizontally; a galaxy at 20° elevation and 38° off
 * axis projects to ~0.66 of the half-height, leaving room for its ~9° bright
 * radius — at 28° it projected to 0.92 and was cut by the top edge) without
 * it sitting on the crosshair; the zenith view has the band and the nadir has
 * nothing, on purpose. Each also sits ~30° from its cardinal's swirl centre,
 * where the vortex's lobe has faded (the blue one was swallowed at ~24°), and
 * the shader clears the nebula in a ~20° pocket around each so the galaxy is
 * seen against dark sky rather than dissolving into the glow. Not seeded.
 *
 * `scaleDeg` is the disc's exponential scale length in degrees of sky. The
 * part bright enough to read runs to ~2 scale lengths, so these are 16-20°
 * across — 250-300 px at 1600 px wide, big enough that the arms read as
 * arms (the first pass used 2.1-2.6°: 50 px smudges with a bright dot in
 * them); the outer haze is windowed to nothing by 6 scale lengths (the
 * shader's `GALAXY_EDGE_R`), which is the disc's edge. `axisRatio` is the
 * apparent minor/major axis (1 face-on, 0.25 nearly edge-on; the blue one
 * was 0.82 and read as a round fuzzy blob — a spiral needs some tilt to be
 * seen as a disc), `rollDeg` the position angle of the major axis, `arms`
 * the arm count and `winding` the log-spiral pitch (arms turn `winding /
 * arms` radians per e-fold of radius; the sign is the spin direction).
 */
export const SKY_GALAXIES: readonly (SkyBearing & {
  scaleDeg: number;
  axisRatio: number;
  rollDeg: number;
  arms: number;
  winding: number;
})[] = [
  { azimuthDeg: 32, elevationDeg: 18, scaleDeg: 5.0, axisRatio: 0.62, rollDeg: 25, arms: 2, winding: 3.4 },
  { azimuthDeg: 120, elevationDeg: -14, scaleDeg: 4.0, axisRatio: 0.48, rollDeg: -40, arms: 3, winding: -4.2 },
  { azimuthDeg: 218, elevationDeg: 20, scaleDeg: 4.6, axisRatio: 0.7, rollDeg: 60, arms: 2, winding: 3.0 },
  { azimuthDeg: 306, elevationDeg: -19, scaleDeg: 4.6, axisRatio: 0.3, rollDeg: 15, arms: 2, winding: -3.6 },
];

/**
 * Cubemap face size in pixels. 512 per 90° face is ~5.7 texels per degree;
 * a 1600 px-wide 70° view magnifies that ~4x, which is invisible on fBm this
 * soft — the finest nebula octave the shader evaluates is ~1.5 cycles per
 * degree, still 4 texels per cycle — and there are no hard edges anywhere in
 * the sky to reveal it. The galaxies' arm clumping runs finer (~2 cycles per
 * degree, ~3 texels), which is why the arms look soft rather than crisp; a
 * galaxy core is a Gaussian ~1° across, 6 texels, and stays round. 1024 would
 * cost 4x the VRAM (24 MiB vs 6 MiB for six RGBA8 faces) for a texture that
 * is only ever looked up.
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
 * corner-to-corner diagonal ~5.4s -> ~11s. That is a journey, not dead time.
 * (At the time the R2 ring kept two-thirds of an axis streamed in around you
 * the whole way; since Phase 8 the textured ring is deliberately small and the
 * rest of the trip is flat proxy voxels resolving into thumbnails as you
 * arrive — see `RING_R0_CHUNKS`.)
 *
 * Fallback for the synthetic world. Real datasets override this in Settings
 * with voxel-relative speed: default 8 cells/s (1.5625 world units/s at 512³).
 * Double-tap-and-hold W remains the explicit opt-in sprint gesture.
 */
export const FLIGHT_SPEED = 2;

/** Vertical (Space/Shift, or the legacy E/Q) speed, world units / second.
 * Matched to `FLIGHT_SPEED` on purpose: with vertical bound to the same hand
 * position as in Minecraft creative, a slower climb than cruise reads as the
 * controls sticking rather than as a deliberate axis difference. Halved with
 * it ("half as fast in all directions"). */
export const FLIGHT_VERTICAL_SPEED = 2;

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
 * world now spans 100 units per axis / 173 on the diagonal (and every occupied
 * voxel of it is drawn, as a proxy if not a thumbnail — see "Voxel proxies"),
 * so 500 was no longer the comfortable ~6x margin it used to be — and the
 * starfield shell below deliberately sits far outside the play area, which
 * needs the depth range to reach it from anywhere a player is likely to be
 * (`STARFIELD_RADIUS_WORLD_SCALES * WORLD_SCALE` plus the distance they've
 * strayed from the origin).
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
 * before a candidate extraction hold is abandoned and reinterpreted as a
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
 * button is down, extracting one tool-sized batch per cycle, so a voxel
 * drains continuously rather than popping.
 */
export const EXTRACTION_CYCLE_MS = 267;

/**
 * How many points one extraction cycle pulls out of a voxel. Empty hand keeps
 * the deliberately human-scale, one-image-at-a-time interaction; Pickaxe is
 * the bulk tool and takes up to 100. The return value is capped to the voxel's
 * total so callers can use it directly for progress prediction on tiny
 * voxels; `MiningController` independently stops at the number still present.
 */
export const EMPTY_HAND_EXTRACTION_BATCH_SIZE = 1;
export const PICKAXE_EXTRACTION_BATCH_SIZE = 100;

export function extractionBatchSize(totalPoints: number, pickaxeEquipped: boolean): number {
  const requested = pickaxeEquipped
    ? PICKAXE_EXTRACTION_BATCH_SIZE
    : EMPTY_HAND_EXTRACTION_BATCH_SIZE;
  return Math.min(Math.max(0, Math.floor(totalPoints)), requested);
}

/**
 * Opacity a FULLY drained voxel renders at. A partially drained one sits at
 * `lerp(1, EXTRACTION_FLOOR_OPACITY, extractedFraction)` — see
 * `combinedVoxelOpacity()` in `voxels/VoxelOpacity.ts`.
 *
 * A fully drained voxel is also PASS-THROUGH to the cursor (the raycaster
 * skips it and lands on whatever is behind — `engine/Raycast.ts`), so this is
 * purely how the ghost looks; nothing can be armed on it. Points go back only
 * from the inventory panel (per point or per stack).
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
 * IDENTICALLY to an untouched one whenever X-ray glass view is active — silently
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
// Lightbox — full-resolution originals
// ---------------------------------------------------------------------------
//
// The thumbnails on this machine top out at 256 px, and until now "view
// bigger" in the lightbox honestly meant "the same 256 px file, larger on
// screen". The pipeline now ships a per-row lookup (`point_meta.bin`, served
// as `GET /meta/<points_id>/<row_id>` → `{url, width, height}`) that says
// where each thumbnail's ORIGINAL lives on the open web — BL's full-resolution
// Flickr scans, MONET's crawl-source images — so the lightbox shows the local
// thumbnail at once and then, if the row has one, fetches the original behind
// it and swaps it in. Everything about that fetch is best-effort: the URLs
// were crawled years ago (spot checks put ~1/3 of MONET's dead), some hosts
// refuse hotlinks, and a quarter of a million MONET rows are synthetic images
// for which no larger version exists anywhere. The knobs below shape that.

/**
 * Base path of the per-row original-image lookup, proxied same-origin like
 * `/chunks`, `/thumbs` and `/minimap` (see `vite.config.ts`, and the Private
 * Network Access reasoning at the top of this file). `resolvePointMetaUrl`
 * builds the full URL: `/meta/<DatasetConfig.pointsId>/<row_id>`.
 */
export const META_BASE_PATH = "/meta";

/**
 * How long the lightbox waits for an original to arrive before giving up on
 * it and declaring the link dead, ms. The failure modes are slow ones — a
 * host that accepts the connection and never answers, a CDN edge returning
 * 522 after its own upstream timeout — and a browser image load has no
 * timeout of its own, so without this a dead link would leave "loading
 * original …" up forever. 15 s is long enough for a multi-megabyte Flickr
 * `_o` scan on a slow link (the BL originals run to several thousand px on
 * a side) and short enough that a dead host resolves within the time it
 * takes to look at the thumbnail. A timed-out row is remembered as
 * unavailable for the session; paging back to it does not retry.
 */
export const LIGHTBOX_ORIGINAL_TIMEOUT_MS = 15_000;

/**
 * How much of the viewport an original may fill, as fractions of the window's
 * width and height. The thumbnail keeps its 256 px box; a loaded original
 * grows the lightbox to show it at up to this size (never past its own
 * native pixels — a 700 px MONET crawl image is shown at 700 px, not
 * stretched). 0.9 / 0.78 leaves room for the frame's chrome, the status and
 * caption lines under the image, and a margin of scrim on every side so the
 * modal still reads as a modal rather than a full-screen takeover.
 */
export const LIGHTBOX_ORIGINAL_MAX_VIEWPORT_FRAC: readonly [number, number] = [0.9, 0.78];

/**
 * Cross-fade from the thumbnail to the original once it has loaded, ms. The
 * two images share a box and an aspect ratio, so the fade reads as the
 * picture coming into focus rather than as a cut; long enough to register,
 * short enough not to feel like waiting on an animation. A cached original
 * (paging back to a row already seen this session) skips it and appears at
 * once.
 */
export const LIGHTBOX_ORIGINAL_CROSSFADE_MS = 220;

/** Decoded originals are budgeted by their RGBA pixel footprint, not merely
 * by row count. Oversized single images are shown but never retained. */
export const LIGHTBOX_ORIGINAL_CACHE_MAX_BYTES = 128 * 1024 * 1024;
export const LIGHTBOX_ORIGINAL_CACHE_MAX_ROWS = 12;

/** Definitive `/meta` answers are small, but their URLs can still accumulate
 * indefinitely during a long carousel session. */
export const POINT_META_CACHE_MAX_ROWS = 4096;

/**
 * Subset-name prefix that marks a row as a generated (synthetic) image —
 * MONET's `synthetic-flux-klein`, `synthetic-flux-schnell`, `synthetic-
 * z-image`. Such rows have `url: null` in `/meta` for a different reason
 * than a BL cover does: there is no original to have lost — the image was
 * generated at the dataset's own thumbnail size and the local thumbnail is
 * the largest copy that exists — and the lightbox says so instead of
 * implying an original might exist somewhere else.
 */
export const SYNTHETIC_SUBSET_PREFIX = "synthetic-";

/**
 * Longest side, in px, of the largest copy that exists of a synthetic MONET
 * image — the HuggingFace Hub's own thumbnail size for `jasperai/monet`. The
 * local packs carry 256 px thumbnails (the atlas/inventory size), so this is
 * what the lightbox quotes for a synthetic row rather than the local size:
 * "384 px is the largest available" is a statement about the world, not
 * about this machine. `/meta`'s `width`/`height` for these rows report the
 * generator's 1024x1024 and must not be shown as a size anything can be
 * fetched at.
 */
export const SYNTHETIC_MAX_THUMB_PX = 384;

// ---------------------------------------------------------------------------
// Hotbar / equippable tools (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Opacity all resident voxels render at while X-ray glass view is active
 * (1 = fully opaque, matching a normal untouched voxel). Combined
 * with a voxel's own extraction-derived opacity via `combinedVoxelOpacity()`
 * (`voxels/VoxelOpacity.ts`) using min(), not product — see that function's
 * doc comment for why. Tuned by eye the same way the extraction floor was: high
 * enough that a glass-view cluster still reads as "made of voxels" rather than
 * a formless haze, low enough that whatever is behind the front layer is
 * actually visible through it.
 */
export const XRAY_OPACITY = 0.4;

/**
 * Always-on Effector Field sizing — expressed as multiples of the manifest's
 * own voxel/chunk world sizes (resolved once, at `EffectorFieldController`
 * construction, when the manifest is known) rather than fixed world units,
 * so the field is sized sensibly whether the active dataset is
 * num_voxels=96 or num_voxels=160.
 *
 * The field is CENTERED ON THE CAMERA ("the effector field should be centered
 * on the camera so the field just goes outwards"): it's a bubble around you,
 * not a probe held out in front. There is no standoff/distance control any
 * more — flying moves the bubble, and scrolling over the world changes its
 * radius. Expressed in voxels so it scales with the pack's resolution (a
 * voxel is the natural unit of "one thing in the way"); the max is in chunks
 * for the same reason the streaming rings are.
 */
export const EFFECTOR_DEFAULT_RADIUS_VOXELS = 2;
export const EFFECTOR_MIN_RADIUS_VOXELS = 1;
export const EFFECTOR_MAX_RADIUS_CHUNKS = 3;
/** Radius change for 100 CSS-pixel-equivalent units of wheel travel. This
 * keeps mouse-wheel notches deliberate while letting a trackpad resize the
 * field smoothly. */
export const EFFECTOR_RADIUS_STEP_VOXELS = 0.25;

/** How far (world units) the field's computed sphere center has to move
 * before its suppression set is recomputed — mirrors
 * `CHUNK_UPDATE_MOVE_EPSILON`'s "don't redo O(instances) work every single
 * frame when nothing meaningfully changed" role, just sized to a fraction of
 * a voxel instead of a fraction of a chunk, since this test is per-voxel. */
export const EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC = 0.25;

/** Cyan surface particles briefly reveal the boundary when scrolling. */
export const EFFECTOR_DOT_COLOR = 0x66d9e8;

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

/** Caps on one flashlight query: how many row_ids the spatial index collects,
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
// Minimap hover-look
// ---------------------------------------------------------------------------
//
// Hovering the 2D map TURNS the camera toward the voxel a click would fly to
// — yaw and pitch only, no translation (see `MinimapBridge` and
// `FlightControls.lookTransitionTo`). This replaces Phase 6.9's hover-pan,
// which flew the camera there after a 350 ms linger, on direct feedback: "i
// dont like that hovering on the umap teleports, i just want it to rotate the
// camera towards where it would teleport, and it should happen faster, it
// seems delayed, i just want the debounce to be if you hover many it wont
// spastically rotate but it will catch up as the transition ends."
//
// So the debounce is not a linger before anything happens; it is coalescing.
// A turn starts almost at once, a hover that arrives while a turn is in
// progress does NOT restart it but is remembered, and when the turn ends the
// camera turns to the latest remembered position — a rapid sweep across the
// map is one turn after another, each ending where the cursor was when the
// previous one finished. Click still teleports, unchanged. The flashlight is
// untouched; the look is layered on top of it.

/**
 * Duration of one hover-look turn, ms, eased in and out. Long enough that a
 * 90° swing reads as the camera turning rather than cutting, short enough
 * that the sweep-coalescing above catches up with the cursor within a couple
 * of turns. 350 is also the old linger debounce: what used to be waiting is
 * now the motion itself.
 */
export const MINIMAP_HOVER_LOOK_MS = 350;

/**
 * How long after the cursor enters (or, from idle, moves on) the map before
 * the first turn starts, ms — the latest hover position at that moment is the
 * one turned to. NOT a restart-on-every-move debounce: a continuous sweep
 * would then never turn at all. It exists only so that the first few
 * pointermoves of a sweep, ~8-16 ms apart, don't each start a turn toward a
 * spot the cursor has already left; at 60 ms it is well under anything that
 * reads as delay (the pan's 350 ms linger did). While a turn is in progress
 * this does not apply — the next turn starts the moment the current one ends.
 */
export const MINIMAP_HOVER_LOOK_SETTLE_MS = 60;

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
  // the configured data server. This avoids the browser ever making a
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
  const origin = import.meta.env.VITE_THUMBS_ORIGIN !== undefined
    ? import.meta.env.VITE_THUMBS_ORIGIN.replace(/\/$/, "") : CHUNK_SERVER_ORIGIN ?? "";
  return `${origin}${dataset?.thumbsBasePath ?? THUMBS_BASE_PATH}`;
}

/**
 * The points-table id a dataset key's `/meta` lookups go to
 * (`DatasetConfig.pointsId`), or `null` for an unknown key — callers treat
 * that as "no original-image lookup for this dataset" rather than failing.
 */
export function resolvePointsId(datasetKey: string): string | null {
  return DATASETS[datasetKey]?.pointsId ?? null;
}

/**
 * URL of one row's original-image record: `/meta/<points_id>/<row_id>`.
 * Same same-origin/Vite-proxy reasoning as `resolveDatasetBaseUrl` (see
 * `vite.config.ts`'s `/meta` route); `pointsId` is `DatasetConfig.pointsId`,
 * never the chunk-pack key.
 */
export function resolvePointMetaUrl(pointsId: string, rowId: number): string {
  const origin = CHUNK_SERVER_ORIGIN ?? "";
  return `${origin}${META_BASE_PATH}/${encodeURIComponent(pointsId)}/${rowId}`;
}
