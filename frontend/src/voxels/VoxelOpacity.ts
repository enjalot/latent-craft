import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { EXTRACTION_FLOOR_OPACITY, XRAY_OPACITY } from "../config.ts";

/**
 * The mining half of the composition, on its own: how opaque a voxel is given
 * what fraction of its points have been extracted into the inventory.
 *
 * A plain linear ramp from 1 (untouched) down to `EXTRACTION_FLOOR_OPACITY`
 * (every point pulled out). Linear rather than eased on purpose: the fade IS
 * the readout for "how much is left in here", so the mapping from fraction to
 * dimness should be the one a viewer can invert by eye without knowing a
 * curve. With `EXTRACTION_TARGET_CYCLES = 10` each extraction pulse steps the
 * opacity down by a visible, even 0.07.
 */
export function extractionOpacity(extractedFraction: number): number {
  const clamped = Math.max(0, Math.min(1, extractedFraction));
  return 1 + (EXTRACTION_FLOOR_OPACITY - 1) * clamped;
}

/**
 * Combines the two independent per-voxel translucency effects Phase 3.5/4
 * both drive through `InstancedMesh2`'s per-instance opacity channel
 * (`setOpacityAt`/`getOpacityAt` — see `MiningController`'s doc comment for
 * how that channel was discovered and why it's independent of the
 * visibility/raycast gate): mining's per-voxel extraction state, and X-Ray's
 * chunk-wide "see through everything" toggle.
 *
 * Phase 6.5 widened the first argument from a boolean (`mined`) to the voxel's
 * extracted FRACTION, since mining is now continuous — but the composition
 * rule below is unchanged, and deliberately so: `extractionOpacity(0) === 1`,
 * which is still exactly the identity element `mined === false` used to
 * produce, so every existing call site's semantics carry over untouched.
 *
 * Each effect's "not active" value is 1 (fully opaque) — the identity
 * element for this combination — so `Math.min` naturally reduces to
 * whichever single effect is active when only one applies. For the case
 * where BOTH apply to the same voxel (a drained block while X-Ray is
 * equipped), min() takes the more-transparent of the two candidate values
 * rather than their PRODUCT. Multiplying was the first thing tried back in
 * Phase 4 and, checked by eye against a real screenshot, pushed the combo well
 * past the mining floor's own already-tuned "still visibly there against this
 * scene's near-black background" limit — min() avoids compounding two
 * independent "make it more see-through" intents into one that reads as
 * "not there at all". That reasoning gets *more* load-bearing with a lower
 * floor, not less: 0.3 * 0.4 would be 0.12, which measures as void.
 *
 * The mirror-image constraint lives on the constants themselves and is worth
 * repeating here, since it is this function that enforces it: the extraction
 * floor has to stay BELOW `XRAY_OPACITY`, or `min()` collapses "fully drained"
 * and "untouched" to the same rendered value while X-Ray is equipped. See
 * `EXTRACTION_FLOOR_OPACITY`'s doc comment.
 */
export function combinedVoxelOpacity(extractedFraction: number, xrayActive: boolean): number {
  const miningComponent = extractionOpacity(extractedFraction);
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
