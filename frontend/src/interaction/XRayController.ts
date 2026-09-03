import type { ChunkStore } from "../streaming/ChunkStore.ts";
import { combinedVoxelOpacity, ensureTransparentMaterial } from "../voxels/VoxelOpacity.ts";

/**
 * Hotbar Item 1 — "X-Ray": a global, chunk-wide translucency toggle.
 * Equipping it makes every resident voxel render translucent — still fully
 * interactive, since hover/mine/restore raycast against the visibility
 * gate, never against opacity (Phase 3.5's discovery that
 * `InstancedMesh2.setOpacityAt` is completely independent of
 * `getActiveAndVisibilityAt`, see `MiningController`'s doc comment). This is
 * the "existing per-instance opacity mechanism applied globally" tool, as
 * opposed to Item 2 (`EffectorField.ts`), which suppresses raycasts/renders
 * entirely for a moving volume — the two are deliberately different
 * mechanisms for different jobs.
 *
 * Deliberately does NOT own the per-voxel opacity math itself — that lives
 * in `combinedVoxelOpacity()` (`voxels/VoxelOpacity.ts`), shared with
 * `MiningController`, so a voxel that is BOTH mined AND under X-Ray always
 * composes to the same value regardless of which controller last wrote it
 * (min of the two candidate opacities, not their product — see that
 * function's doc comment). `isMined` is injected as a callback rather than
 * a direct `MiningController` reference specifically to avoid a two-way
 * constructor dependency (`MiningController` needs the mirror-image
 * `isXrayActive` callback back) — see main.ts's bootstrap-order comment for
 * how the two are wired up without either needing to exist first.
 */
export class XRayController {
  private active = false;

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly isMined: (chunkId: number, localVoxelId: number) => boolean,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Equips or un-equips X-Ray. Reapplies (or restores) opacity across
   * every currently-resident chunk immediately — no per-frame polling
   * needed, since nothing about this effect depends on the camera. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    for (const chunkId of this.chunkStore.residentChunkIds) {
      this.applyChunk(chunkId);
    }
  }

  /**
   * Called via `ChunkStore`'s `onResidencyChanged` hook (resident === true
   * branch only) whenever a chunk becomes resident, so a freshly (re)loaded
   * chunk picks up the CURRENT X-Ray state instead of defaulting to opaque
   * while equipped. No-op while inactive: a fresh chunk's default
   * per-instance opacity is already the correct "no X-Ray effect" value (1),
   * and `MiningController.onChunkResident` independently handles reapplying
   * any mined voxels in it — the two don't need to coordinate here because
   * both ultimately go through the same `combinedVoxelOpacity()`.
   */
  onChunkResident(chunkId: number): void {
    if (!this.active) return;
    this.applyChunk(chunkId);
  }

  private applyChunk(chunkId: number): void {
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;
    ensureTransparentMaterial(chunk.mesh);
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      const localVoxelId = occupied[instanceId];
      const mined = this.isMined(chunkId, localVoxelId);
      chunk.mesh.setOpacityAt(instanceId, combinedVoxelOpacity(mined, this.active));
    }
  }
}
