import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { RAYCAST_MAX_DISTANCE } from "../config.ts";

/** Fallback NDC when a caller doesn't have a real cursor position yet (e.g.
 * before the first pointermove). Phase 1-3 always raycast from here, back
 * when the pointer was locked/hidden behind a fixed crosshair; Phase 3.5's
 * free-mouse scheme raycasts from the actual cursor instead (see
 * `interaction/PointerController.ts#ndc`), so this is now just a sane
 * default, not the primary behavior. */
const SCREEN_CENTER = new THREE.Vector2(0, 0);

export interface VoxelHit {
  /** Instance id within `mesh` — NOT a global id; ids restart per chunk. */
  instanceId: number;
  /** The chunk mesh that was hit. */
  mesh: InstancedMesh2;
  point: THREE.Vector3;
  distance: number;
}

/**
 * Whether an instance the ray crossed should be looked THROUGH rather than
 * hit — see `VoxelRaycaster`'s constructor. Called near-to-far, once per
 * instance in front of the eventual hit, so it must be cheap (a map lookup,
 * not a scan).
 */
export type PassThroughPredicate = (mesh: InstancedMesh2, instanceId: number) => boolean;

/**
 * Cursor-following raycaster: hover/mine targeting fires from wherever the
 * mouse actually is (`ndc`, normalized device coordinates, -1..1 on each
 * axis), not a fixed screen point — necessary now that the free-mouse
 * control scheme (Phase 3.5) means "where the camera looks" and "where the
 * cursor is" are no longer the same point by construction.
 *
 * Phase 2 raycasts against a whole `THREE.Group` of per-chunk
 * `InstancedMesh2`es rather than one mesh — each chunk carries its own BVH, so
 * this stays cheap even with every chunk resident, and the returned hit names
 * the mesh so callers can resolve it back to a chunk/voxel. Phase 8 adds the
 * whole-dataset voxel proxy mesh as a second target (`main.ts` passes both as
 * an array): a hover lands on a flat stand-in exactly as it lands on a
 * thumbnail, and `hit.mesh` is how the caller tells the two apart.
 *
 * ## Pass-through instances
 *
 * The hit returned is the NEAREST intersection that `isPassThrough` does not
 * veto, not the nearest intersection outright. `main.ts` supplies a predicate
 * that vetoes fully drained voxels ("empty cubes should not interact anymore,
 * so that you can mine whats behind them"): a drained cube is still drawn (a
 * ghost at `EXTRACTION_FLOOR_OPACITY`, inside a dim cage) and is still an
 * active instance as far as InstancedMesh2's visibility gate is concerned —
 * making it un-raycastable via `setVisibilityAt(false)` would also stop
 * drawing it — so the skip has to happen here, on the sorted intersection
 * list, rather than in the mesh. Skipping is per intersection, so a ray
 * through two drained cubes lands on the third thing behind them, and
 * because the predicate is consulted on every cast, a voxel that drains under
 * the cursor drops out of hover on the very next frame and one that gets a
 * point returned is a hit again at once. Both targets are collected in full:
 * InstancedMesh2's BVH raycast visits every leaf the ray crosses (no
 * first-hit early-out), and three sorts the union near-to-far before this
 * walks it.
 */
export class VoxelRaycaster {
  private readonly raycaster = new THREE.Raycaster();
  private readonly results: THREE.Intersection[] = [];

  /**
   * @param isPassThrough Vetoes intersections the cast should look through
   *   (see the class comment); defaults to vetoing nothing.
   */
  constructor(
    private readonly camera: THREE.Camera,
    private readonly isPassThrough: PassThroughPredicate = () => false,
  ) {
    this.raycaster.far = RAYCAST_MAX_DISTANCE;
  }

  /**
   * @param target A single mesh, an array of meshes, or a group to descend
   *   into (`recursive` must be true for the group case).
   * @param ndc Normalized device coordinates (-1..1) to cast from — pass the
   *   current mouse position (`PointerController#ndc`) for hover/mining;
   *   defaults to screen center only for callers that don't track a cursor.
   */
  raycast(target: THREE.Object3D | THREE.Object3D[], recursive = false, ndc: THREE.Vector2 = SCREEN_CENTER): VoxelHit | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    this.results.length = 0;

    if (Array.isArray(target)) {
      this.raycaster.intersectObjects(target, recursive, this.results);
    } else {
      this.raycaster.intersectObject(target, recursive, this.results);
    }

    // intersectObject(s) returns hits sorted near-to-far; the first one that
    // is an instance and not pass-through wins.
    for (const hit of this.results) {
      if (hit.instanceId === undefined) continue;
      const mesh = hit.object as InstancedMesh2;
      if (this.isPassThrough(mesh, hit.instanceId)) continue;
      return {
        instanceId: hit.instanceId,
        mesh,
        point: hit.point,
        distance: hit.distance,
      };
    }
    return null;
  }
}
