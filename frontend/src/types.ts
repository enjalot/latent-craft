/**
 * TypeScript mirror of the pipeline↔frontend byte/JSON contract described in
 * the project plan's Phase 4 section and implemented by
 * `pipeline/src/lsvoxel/chunkpack/{manifest,metablob,proxy,voxel_proxy}.py`.
 *
 * Nothing here is inferred at runtime — if the pipeline changes a layout, this
 * file and the parsers in `streaming/` must change with it.
 */

export interface ManifestFrame {
  /** Normalized world extent, always `[-1,1]` per axis after cubify. */
  extent: [number, number, number, number, number, number];
  /** The pre-normalization UMAP-space extent this frame was fit to. */
  raw_extent: [number, number, number, number, number, number];
  method: string;
  extent_pct: [number, number];
  pad_frac: number;
}

export interface ManifestWorld {
  /** Voxel bins per axis across the whole world. */
  num_voxels: number;
  /** Voxels per axis within one chunk (16 → 4096 voxels/chunk). */
  voxels_per_chunk: number;
  /** Chunk slots per axis (`num_voxels / voxels_per_chunk`). */
  chunks_per_axis: number;
  frame: ManifestFrame;
}

export interface ManifestAtlas {
  /** Maximum atlas dimensions. Compact packs choose a smaller size per chunk. */
  size_px: number;
  tile_px: number;
  tiles_per_side: number;
  format: string;
  alpha: boolean;
  /** Missing on legacy packs, whose tile index is local_voxel_id. */
  layout?: "compact-occupied-v1";
}

export interface ManifestBlobRef {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ManifestChunk {
  chunk_id: number;
  cx: number;
  cy: number;
  cz: number;
  /** Chunk bounds in the normalized `[-1,1]^3` frame. */
  bbox: [number, number, number, number, number, number];
  n_occupied_voxels: number;
  n_points: number;
  /** Present for compact atlases; absent on legacy fixed-size packs. */
  atlas_size_px?: number;
  atlas_tiles_per_side?: number;
  atlas_path: string;
  atlas_bytes: number;
  atlas_sha256: string;
  meta_path: string;
  meta_bytes: number;
  meta_sha256: string;
}

export interface ManifestJson {
  format_version: number;
  dataset_id: string;
  built_at: string;
  world: ManifestWorld;
  atlas: ManifestAtlas;
  point_source: { points_table: string; umap_run: string; n_points: number };
  subsets: Record<string, number>;
  thumb_url_template: string;
  /** The chunk-level `proxy.bin` (one record per chunk slot). Still written
   * by the pipeline; the frontend no longer reads it — the per-voxel
   * `voxel_proxy` below superseded it as the far-LOD layer. */
  proxy: ManifestBlobRef;
  point_index: ManifestBlobRef;
  row_to_voxel: ManifestBlobRef;
  /** Whole-dataset `voxel_proxy.bin` — see `streaming/VoxelProxy.ts`.
   * `n_voxels` is the record count, which must equal the sum of
   * `n_occupied_voxels` over `chunks`. */
  voxel_proxy: ManifestBlobRef & { n_voxels: number };
  /** ONLY occupied chunks appear here — empty slots are omitted entirely. */
  chunks: ManifestChunk[];
}

/**
 * One chunk's decoded `meta.bin`. The VoxelRecord table is always dense
 * (`voxels_per_chunk^3` entries, array index == local_voxel_id), so these are
 * parallel typed arrays rather than an array of objects — 4096 objects per
 * chunk would be pure allocation churn during streaming.
 */
export interface ChunkMeta {
  chunkId: number;
  voxelGridN: number;
  atlasTilePx: number;
  /** count[localVoxelId]; 0 == empty voxel, no atlas tile. */
  count: Uint16Array;
  /** Index into `pointIds` (in elements) where this voxel's points start. */
  pointOffset: Uint32Array;
  /** Mean tile color, 3 bytes per voxel (RGB), for the cheap tinted-cube fallback. */
  colorRgb: Uint8Array;
  /** bit0 = has_atlas_tile. */
  flags: Uint8Array;
  /** 0xFFFFFFFF for empty voxels. */
  reprRowId: Uint32Array;
  /** Flattened, grouped by localVoxelId ascending. */
  pointIds: Uint32Array;
  /** Local voxel ids with `count > 0`, ascending — the instances we render. */
  occupied: Uint32Array;
}

/**
 * Decoded `voxel_proxy.bin`: one record per OCCUPIED voxel of the whole
 * dataset, sorted by `(chunk_id, local_voxel_id)` so every chunk's records
 * form one contiguous run — `runStart[chunkId] .. runEnd[chunkId]` (a half-open
 * range; `runStart` is -1 for a chunk slot with no records). Because a chunk's
 * `meta.occupied` list is that same ascending order, the i-th record of a run
 * is instance i of that chunk's textured mesh.
 *
 * Parallel typed arrays, index == record index, for the same reason
 * `ChunkMeta` uses them.
 */
export interface VoxelProxyData {
  /** World grid per axis (`manifest.world.num_voxels`). */
  numVoxels: number;
  /** Voxels per chunk axis (`manifest.world.voxels_per_chunk`). */
  voxelsPerChunk: number;
  chunkId: Uint32Array;
  localVoxelId: Uint16Array;
  /** Points in the voxel; pack construction rejects counts above uint16. */
  count: Uint16Array;
  /** Mean thumbnail color, 3 sRGB bytes per record. */
  colorRgb: Uint8Array;
  /** bit0 = has_atlas_tile, as in `ChunkMeta.flags`. */
  flags: Uint8Array;
  /** First record index of each chunk slot's run, or -1; sized to the full
   * `chunks_per_axis^3` grid so a bare chunk_id indexes it directly. */
  runStart: Int32Array;
  /** One past the last record index of each chunk slot's run (0 where there
   * is no run). */
  runEnd: Int32Array;
}

export const FLAG_HAS_ATLAS_TILE = 1 << 0;
export const EMPTY_REPR_ROW_ID = 0xffffffff;

// ---------------------------------------------------------------------------
// 2D minimap pack (Phase 5) — `pipeline/src/lsvoxel/minimap/build.py`
//
// A SEPARATE pack from the chunk pack above, built from a SEPARATE
// (independent, 2-component) UMAP fit of the same points table. The only
// field the two contracts share is `row_id`; nothing about the 2D frame,
// extent, or quantization has any geometric relationship to the 3D
// `[-1,1]^3` world frame. See `minimap/Manifest.ts`.
// ---------------------------------------------------------------------------

export interface MinimapTileLevel {
  z: number;
  tiles_per_side: number;
  bins_per_side: number;
  tiles_written: number;
  planes_written: number;
  png_log_peak: number;
  total_count: number;
}

export interface MinimapManifestJson {
  pack_format_version: string;
  dataset_id: string;
  built_at: string;
  n_points: number;
  /** corpus code (as a string key) → name. For BL these are the subsets. */
  corpus_codes: Record<string, string>;
  corpus_counts: Record<string, number>;
  frame: {
    /** `[x0, x1, y0, y1]` in the 2D fit's own raw UMAP units. */
    extent: [number, number, number, number];
    raw_extent: [number, number, number, number];
    squared: boolean;
  };
  quantization: { levels: number; bits: number; formula: string };
  tiles: {
    tile_bins: number;
    max_zoom: number;
    levels: MinimapTileLevel[];
  };
  points: { record_bytes: number; n_points: number; packed: string };
}

/** One zoom level's `density/z{z}/index.json` — sparse; empty tiles absent. */
export interface MinimapDensityIndexJson {
  z: number;
  tiles_per_side: number;
  bin_bytes: number;
  png_log_peak: number;
  /** Keyed `"{tx}_{ty}"`. */
  tiles: Record<string, { n: number; corpora: number[] }>;
}
