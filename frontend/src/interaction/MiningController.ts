import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { ChunkMeshUserData, LoadedChunk } from "../streaming/ChunkLoader.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { Inventory } from "./Inventory.ts";
import { MINED_OPACITY } from "../config.ts";

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
 * fully opaque — `ensureTransparent()` flips that on lazily, once per chunk
 * material, the first time any voxel in it is mined.
 *
 * Mined state still can't live on the mesh across reloads — a chunk's
 * `InstancedMesh2` is disposed on eviction and rebuilt from scratch — so
 * it's tracked here as an independent `Map<chunkId, Set<localVoxelId>>`,
 * re-applied via `onChunkResident` whenever `ChunkStore` reports a chunk
 * becoming resident. Restoring a voxel deletes it from that set (not just a
 * visual revert), so a restored-then-evicted-then-reloaded voxel correctly
 * comes back normal rather than re-mined.
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
    this.ensureTransparent(hit.mesh);
    hit.mesh.setOpacityAt(hit.instanceId, MINED_OPACITY);
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
    hit.mesh.setOpacityAt(hit.instanceId, 1);
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

    this.ensureTransparent(chunk.mesh);
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      if (mined.has(occupied[instanceId])) {
        chunk.mesh.setOpacityAt(instanceId, MINED_OPACITY);
      }
    }
  }

  /** Flips a chunk's material into the transparent render path, once. Cheap
   * to call unconditionally (assigning `true` when already `true` is a
   * no-op) — deliberately never flipped back to `false` even once every
   * mined voxel in a chunk is restored, since a fully-opaque-again material
   * rendered via the transparent queue is visually identical to one in the
   * opaque queue, just with slightly more sort overhead for that one mesh;
   * not worth the bookkeeping to track "does this chunk still have any
   * mined voxel" just to revert it. */
  private ensureTransparent(mesh: InstancedMesh2): void {
    const material = mesh.material as THREE.Material;
    if (!material.transparent) material.transparent = true;
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
