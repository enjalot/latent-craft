import * as THREE from "three";

/**
 * A small pool of additive glow boxes used to light up an arbitrary set of
 * voxels — the 3D half of the minimap's flashlight.
 *
 * Design notes, all deliberate:
 *
 * - **Plain `THREE.InstancedMesh`, not `InstancedMesh2`.** The whole set is
 *   rewritten on every update (a few hundred matrices), which is exactly the
 *   case a bare instance-matrix buffer handles best; none of
 *   `InstancedMesh2`'s per-instance BVH/culling/uniform machinery is wanted
 *   here, and this mesh must never be raycastable.
 * - **Separate from the chunk meshes.** The obvious alternative — bumping the
 *   hovered voxels' `setOpacityAt` on their own chunk mesh — would put a
 *   fourth writer on the per-instance opacity channel that `MiningController`,
 *   `XRayController` and `combinedVoxelOpacity()` already share, and would
 *   have to be re-applied on every chunk residency change. An independent
 *   overlay mesh has no state to reconcile: positions come from
 *   `Manifest.voxelCenterWorld*`, which is pure math over chunk/voxel ids, so
 *   it works identically for voxels whose chunk has not streamed in yet.
 * - **`depthTest: false`** so lit voxels show through the cluster in front of
 *   them. A flashlight whose whole job is "show me where these points went"
 *   is more useful visible-through-the-mass than occluded by it, and it makes
 *   the effect unambiguous on screen.
 * - **`frustumCulled = false`** — a plain `InstancedMesh`'s bounding sphere is
 *   derived from its geometry, not its instance transforms, so leaving culling
 *   on is the classic way to have instances vanish at the screen edge. The
 *   pool is capacity-bounded and tiny, so there's nothing to save by culling.
 */
export class HighlightCubes {
  readonly mesh: THREE.InstancedMesh;

  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly matrix = new THREE.Matrix4();
  private readonly cubeSize: number;
  private written = 0;

  constructor(capacity: number, cubeSize: number, color: number, opacity: number) {
    this.cubeSize = cubeSize;
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, capacity));
    this.mesh.name = "minimap-flashlight";
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Drawn after the voxels (textured and proxy) and the container cages so
    // the additive pass lands on top of whatever is already in the frame.
    this.mesh.renderOrder = 2;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  get capacity(): number {
    return this.mesh.instanceMatrix.count;
  }

  get count(): number {
    return this.mesh.count;
  }

  /** Starts a new batch; call `add()` then `commit()`. */
  begin(): void {
    this.written = 0;
  }

  /** Adds one glow box centred on `position`. Returns false once full. */
  add(position: THREE.Vector3): boolean {
    if (this.written >= this.capacity) return false;
    this.matrix.makeScale(this.cubeSize, this.cubeSize, this.cubeSize);
    this.matrix.setPosition(position);
    this.mesh.setMatrixAt(this.written++, this.matrix);
    return true;
  }

  commit(): void {
    this.mesh.count = this.written;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.written = 0;
    this.commit();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
