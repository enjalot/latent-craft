import * as THREE from "three";
import { fetchJson } from "../net/fetchTyped.ts";
import type { ManifestChunk, ManifestJson } from "../types.ts";

/**
 * The chunk-pack manifest, fetched once at startup, plus every piece of
 * coordinate math derived from it.
 *
 * All positions in the manifest (`bbox`, `frame.extent`) live in the
 * normalized `[-1,1]^3` cube the pipeline already fit the UMAP embedding into
 * — this class is the single place that multiplies by `worldScale` to get
 * world units, so nothing downstream has to remember which space it's in.
 */
export class Manifest {
  readonly raw: ManifestJson;
  readonly baseUrl: string;
  readonly worldScale: number;

  readonly numVoxels: number;
  readonly voxelsPerChunk: number;
  readonly chunksPerAxis: number;
  readonly tilesPerSide: number;
  readonly tilePx: number;

  /** World edge length of one voxel cell. */
  readonly voxelWorldSize: number;
  /** World edge length of one chunk. */
  readonly chunkWorldSize: number;
  /** Occupied chunks, keyed by chunk_id. Empty slots are absent by design. */
  readonly chunksById: Map<number, ManifestChunk>;

  constructor(raw: ManifestJson, baseUrl: string, worldScale: number) {
    if (raw.format_version !== 1) {
      throw new Error(`Unsupported manifest format_version ${raw.format_version} (expected 1)`);
    }
    this.raw = raw;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.worldScale = worldScale;

    this.numVoxels = raw.world.num_voxels;
    this.voxelsPerChunk = raw.world.voxels_per_chunk;
    this.chunksPerAxis = raw.world.chunks_per_axis;
    this.tilesPerSide = raw.atlas.tiles_per_side;
    this.tilePx = raw.atlas.tile_px;

    if (this.voxelsPerChunk ** 3 !== this.tilesPerSide ** 2) {
      // The whole texturing scheme depends on "local_voxel_id IS the tile
      // index" — 16^3 voxels == 64^2 tiles. Fail loudly rather than render
      // silently-wrong thumbnails if a future pack breaks that identity.
      throw new Error(
        `atlas/voxel mismatch: ${this.voxelsPerChunk}^3 voxels per chunk != ${this.tilesPerSide}^2 atlas tiles`,
      );
    }

    this.voxelWorldSize = (2 * worldScale) / this.numVoxels;
    this.chunkWorldSize = (2 * worldScale) / this.chunksPerAxis;

    this.chunksById = new Map();
    for (const chunk of raw.chunks) this.chunksById.set(chunk.chunk_id, chunk);
  }

  get datasetId(): string {
    return this.raw.dataset_id;
  }

  get chunks(): ManifestChunk[] {
    return this.raw.chunks;
  }

  /** Total points across all occupied chunks (== `point_source.n_points`). */
  get totalPoints(): number {
    return this.raw.point_source.n_points;
  }

  /** Absolute URL for a manifest-relative path (`c/000137/atlas.ktx2`, …). */
  url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * World-space center of a chunk slot. Derived from the chunk grid rather
   * than the manifest's `bbox`, so it also works for the empty slots that
   * `proxy.bin` covers but `manifest.chunks` omits.
   */
  chunkCenterWorld(chunkId: number, target: THREE.Vector3): THREE.Vector3 {
    const { cx, cy, cz } = this.chunkGridCoords(chunkId);
    const cell = 2 / this.chunksPerAxis;
    return target.set(
      (-1 + (cx + 0.5) * cell) * this.worldScale,
      (-1 + (cy + 0.5) * cell) * this.worldScale,
      (-1 + (cz + 0.5) * cell) * this.worldScale,
    );
  }

  /**
   * Chunk grid coords for a chunk_id (row-major, x-fastest — the pipeline's
   * own ordering). Occupied chunks also carry these as `cx`/`cy`/`cz` in the
   * manifest, but this works for the empty slots too, and is what lets
   * anything holding only a bare chunk_id (`row_to_voxel.bin`, `proxy.bin`)
   * get to a world position without a manifest lookup.
   */
  chunkGridCoords(chunkId: number): { cx: number; cy: number; cz: number } {
    const n = this.chunksPerAxis;
    return {
      cx: chunkId % n,
      cy: Math.floor(chunkId / n) % n,
      cz: Math.floor(chunkId / (n * n)),
    };
  }

  /**
   * World-space center of one voxel cell, given its chunk grid coords and its
   * `local_voxel_id` (0..voxelsPerChunk^3-1, row-major x-fastest).
   *
   * This reproduces the pipeline's own cell-center formula exactly, so the
   * position returned here is the point the voxel's representative thumbnail
   * was chosen to represent.
   */
  voxelCenterWorld(
    cx: number,
    cy: number,
    cz: number,
    localVoxelId: number,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    const vpc = this.voxelsPerChunk;
    const lx = localVoxelId % vpc;
    const ly = Math.floor(localVoxelId / vpc) % vpc;
    const lz = Math.floor(localVoxelId / (vpc * vpc));

    const vx = cx * vpc + lx;
    const vy = cy * vpc + ly;
    const vz = cz * vpc + lz;

    const cell = 2 / this.numVoxels;
    return target.set(
      (-1 + (vx + 0.5) * cell) * this.worldScale,
      (-1 + (vy + 0.5) * cell) * this.worldScale,
      (-1 + (vz + 0.5) * cell) * this.worldScale,
    );
  }

  /**
   * World-space center of one voxel cell addressed the way
   * `row_to_voxel.bin` addresses it — by `(chunk_id, local_voxel_id)` — so a
   * `row_id` can be turned into a place in the world without the caller
   * re-deriving any of the grid math. Thin wrapper over `voxelCenterWorld`.
   */
  voxelCenterWorldById(
    chunkId: number,
    localVoxelId: number,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    const { cx, cy, cz } = this.chunkGridCoords(chunkId);
    return this.voxelCenterWorld(cx, cy, cz, localVoxelId, target);
  }

  /** The occupied chunk holding the most points — a good place to spawn. */
  densestChunk(): ManifestChunk | null {
    let best: ManifestChunk | null = null;
    for (const chunk of this.raw.chunks) {
      if (!best || chunk.n_points > best.n_points) best = chunk;
    }
    return best;
  }
}

/** Fetches and validates `manifest.json` from a chunk-pack base URL. */
export async function loadManifest(
  baseUrl: string,
  worldScale: number,
  signal?: AbortSignal,
): Promise<Manifest> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const raw = await fetchJson<ManifestJson>(`${normalized}/manifest.json`, signal);
  return new Manifest(raw, normalized, worldScale);
}
