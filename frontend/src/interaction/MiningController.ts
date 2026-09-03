import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { ChunkMeshUserData, LoadedChunk } from "../streaming/ChunkLoader.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { Inventory } from "./Inventory.ts";

function voxelKey(chunkId: number, localVoxelId: number): string {
  return `${chunkId}:${localVoxelId}`;
}

/**
 * Turns a raycast hit into a mined voxel: hides its instance, snapshots its
 * member points into an `Inventory` stack, and remembers the mine so it
 * survives the voxel's chunk being evicted and re-streamed later.
 *
 * Mined state lives here as a plain `Map<chunkId, Set<localVoxelId>>`,
 * independent of any `LoadedChunk` — a chunk's `InstancedMesh2` is disposed
 * on eviction (see `ChunkLoader.unload`) and rebuilt from scratch on reload,
 * so "stay mined" can't be encoded in the mesh itself. `onChunkResident`
 * re-applies this registry's hides every time `ChunkStore` reports a chunk
 * becoming resident (fresh load OR reload), which is what makes flying away
 * and back not "un-mine" anything.
 */
export class MiningController {
  readonly inventory = new Inventory();

  private readonly minedByChunk = new Map<number, Set<number>>();

  constructor(private readonly chunkStore: ChunkStore) {}

  isMined(chunkId: number, localVoxelId: number): boolean {
    return this.minedByChunk.get(chunkId)?.has(localVoxelId) ?? false;
  }

  /**
   * Mines whatever the current raycast hit points at, if anything. Returns
   * `true` iff a voxel was actually mined (so callers — e.g. a click sound
   * or flash later — know whether to react).
   *
   * Silently no-ops for a null hit, a hit against something that isn't a
   * chunk-voxel mesh (the Phase 1 `?synthetic=1` field has no `chunkId` in
   * its userData), or a voxel that's already mined (shouldn't be reachable
   * since `setVisibilityAt(false)` also makes an instance un-raycastable —
   * see the class doc on why that single call is enough — but checked
   * defensively rather than assumed).
   */
  mine(hit: VoxelHit | null): boolean {
    if (!hit) return false;
    const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
    if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return false;

    const chunkId = userData.chunkId;
    const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
    if (localVoxelId === undefined || this.isMined(chunkId, localVoxelId)) return false;

    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return false;

    this.markMined(chunkId, localVoxelId);
    hit.mesh.setVisibilityAt(hit.instanceId, false);
    this.snapshotStack(chunk, localVoxelId);
    return true;
  }

  /**
   * Called (via `ChunkStore`'s `onResidencyChanged` hook) whenever a chunk
   * becomes resident. Re-hides any voxel this session already mined in it.
   *
   * `chunk.meta.occupied[instanceId] === localVoxelId` is the same identity
   * `ChunkLoader.load`'s `addInstances` loop relies on (instance ids are
   * assigned in ascending-`occupied`-index order), so scanning it once
   * inverts instanceId↔localVoxelId without a persistent side table. Only
   * done when this chunk actually has mined voxels to reapply — for the
   * common case (nothing mined here yet) it's a `Map.get` and an early
   * return, not a scan.
   */
  onChunkResident(chunkId: number): void {
    const mined = this.minedByChunk.get(chunkId);
    if (!mined || mined.size === 0) return;
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;

    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      if (mined.has(occupied[instanceId])) {
        chunk.mesh.setVisibilityAt(instanceId, false);
      }
    }
  }

  private markMined(chunkId: number, localVoxelId: number): void {
    let set = this.minedByChunk.get(chunkId);
    if (!set) {
      set = new Set();
      this.minedByChunk.set(chunkId, set);
    }
    set.add(localVoxelId);
  }

  private snapshotStack(chunk: LoadedChunk, localVoxelId: number): void {
    const { meta } = chunk;
    const count = meta.count[localVoxelId];
    const offset = meta.pointOffset[localVoxelId];
    // .slice() copies rather than views: `meta.pointIds` backs the WHOLE
    // chunk's point list (up to ~167K for a dense BL chunk) off one shared
    // ArrayBuffer, and holding a strided view over it would keep that entire
    // buffer alive in the inventory for the life of the session. The stack
    // itself is at most a few hundred/thousand row_ids — a real copy is
    // cheap and lets the rest of the chunk's memory go on eviction.
    const rowIds = meta.pointIds.slice(offset, offset + count);
    this.inventory.addStack({
      id: voxelKey(chunk.entry.chunk_id, localVoxelId),
      chunkId: chunk.entry.chunk_id,
      localVoxelId,
      rowIds,
      reprRowId: meta.reprRowId[localVoxelId],
      minedAt: Date.now(),
    });
  }
}
