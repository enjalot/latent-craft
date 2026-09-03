/**
 * TypeScript mirror of the pipeline↔frontend byte/JSON contract described in
 * the project plan's Phase 4 section and implemented by
 * `pipeline/src/lsvoxel/chunkpack/{manifest,metablob,proxy}.py`.
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
  size_px: number;
  tile_px: number;
  tiles_per_side: number;
  format: string;
  alpha: boolean;
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
  proxy: ManifestBlobRef;
  point_index: ManifestBlobRef;
  row_to_voxel: ManifestBlobRef;
  /** ONLY occupied chunks appear here — empty slots are omitted entirely
   * (they are still present, zeroed, in the dense `proxy.bin`). */
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
 * Decoded `proxy.bin`. Dense over the FULL `chunks_per_axis^3` grid including
 * empty slots, indexed by chunk_id.
 */
export interface ProxyData {
  chunksPerAxis: number;
  /** 3 bytes per chunk slot. */
  colorRgb: Uint8Array;
  densityLog2: Uint8Array;
  nPoints: Uint32Array;
  nOccupiedVoxels: Uint16Array;
}

export const FLAG_HAS_ATLAS_TILE = 1 << 0;
export const EMPTY_REPR_ROW_ID = 0xffffffff;
