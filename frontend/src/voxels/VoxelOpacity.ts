import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { MINED_OPACITY, XRAY_OPACITY } from "../config.ts";

/**
 * Combines the two independent per-voxel translucency effects Phase 3.5/4
 * both drive through `InstancedMesh2`'s per-instance opacity channel
 * (`setOpacityAt`/`getOpacityAt` — see `MiningController`'s doc comment for
 * how that channel was discovered and why it's independent of the
 * visibility/raycast gate): mining's per-voxel "mined but restorable" state,
 * and X-Ray's chunk-wide "see through everything" toggle.
 *
 * Each effect's "not active" value is 1 (fully opaque) — the identity
 * element for this combination — so `Math.min` naturally reduces to
 * whichever single effect is active when only one applies. For the case
 * where BOTH apply to the same voxel (a mined block while X-Ray is
 * equipped), min() takes the more-transparent of the two candidate values
 * rather than their PRODUCT. Multiplying (0.55 * 0.4 ≈ 0.22) was the first
 * thing tried and, checked by eye against a real screenshot, pushed the
 * combo well past MINED_OPACITY's own already-tuned "indistinguishable from
 * fully gone against this scene's near-black background" floor (see that
 * constant's doc comment in config.ts) — min() avoids compounding two
 * independent "make it more see-through" intents into one that reads as
 * "not there at all".
 */
export function combinedVoxelOpacity(mined: boolean, xrayActive: boolean): number {
  const miningComponent = mined ? MINED_OPACITY : 1;
  const xrayComponent = xrayActive ? XRAY_OPACITY : 1;
  return Math.min(miningComponent, xrayComponent);
}

/**
 * Flips a chunk's material into the transparent render path, once. Cheap to
 * call unconditionally (assigning `true` when already `true` is a no-op) —
 * deliberately never flipped back to `false` even once every voxel in a
 * chunk is back at opacity 1, since a fully-opaque material rendered via the
 * transparent queue is visually identical to one in the opaque queue, just
 * with marginally more sort overhead for that one mesh; not worth tracking
 * "does this chunk still need transparency" just to revert it.
 *
 * Shared by `MiningController` and `XRayController` (both write to the same
 * per-instance opacity channel on the same chunk meshes) so either one can
 * be the first to touch a given chunk without needing to coordinate.
 */
export function ensureTransparentMaterial(mesh: InstancedMesh2): void {
  const material = mesh.material as THREE.Material;
  if (!material.transparent) material.transparent = true;
}
