import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { ChunkMeshUserData, LoadedChunk } from "../streaming/ChunkLoader.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { Inventory } from "./Inventory.ts";
import { combinedVoxelOpacity, ensureTransparentMaterial } from "../voxels/VoxelOpacity.ts";

function voxelKey(chunkId: number, localVoxelId: number): string {
  return `${chunkId}:${localVoxelId}`;
}

/**
 * Turns a raycast hit into a mined (or restored) voxel.
 *
 * Phase 3.5 rewrite: mining used to call `InstancedMesh2.setVisibilityAt(id,
 * false)`, which — per Phase 3's own documented finding (confirmed by
 * reading `Raycasting.js`/`FrustumCulling.js`) — makes an instance BOTH
 * invisible AND un-raycastable in one call. That's wrong for the new
 * requirement: a mined voxel must stay visible (translucent) AND stay
 * raycastable/hoverable, so the player can find it again to restore it.
 *
 * The fix turned out not to need any new shader/uniform machinery: reading
 * `InstancedMesh2`'s source (`InstancedMesh2.js`) turned up a first-class,
 * already-built per-instance opacity channel — `setOpacityAt`/`getOpacityAt`,
 * backed by `colorsTexture` (the same texture `ProxyCloud` already uses for
 * per-instance tint via `instance.color = …`), completely independent of
 * `VoxelMaterial.ts`'s custom `tileIndex` uniform. It lazily allocates itself
 * on first use and does NOT touch `getActiveAndVisibilityAt` (what
 * raycasting/frustum-culling actually gate on), so a mined voxel set to a
 * lower opacity via `setOpacityAt` stays fully hit-testable for free — no
 * separate "third state" plumbing needed in `VoxelMaterial.ts` after all.
 * The one thing that DOES need doing manually: `MeshStandardMaterial`
 * defaults to `transparent: false`, so opacity <1 would otherwise render
 * fully opaque — `ensureTransparentMaterial()` (`voxels/VoxelOpacity.ts`)
 * flips that on lazily, once per chunk material, the first time any voxel in
 * it needs opacity <1 (from mining OR from X-Ray, see the Phase 4 note
 * below — the two share this helper).
 *
 * Mined state still can't live on the mesh across reloads — a chunk's
 * `InstancedMesh2` is disposed on eviction and rebuilt from scratch — so
 * it's tracked here as an independent `Map<chunkId, Set<localVoxelId>>`,
 * re-applied via `onChunkResident` whenever `ChunkStore` reports a chunk
 * becoming resident. Restoring a voxel deletes it from that set (not just a
 * visual revert), so a restored-then-evicted-then-reloaded voxel correctly
 * comes back normal rather than re-mined.
 *
 * Phase 4 addition: every `setOpacityAt` write below goes through
 * `combinedVoxelOpacity()` (`voxels/VoxelOpacity.ts`) rather than a bare
 * `MINED_OPACITY`/`1`, so a voxel mined (or restored) while the "X-Ray"
 * hotbar item is equipped lands on the correct COMBINED opacity instead of
 * silently ignoring X-Ray's global toggle — e.g. restoring a voxel while
 * X-Ray is still equipped must leave it at `XRAY_OPACITY`, not snap it back
 * to fully opaque. `isXrayActive` is injected as a callback (not a direct
 * `XRayController` reference) to avoid a two-way constructor dependency —
 * `XRayController` itself needs `MiningController.isMined` to do the same
 * combination in reverse. See main.ts's bootstrap-order comment.
 */
export class MiningController {
  readonly inventory = new Inventory();

  private readonly minedByChunk = new Map<number, Set<number>>();

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly isXrayActive: () => boolean = () => false,
  ) {}

  isMined(chunkId: number, localVoxelId: number): boolean {
    return this.minedByChunk.get(chunkId)?.has(localVoxelId) ?? false;
  }

  /**
   * Mines whatever the current raycast hit points at, if anything. Returns
   * `true` iff a voxel was actually mined.
   *
   * Silently no-ops for a null hit, a hit against something that isn't a
   * chunk-voxel mesh (the Phase 1 `?synthetic=1` field has no `chunkId` in
   * its userData), or a voxel that's already mined — unlike Phase 3, a mined
   * voxel stays raycastable, so this check is load-bearing now, not just
   * defensive.
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
    ensureTransparentMaterial(hit.mesh);
    hit.mesh.setOpacityAt(hit.instanceId, combinedVoxelOpacity(true, this.isXrayActive()));
    this.snapshotStack(chunk, localVoxelId);
    return true;
  }

  /**
   * Reverses `mine()` for whatever the current raycast hit points at: opacity
   * back to normal, cleared from the persisted mined-set (so eviction/reload
   * doesn't bring it back mined), and its inventory stack removed. Returns
   * `true` iff a voxel was actually restored.
   */
  restore(hit: VoxelHit | null): boolean {
    if (!hit) return false;
    const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
    if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return false;

    const chunkId = userData.chunkId;
    const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
    if (localVoxelId === undefined || !this.isMined(chunkId, localVoxelId)) return false;

    this.unmark(chunkId, localVoxelId);
    // NOT a bare `1` — if X-Ray is still equipped, a restored voxel must
    // land back on XRAY_OPACITY (still see-through, per that item's global
    // effect), not snap to fully opaque just because mining's own state
    // cleared. See this class's doc comment.
    hit.mesh.setOpacityAt(hit.instanceId, combinedVoxelOpacity(false, this.isXrayActive()));
    this.inventory.removeStack(voxelKey(chunkId, localVoxelId));
    return true;
  }

  /**
   * Called (via `ChunkStore`'s `onResidencyChanged` hook) whenever a chunk
   * becomes resident. Re-applies mined opacity to any voxel this session
   * already mined in it — restored voxels are, by construction, no longer in
   * `minedByChunk` (see `restore()`), so they correctly come back normal
   * rather than re-mined.
   *
   * `chunk.meta.occupied[instanceId] === localVoxelId` is the same identity
   * `ChunkLoader.load`'s `addInstances` loop relies on (instance ids are
   * assigned in ascending-`occupied`-index order), so scanning it once
   * inverts instanceId↔localVoxelId without a persistent side table. Only
   * done when this chunk actually has mined voxels to reapply.
   */
  onChunkResident(chunkId: number): void {
    const mined = this.minedByChunk.get(chunkId);
    if (!mined || mined.size === 0) return;
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;

    ensureTransparentMaterial(chunk.mesh);
    const xrayActive = this.isXrayActive();
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      if (mined.has(occupied[instanceId])) {
        chunk.mesh.setOpacityAt(instanceId, combinedVoxelOpacity(true, xrayActive));
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

  private unmark(chunkId: number, localVoxelId: number): void {
    this.minedByChunk.get(chunkId)?.delete(localVoxelId);
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
