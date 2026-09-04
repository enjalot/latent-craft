import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import { createVoxelMaterial, initVoxelUniforms } from "../voxels/VoxelMaterial.ts";
import type { AtlasCache } from "../voxels/AtlasCache.ts";
import type { Manifest } from "./Manifest.ts";
import type { ChunkMeta, ManifestChunk } from "../types.ts";
import { VOXEL_FILL } from "../config.ts";

const META_MAGIC = "LSV1";
const META_HEADER_BYTES = 32;
const VOXEL_RECORD_BYTES = 16;

/**
 * Decodes one chunk's `meta.bin`.
 *
 * Layout (little-endian throughout — `DataView` defaults to big-endian, so
 * every read below passes `true` explicitly):
 *
 *   header 32B: magic "LSV1" | version u16 | chunk_id u32 | n_voxel_records u32
 *               | n_points u32 | voxel_grid_n u16 | atlas_tile_px u16 | 10B reserved
 *   VoxelRecord[n_voxel_records], 16B each, index == local_voxel_id:
 *               count u16 | point_offset u32 | color_rgb u8[3] | flags u8
 *               | repr_row_id u32 | reserved u16
 *   point_ids: u32[n_points]
 *
 * The record table is always fully dense (4096 entries, empties zeroed), which
 * is why `total = 32 + 4096*16 + n_points*4` and why the array index alone
 * identifies a voxel — no id field is stored.
 */
export function parseChunkMeta(buffer: ArrayBuffer): ChunkMeta {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== META_MAGIC) throw new Error(`meta.bin: bad magic ${JSON.stringify(magic)}`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`meta.bin: unsupported version ${version}`);

  const chunkId = view.getUint32(6, true);
  const nVoxelRecords = view.getUint32(10, true);
  const nPoints = view.getUint32(14, true);
  const voxelGridN = view.getUint16(18, true);
  const atlasTilePx = view.getUint16(20, true);

  const expectedBytes = META_HEADER_BYTES + nVoxelRecords * VOXEL_RECORD_BYTES + nPoints * 4;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `meta.bin (chunk ${chunkId}): size mismatch — got ${buffer.byteLength}B, header implies ${expectedBytes}B`,
    );
  }

  const count = new Uint16Array(nVoxelRecords);
  const pointOffset = new Uint32Array(nVoxelRecords);
  const colorRgb = new Uint8Array(nVoxelRecords * 3);
  const flags = new Uint8Array(nVoxelRecords);
  const reprRowId = new Uint32Array(nVoxelRecords);

  let nOccupied = 0;
  for (let i = 0; i < nVoxelRecords; i++) {
    const base = META_HEADER_BYTES + i * VOXEL_RECORD_BYTES;
    const c = view.getUint16(base, true);
    count[i] = c;
    if (c === 0) continue; // empty slot: every other field is zero/sentinel
    nOccupied++;
    pointOffset[i] = view.getUint32(base + 2, true);
    colorRgb[i * 3] = view.getUint8(base + 6);
    colorRgb[i * 3 + 1] = view.getUint8(base + 7);
    colorRgb[i * 3 + 2] = view.getUint8(base + 8);
    flags[i] = view.getUint8(base + 9);
    reprRowId[i] = view.getUint32(base + 10, true);
  }

  const occupied = new Uint32Array(nOccupied);
  for (let i = 0, w = 0; i < nVoxelRecords; i++) {
    if (count[i] > 0) occupied[w++] = i;
  }

  // `point_ids` is 4-byte aligned inside the file (32 + 4096*16 is a multiple
  // of 4), so a zero-copy typed-array view over the same buffer is safe.
  const pointIds = new Uint32Array(
    buffer,
    META_HEADER_BYTES + nVoxelRecords * VOXEL_RECORD_BYTES,
    nPoints,
  );

  return { chunkId, voxelGridN, atlasTilePx, count, pointOffset, colorRgb, flags, reprRowId, pointIds, occupied };
}

/** A chunk that has finished loading and is in the scene. */
export interface LoadedChunk {
  entry: ManifestChunk;
  meta: ChunkMeta;
  mesh: InstancedMesh2;
  atlasUrl: string;
  /** Rough resident-VRAM cost, used by the eviction budget. */
  bytes: number;
  /** `localVoxelId` for each instance id, so a raycast hit resolves back to
   * the data model (needed from Phase 3's mining onward). */
  instanceToLocalVoxelId: Uint32Array;
}

/** Extra fields hung off the chunk mesh so a raycast hit can identify itself
 * without a side lookup table. */
export interface ChunkMeshUserData {
  chunkId: number;
  chunkEntry: ManifestChunk;
  instanceToLocalVoxelId: Uint32Array;
}

/**
 * Fetches one chunk's `meta.bin` + `atlas.ktx2` and turns them into a single
 * `InstancedMesh2` with one instance per occupied voxel.
 *
 * One mesh per chunk (rather than a shared instance pool) is deliberate: a
 * chunk is exactly the unit the data contract, the atlas, and eviction all
 * work in, so load becomes "build a mesh", evict becomes "dispose it", and the
 * BVH rebuild stays per-chunk-sized.
 */
export class ChunkLoader {
  /**
   * Template box, cloned per chunk. It CANNOT be shared directly: an
   * `InstancedMesh2`'s constructor does `geometry.setAttribute("instanceIndex",
   * <its own GL buffer>)` on whatever geometry it is handed, so two meshes
   * sharing one geometry would both end up drawing through the *last*
   * constructed mesh's index buffer (the library's clone-and-warn guard only
   * fires on the `mesh.geometry = …` setter, not on construction). Cloning is
   * cheap — a unit box is 24 vertices.
   */
  private readonly geometryTemplate = new THREE.BoxGeometry(1, 1, 1);
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly manifest: Manifest,
    private readonly atlasCache: AtlasCache,
    private readonly renderer: THREE.WebGLRenderer,
  ) {}

  async load(entry: ManifestChunk, signal?: AbortSignal): Promise<LoadedChunk> {
    const metaUrl = this.manifest.url(entry.meta_path);
    const atlasUrl = this.manifest.url(entry.atlas_path);

    const [metaBuffer, atlas] = await Promise.all([
      fetchArrayBuffer(metaUrl, signal),
      this.atlasCache.acquire(atlasUrl, signal),
    ]);

    const meta = parseChunkMeta(metaBuffer);
    if (meta.chunkId !== entry.chunk_id) {
      this.atlasCache.release(atlasUrl);
      throw new Error(`chunk ${entry.chunk_id}: meta.bin reports chunk_id ${meta.chunkId}`);
    }

    const material = createVoxelMaterial({
      atlas,
      tilesPerSide: this.manifest.tilesPerSide,
      tilePx: this.manifest.tilePx,
    });

    const instanceCount = meta.occupied.length;
    const mesh = new InstancedMesh2(this.geometryTemplate.clone(), material, {
      capacity: Math.max(1, instanceCount),
      renderer: this.renderer,
    });
    // Must precede any setUniform call — it allocates the uniform texture at
    // the mesh's capacity.
    initVoxelUniforms(mesh);

    const scale = this.manifest.voxelWorldSize * VOXEL_FILL;
    const { cx, cy, cz } = entry;
    mesh.addInstances(instanceCount, (instance, index) => {
      const localVoxelId = meta.occupied[index];
      this.manifest.voxelCenterWorld(cx, cy, cz, localVoxelId, this.scratch);
      instance.position.copy(this.scratch);
      instance.scale.setScalar(scale);
      // local_voxel_id IS the atlas tile index (16^3 == 64^2).
      instance.setUniform("tileIndex", localVoxelId);
    });

    // Instances are static for the life of the chunk, so one BVH build at load
    // time is the intended usage — this is what makes per-frame raycasting
    // against every resident chunk cheap.
    mesh.computeBVH();

    const userData: ChunkMeshUserData = {
      chunkId: entry.chunk_id,
      chunkEntry: entry,
      instanceToLocalVoxelId: meta.occupied,
    };
    mesh.userData = userData;
    mesh.name = `chunk-${entry.chunk_id}`;

    return {
      entry,
      meta,
      mesh,
      atlasUrl,
      bytes: this.atlasCache.byteSize(atlasUrl, entry.atlas_bytes) + entry.meta_bytes,
      instanceToLocalVoxelId: meta.occupied,
    };
  }

  /** Tears down a loaded chunk's GPU resources and drops its atlas reference. */
  unload(chunk: LoadedChunk): void {
    chunk.mesh.removeFromParent();
    chunk.mesh.dispose();
    chunk.mesh.geometry.dispose();
    (chunk.mesh.material as THREE.Material).dispose();
    this.atlasCache.release(chunk.atlasUrl);
  }

  dispose(): void {
    this.geometryTemplate.dispose();
  }
}
