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
}

export const DATASETS: Record<string, DatasetConfig> = {
  bl: { path: "/chunks/bl", label: "BL · num_voxels=96", minimapPath: "/minimap/bl" },
  "bl-160": { path: "/chunks/bl-160", label: "BL · num_voxels=160", minimapPath: "/minimap/bl" },
};

/** Which entry of `DATASETS` to load when no `?dataset=` param is given. */
export const DEFAULT_DATASET = "bl";

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
 * the full world spans 2 * WORLD_SCALE units per axis. 25 keeps the real data
 * the same physical size as Phase 1's synthetic 50-unit cube, so the flight
 * speeds below still feel right.
 */
export const WORLD_SCALE = 25;

/**
 * Fraction of a voxel cell the rendered cube fills. Slightly under 1 so
 * neighbouring voxels read as separate blocks with a visible seam rather than
 * fusing into one solid mass.
 */
export const VOXEL_FILL = 0.92;

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

/** Opacity of the always-resident coarse proxy cubes. */
export const PROXY_OPACITY = 0.3;
/** Proxy cube edge as a fraction of a chunk edge, at min and max density. */
export const PROXY_MIN_FILL = 0.3;
export const PROXY_MAX_FILL = 0.94;
/** `density_log2` value treated as "fully dense" when scaling proxy cubes. */
export const PROXY_DENSITY_LOG2_MAX = 18;

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
 * Revisit once that scale change lands — the "right" number is coupled to
 * world scale, not an absolute constant.
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

/** Camera near/far planes and FOV. */
export const CAMERA_FOV_DEG = 70;
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 500;

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
// Mining / inventory (Phase 3, extended Phase 3.5)
// ---------------------------------------------------------------------------

/**
 * How long a click-and-hold must be sustained to mine (or restore) a voxel,
 * in milliseconds. Same constant drives both directions — the UX is
 * symmetric, just the opposite visual outcome. Named/exported so it's a
 * one-line retune rather than a hunt through main.ts.
 */
export const MINE_HOLD_DURATION_MS = 1600;

/** Opacity a mined-but-not-yet-restored voxel renders at (1 = fully opaque,
 * matching a normal untouched voxel). Verified by eye against a real
 * screenshot, not just picked from the addendum's suggested 0.25-0.4 range
 * in the abstract: against this scene's near-black void background and dim
 * lighting (most BL book pages are dark ink on paper to begin with — see
 * `main.ts`'s lighting comment), anything in that range reads as
 * indistinguishable from fully gone. 0.55 is the value that actually stayed
 * legible as "translucent, still there" in a headless screenshot. */
export const MINED_OPACITY = 0.55;

/**
 * Base path for full-resolution per-point thumbnails, proxied same-origin
 * exactly like the chunk-pack paths above (see `vite.config.ts`'s
 * `server.proxy["/thumbs"]`). Hardcoded to the `bl` family rather than
 * derived from the active dataset key: both the `bl` and `bl-160`
 * chunk-packs (different voxel resolutions) index the same underlying
 * 1,080,814-point British Library thumbnail set, so there's only one thumbs
 * tree regardless of which chunk-pack is loaded.
 */
export const THUMBS_BASE_PATH = "/thumbs/bl";

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
 * with a mined voxel's own `MINED_OPACITY` via `combinedVoxelOpacity()`
 * (`voxels/VoxelOpacity.ts`) using min(), not product — see that function's
 * doc comment for why. Tuned by eye the same way `MINED_OPACITY` was: high
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
 * Defaults tuned down per user feedback ("too big and too far away to be
 * immediately useful"): radius 5 -> 3 voxels and standoff 1.2 chunks (≈19
 * voxels) -> 8 voxels. At the default camera FOV that puts a sphere spanning
 * roughly half the viewport height right in front of you the moment the item
 * is equipped, so the tool is obviously doing something without the player
 * having to already know the resize/move keys. The standoff is now expressed
 * in VOXELS rather than chunks because at this size a chunk (16 voxels) is far
 * too coarse a unit to express "just in front of your face" in.
 */
export const EFFECTOR_DEFAULT_RADIUS_VOXELS = 3;
export const EFFECTOR_MIN_RADIUS_VOXELS = 1;
export const EFFECTOR_MAX_RADIUS_CHUNKS = 3;
export const EFFECTOR_RADIUS_STEP_VOXELS = 0.75;

export const EFFECTOR_DEFAULT_DISTANCE_VOXELS = 8;
export const EFFECTOR_MIN_DISTANCE_VOXELS = 2;
export const EFFECTOR_MAX_DISTANCE_CHUNKS = 8;
export const EFFECTOR_DISTANCE_STEP_VOXELS = 2;

/** A keypress ([`/`]`/`-`/`=`) moves/resizes by this many wheel-steps' worth
 * at once — a single wheel "notch" (`deltaY` tick) is a much smaller,
 * higher-frequency input than a discrete key tap, so a keypress needs a
 * bigger per-event step to feel comparably responsive rather than glacial. */
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
