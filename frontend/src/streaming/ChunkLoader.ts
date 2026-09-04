import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import { createVoxelMaterial, initVoxelUniforms } from "../voxels/VoxelMaterial.ts";
import { VoxelContainers } from "../voxels/VoxelContainers.ts";
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
  if (version !== 1 && version !== 2) throw new Error(`meta.bin: unsupported version ${version}`);

  const chunkId = view.getUint32(6, true);
  const nVoxelRecords = view.getUint32(10, true);
  const nPoints = view.getUint32(14, true);
  const voxelGridN = view.getUint16(18, true);
  const atlasTilePx = view.getUint16(20, true);

  const expectedBytes = META_HEADER_BYTES + nVoxelRecords * VOXEL_RECORD_BYTES + (version === 1 ? nPoints * 4 : 0);
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `meta.bin (chunk ${chunkId}): size mismatch — got ${buffer.byteLength}B, header implies ${expectedBytes}B`,
    );
  }

  const count = new Uint32Array(nVoxelRecords);
  const pointOffset = new Uint32Array(nVoxelRecords);
  const colorRgb = new Uint8Array(nVoxelRecords * 3);
  const flags = new Uint8Array(nVoxelRecords);
  const reprRowId = new Uint32Array(nVoxelRecords);

  let nOccupied = 0;
  let postingEnd = 0;
  for (let i = 0; i < nVoxelRecords; i++) {
    const base = META_HEADER_BYTES + i * VOXEL_RECORD_BYTES;
    const c = version === 1 ? view.getUint16(base, true) : view.getUint32(base, true);
    count[i] = c;
    if (c === 0) continue; // empty slot: every other field is zero/sentinel
    nOccupied++;
    pointOffset[i] = view.getUint32(base + (version === 1 ? 2 : 4), true);
    const colorOffset = version === 1 ? 6 : 8;
    for (let k = 0; k < 3; k++) colorRgb[i * 3 + k] = view.getUint8(base + colorOffset + k);
    flags[i] = view.getUint8(base + colorOffset + 3);
    reprRowId[i] = view.getUint32(base + (version === 1 ? 10 : 12), true);
    if (pointOffset[i] + c > nPoints) throw new Error("Invalid voxel posting bounds");
    if (pointOffset[i] !== postingEnd) throw new Error("Non-contiguous voxel postings");
    postingEnd += c;
  }
  if (postingEnd !== nPoints) throw new Error("Voxel counts do not match chunk total");

  const occupied = new Uint32Array(nOccupied);
  for (let i = 0, w = 0; i < nVoxelRecords; i++) {
    if (count[i] > 0) occupied[w++] = i;
  }

  // `point_ids` is 4-byte aligned inside the file (32 + 4096*16 is a multiple
  // of 4), so a zero-copy typed-array view over the same buffer is safe.
  const pointIds = new Uint32Array(
    buffer,
    META_HEADER_BYTES + nVoxelRecords * VOXEL_RECORD_BYTES,
    version === 1 ? nPoints : 0,
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
  /**
   * This chunk's container cages (Phase 6.8), one per voxel, indexed by the
   * SAME instance ids as `mesh` — so anything holding a voxel hit can drive
   * both without a translation table. See `voxels/VoxelContainers.ts`.
   */
  containers: VoxelContainers;
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
    let atlasAcquired = false;
    const atlasPromise = this.atlasCache.acquire(atlasUrl, signal).then((texture) => {
      atlasAcquired = true;
      return texture;
    });
    let mesh: InstancedMesh2 | null = null;
    let material: THREE.Material | null = null;
    let containers: VoxelContainers | null = null;

    try {
      const [metaBuffer, atlas] = await Promise.all([
        fetchArrayBuffer(metaUrl, signal),
        atlasPromise,
      ]);

      const meta = parseChunkMeta(metaBuffer);
      if (meta.chunkId !== entry.chunk_id) {
        throw new Error(`chunk ${entry.chunk_id}: meta.bin reports chunk_id ${meta.chunkId}`);
      }
      let total = 0;
      for (const count of meta.count) total += count;
      if (meta.voxelGridN !== this.manifest.voxelsPerChunk || meta.occupied.length !== entry.n_occupied_voxels || total !== entry.n_points)
        throw new Error(`chunk ${entry.chunk_id}: summary disagrees with manifest`);

      material = createVoxelMaterial({
        atlas,
        tilesPerSide: this.manifest.atlasTilesPerSide(entry),
        tilePx: this.manifest.tilePx,
      });

      const instanceCount = meta.occupied.length;
      mesh = new InstancedMesh2(this.geometryTemplate.clone(), material, {
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
        // Legacy atlases use local_voxel_id directly. Compact atlases pack
        // occupied voxels in this same ascending instance order.
        instance.setUniform("tileIndex", this.manifest.compactAtlases ? index : localVoxelId);
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

      containers = VoxelContainers.build(entry, meta, this.manifest, this.renderer);
      mesh.add(containers.mesh);

      return {
        entry,
        meta,
        mesh,
        atlasUrl,
        bytes: this.atlasCache.byteSize(atlasUrl, entry.atlas_bytes) + entry.meta_bytes,
        instanceToLocalVoxelId: meta.occupied,
        containers,
      };
    } catch (error) {
      containers?.dispose();
      if (mesh) {
        mesh.removeFromParent();
        mesh.dispose();
        mesh.geometry.dispose();
      }
      material?.dispose();
      // Promise.all can reject on meta fetch before the non-abortable KTX2
      // transcode finishes. In that case attach ownership cleanup now; if the
      // atlas is already ours, release it synchronously.
      if (atlasAcquired) this.atlasCache.release(atlasUrl);
      else {
        const cleanup = atlasPromise.then(() => this.atlasCache.release(atlasUrl), () => undefined);
        if (this.manifest.raw.streaming) await cleanup;
        else void cleanup;
      }
      throw error;
    }
  }

  /** Tears down a loaded chunk's GPU resources and drops its atlas reference. */
  unload(chunk: LoadedChunk): void {
    chunk.containers.dispose();
    chunk.mesh.removeFromParent();
    chunk.mesh.dispose();
    chunk.mesh.geometry.dispose();
    (chunk.mesh.material as THREE.Material).dispose();
    this.atlasCache.release(chunk.atlasUrl);
  }

  dispose(): void {
    this.geometryTemplate.dispose();
    this.atlasCache.dispose();
  }
}
