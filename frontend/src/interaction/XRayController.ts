import type { ChunkStore } from "../streaming/ChunkStore.ts";
import { combinedVoxelOpacity } from "../voxels/VoxelOpacity.ts";
import { setDensityRendering } from "../voxels/DensityView.ts";

/**
 * X-ray glass view: a global, chunk-wide true-transparency toggle.
 * Equipping X-ray makes every resident voxel render translucent — still
 * fully interactive, since hover/extract raycast against the visibility gate,
 * never against opacity (Phase 3.5's discovery that
 * `InstancedMesh2.setOpacityAt` is completely independent of
 * `getActiveAndVisibilityAt`, see `MiningController`'s doc comment). This is
 * the "existing per-instance opacity mechanism applied globally" tool, as
 * opposed to the always-on Effector Field, which suppresses raycasts/renders
 * entirely for a moving volume. Container cages disappear in glass mode so
 * they do not turn many transparent layers into line noise.
 *
 * The former X-Ray kept voxel materials in the opaque render queue with
 * alpha-to-coverage and depth writes on. That path is ideal for isolated
 * extraction fades, but aligned cubes choose the same coverage samples: the
 * front cube writes those samples' depth and the cube immediately behind it
 * cannot contribute. This mode intentionally pays for real alpha blending:
 * depth writes off, transparent render queue, and InstancedMesh2's per-frame
 * back-to-front instance sort. Normal/empty-hand rendering switches straight
 * back to alpha-to-coverage and does no sorting.
 *
 * Deliberately does NOT own the per-voxel opacity math itself — that lives
 * in `combinedVoxelOpacity()` (`voxels/VoxelOpacity.ts`), shared with
 * `MiningController`, so a voxel that is BOTH partly drained AND under glass
 * view always composes to the same value regardless of which controller last wrote
 * it (min of the two candidate opacities, not their product — see that
 * function's doc comment). `extractedFraction` is injected as a callback
 * rather than a direct `MiningController` reference specifically to avoid a
 * two-way constructor dependency (`MiningController` needs the mirror-image
 * `isXrayActive` callback back) — see main.ts's bootstrap-order comment for
 * how the two are wired up without either needing to exist first.
 *
 * Phase 6.5 note: this callback used to be `isMined(): boolean`. Widening it
 * to the voxel's extracted fraction is the whole change here — the equipping,
 * re-application and residency logic below is untouched, because
 * `combinedVoxelOpacity(0, …)` is exactly what `combinedVoxelOpacity(false, …)`
 * used to compute.
 */
export class XRayController {
  private active = false;

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly extractedFraction: (chunkId: number, localVoxelId: number) => number,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Equips or un-equips X-ray glass view. Reapplies (or restores) opacity
   * across every currently-resident chunk immediately — no per-frame polling
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
   * chunk picks up the CURRENT glass state instead of defaulting to opaque
   * while equipped. No-op while inactive: a fresh chunk's default
   * per-instance opacity is already the correct "no X-Ray effect" value (1),
   * and `MiningController.onChunkResident` independently handles reapplying
   * any drained voxels in it — the two don't need to coordinate here because
   * both ultimately go through the same `combinedVoxelOpacity()`.
   */
  onChunkResident(chunkId: number): void {
    if (!this.active) return;
    this.applyChunk(chunkId);
  }

  private applyChunk(chunkId: number): void {
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;
    setDensityRendering(chunk.mesh, this.active);
    // The container cages vanish under glass view — a per-chunk mesh visibility
    // flip, not an opacity, so a
    // hidden chunk's worth of cages costs nothing to not draw. Re-applied on
    // residency like everything else here, so a chunk streamed in while X-ray
    // is equipped comes up cageless too.
    chunk.containers.setXrayActive(this.active);
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      const localVoxelId = occupied[instanceId];
      const fraction = this.extractedFraction(chunkId, localVoxelId);
      chunk.mesh.setOpacityAt(instanceId, combinedVoxelOpacity(fraction, this.active));
    }
  }

}
