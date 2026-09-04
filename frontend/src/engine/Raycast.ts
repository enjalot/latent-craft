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
 */
export class VoxelRaycaster {
  private readonly raycaster = new THREE.Raycaster();
  private readonly results: THREE.Intersection[] = [];

  constructor(private readonly camera: THREE.Camera) {
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
    if (this.results.length === 0) return null;

    // intersectObject(s) returns hits sorted near-to-far.
    const hit = this.results[0];
    if (hit.instanceId === undefined) return null;

    return {
      instanceId: hit.instanceId,
      mesh: hit.object as InstancedMesh2,
      point: hit.point,
      distance: hit.distance,
    };
  }
}
