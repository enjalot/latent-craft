import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { RAYCAST_MAX_DISTANCE } from "../config.ts";

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
 * Center-screen raycaster: since the pointer is locked/hidden behind a
 * crosshair, hover targeting always fires from the middle of the viewport
 * rather than from a mouse position.
 *
 * Phase 2 raycasts against a whole `THREE.Group` of per-chunk
 * `InstancedMesh2`es rather than one mesh — each chunk carries its own BVH, so
 * this stays cheap even with every chunk resident, and the returned hit names
 * the mesh so callers can resolve it back to a chunk/voxel.
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
   */
  raycast(target: THREE.Object3D | THREE.Object3D[], recursive = false): VoxelHit | null {
    this.raycaster.setFromCamera(SCREEN_CENTER, this.camera);
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
