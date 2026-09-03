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
}

export const DATASETS: Record<string, DatasetConfig> = {
  bl: { path: "/chunks/bl", label: "BL · num_voxels=96" },
  "bl-160": { path: "/chunks/bl-160", label: "BL · num_voxels=160" },
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

/** Camera flight speed, world units / second. */
export const FLIGHT_SPEED = 12;

/** Shift-boost multiplier applied to FLIGHT_SPEED. */
export const FLIGHT_BOOST_MULTIPLIER = 4;

/** Vertical (Q/E) speed, world units / second. */
export const FLIGHT_VERTICAL_SPEED = 12;

/** Camera near/far planes and FOV. */
export const CAMERA_FOV_DEG = 70;
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = 500;

/** Raycast max distance from the camera, world units. */
export const RAYCAST_MAX_DISTANCE = 200;

// ---------------------------------------------------------------------------
// Mining / inventory (Phase 3)
// ---------------------------------------------------------------------------

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
