import * as THREE from "three";
import { createEffectorSurface, buildEffectorSurfaceGeometry, effectorSurfaceOpacity } from "./EffectorSurface.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import {
  EFFECTOR_DEFAULT_RADIUS_VOXELS,
  EFFECTOR_MAX_RADIUS_CHUNKS,
  EFFECTOR_MIN_RADIUS_VOXELS,
  EFFECTOR_RADIUS_STEP_VOXELS,
  EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC,
} from "../config.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Always-on, resizable bubble centered on the camera that HIDES (not fades)
 * whatever voxels currently fall inside it, so the player can push into a
 * dense cluster and see what's around them.
 *
 * This is a deliberately DIFFERENT mechanism from X-Ray/mining's
 * `setOpacityAt` translucency (`voxels/VoxelOpacity.ts`): the goal here is
 * to stop suppressed voxels from blocking RAYCASTS, not just make them look
 * faded, so this uses `InstancedMesh2.setVisibilityAt(id, false)` — per
 * Phase 3's original documented finding (the one Phase 3.5 later moved
 * mining itself away from, see `MiningController`'s doc comment): one call
 * makes an instance BOTH invisible AND un-raycastable, which is exactly
 * "reach through" needs. Un-hiding (`setVisibilityAt(id, true)`) restores
 * both at once, for any voxel that leaves the volume.
 *
 * Position: the field is CENTERED ON THE CAMERA — its center IS
 * `camera.position`, so flying is how you move it, and there is no separate
 * standoff/distance control ("the effector field should be centered on the
 * camera so the field just goes outwards"). An earlier version held the
 * sphere out in front of the camera at an adjustable distance (`[`/`]`
 * keys); that made it a probe you aimed rather than a bubble you carried,
 * and the two ideas are different enough that the distance control was
 * removed outright instead of defaulting to zero. The only parameter is
 * `radius`: scrolling over the 3D canvas grows/shrinks it. Scoping the wheel
 * listener to the canvas lets inventory and telemetry panels retain normal
 * scrolling.
 *
 * Solid beveled bars mark the boundary while resizing, then fade. Three
 * fixed-slot rings follow the mouse direction; spacing and bar size compress
 * together for small fields so the objects cannot overlap.
 *
 * Suppression is recomputed from scratch every time it's needed (a
 * throttled per-frame `update()`, plus a forced pass from `onChunkResident`)
 * rather than persisted the way `MiningController` persists mined state —
 * there is nothing durable here by design: a chunk that streams back in
 * while the field still happens to overlap it gets re-suppressed by the
 * very next recompute, and one that streams in after the field has moved on
 * stays fully visible, with zero special-casing needed for either case.
 */
export class EffectorFieldController {
  readonly gizmo: THREE.Group;

  private radius: number;
  private readonly surface: ReturnType<typeof createEffectorSurface>;
  private lastResizeAt = -Infinity;
  private surfaceRadius = 2;
  private surfaceAngle = .45;
  private readonly surfaceRay = new THREE.Raycaster();
  private readonly surfaceDirection = new THREE.Vector3();
  private readonly inverseCamera = new THREE.Quaternion();
  private readonly surfaceAim = new THREE.Quaternion();
  private readonly forwardAxis = new THREE.Vector3(0, 0, -1);
  private readonly defaultPointer = new THREE.Vector2();

  private readonly minRadius: number;
  private readonly maxRadius: number;
  private readonly radiusStep: number;
  private readonly moveEpsilon: number;

  private readonly center = new THREE.Vector3();
  private readonly lastCenter = new THREE.Vector3(Number.NaN, 0, 0);
  private lastRadius = -1;
  private readonly voxelScratch = new THREE.Vector3();
  private readonly chunkCenterScratch = new THREE.Vector3();

  /** chunkId -> set of localVoxelIds THIS controller currently has hidden —
   * the live "what am I suppressing right now" record. Rebuilt fresh on
   * every recompute (see class doc comment above), never carried across an
   * evict/reload the way `MiningController`'s persisted set is. */
  private suppressed = new Map<number, Set<number>>();

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly manifest: Manifest,
    scene: THREE.Scene,
    private readonly wheelTarget: HTMLElement,
  ) {
    this.radius = manifest.voxelWorldSize * EFFECTOR_DEFAULT_RADIUS_VOXELS;
    this.minRadius = manifest.voxelWorldSize * EFFECTOR_MIN_RADIUS_VOXELS;
    this.maxRadius = manifest.chunkWorldSize * EFFECTOR_MAX_RADIUS_CHUNKS;
    this.radiusStep = manifest.voxelWorldSize * EFFECTOR_RADIUS_STEP_VOXELS;
    this.moveEpsilon = manifest.voxelWorldSize * EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC;

    this.gizmo = new THREE.Group();
    this.gizmo.name = "effector-field-gizmo";
    this.surface = createEffectorSurface();
    this.gizmo.add(this.surface);
    this.gizmo.visible = false;
    scene.add(this.gizmo);

    wheelTarget.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  get isActive(): boolean {
    return true;
  }

  get currentRadius(): number {
    return this.radius;
  }

  get currentRadiusVoxels(): number {
    return this.radius / this.manifest.voxelWorldSize;
  }

  /** Total voxels currently suppressed — for HUD/status display and for
   * scripted verification. */
  get suppressedCount(): number {
    let total = 0;
    for (const set of this.suppressed.values()) total += set.size;
    return total;
  }

  /** Per-frame hook, internally throttled so it only does real work when the
   * field's computed center or radius actually changed. */
  update(camera: THREE.Camera, pointer = this.defaultPointer): void {
    const opacity = effectorSurfaceOpacity(performance.now() - this.lastResizeAt);
    this.surface.material.opacity = opacity;
    this.gizmo.visible = opacity > 0;
    this.recomputeFromCamera(camera, false);
    if (opacity <= 0) return;
    const perspective = camera as THREE.PerspectiveCamera;
    const angle = perspective.isPerspectiveCamera ? THREE.MathUtils.degToRad(perspective.fov) * .4 : .45;
    if (this.surfaceRadius !== this.currentRadiusVoxels || this.surfaceAngle !== angle) {
      this.surface.geometry.dispose();
      this.surface.geometry = buildEffectorSurfaceGeometry(this.currentRadiusVoxels, angle);
      this.surfaceRadius = this.currentRadiusVoxels; this.surfaceAngle = angle;
    }
    this.surfaceRay.setFromCamera(pointer, camera);
    this.inverseCamera.copy(camera.quaternion).invert();
    this.surfaceDirection.copy(this.surfaceRay.ray.direction).applyQuaternion(this.inverseCamera);
    this.surfaceAim.setFromUnitVectors(this.forwardAxis, this.surfaceDirection);
    this.gizmo.quaternion.copy(camera.quaternion).multiply(this.surfaceAim);
  }

  /** `ChunkStore`'s `onResidencyChanged` hook, resident === true branch
   * only (wired from main.ts alongside `MiningController`/`XRayController`'s
   * own hooks, which is why this takes the same `chunkId` parameter even
   * though — unlike theirs — a full recompute doesn't need to target any one
   * chunk specifically). A newly-resident chunk doesn't move the field
   * itself, so `update()`'s move-epsilon throttle would otherwise skip
   * recomputing and leave the new chunk's voxels un-suppressed even where
   * they should be — this forces one recompute pass to cover that case. */
  onChunkResident(chunkId: number): void {
    // A chunk that was evicted while suppressed and has now streamed back in
    // has a FRESH mesh with every instance visible, but `suppressed` may still
    // hold the ids this controller hid in the old one (eviction has no hook,
    // so the record was never pruned). Left in place, the diff below would
    // see "already suppressed" and skip re-hiding them. Forget the stale
    // record first so the rebuilt chunk is treated as fully visible, which is
    // what it is.
    this.suppressed.delete(chunkId);
    this.recomputeSuppression();
  }

  adjustRadius(deltaSteps: number): void {
    if (!Number.isFinite(deltaSteps) || deltaSteps === 0) return;
    this.lastResizeAt = performance.now();
    this.radius = clamp(this.radius + deltaSteps * this.radiusStep, this.minRadius, this.maxRadius);
  }

  setRadiusVoxels(radius: number, animate = true): void {
    if (!Number.isFinite(radius)) return;
    this.radius = clamp(radius * this.manifest.voxelWorldSize, this.minRadius, this.maxRadius);
    if (animate) this.lastResizeAt = performance.now();
  }

  private recomputeFromCamera(camera: THREE.Camera, force: boolean): void {
    // Centered on the camera — see the class doc comment. Looking around
    // therefore never moves the field; only flying does.
    this.center.copy(camera.position);
    this.gizmo.position.copy(this.center);
    this.gizmo.scale.setScalar(this.manifest.voxelWorldSize);

    const moved = this.lastCenter.distanceToSquared(this.center) > this.moveEpsilon * this.moveEpsilon;
    const resized = this.radius !== this.lastRadius;
    if (!force && !moved && !resized) return;

    this.lastCenter.copy(this.center);
    this.lastRadius = this.radius;
    this.recomputeSuppression();
  }

  /** Rebuilds the suppression set from scratch against the field's CURRENT
   * center/radius, then diffs it against the previous set to know which
   * voxels to hide and which to un-hide — see the class doc comment for why
   * "recompute from scratch every time" is the right model here (unlike
   * `MiningController`'s durable, persisted mined-set). */
  private recomputeSuppression(): void {
    const next = new Map<number, Set<number>>();
    // Cube half-diagonal (center to corner) = edge * sqrt(3) / 2 — a cheap
    // broad-phase per-chunk reject so this stays roughly O(nearby occupied
    // voxels) rather than O(every resident instance) on every recompute.
    const chunkHalfDiagonal = (this.manifest.chunkWorldSize * Math.sqrt(3)) / 2;
    const radiusSq = this.radius * this.radius;

    for (const chunkId of this.chunkStore.residentChunkIds) {
      const chunk = this.chunkStore.chunk(chunkId);
      if (!chunk) continue;

      this.manifest.chunkCenterWorld(chunkId, this.chunkCenterScratch);
      if (this.chunkCenterScratch.distanceTo(this.center) > chunkHalfDiagonal + this.radius) continue;

      const { entry, meta } = chunk;
      let chunkSet: Set<number> | undefined;
      for (let instanceId = 0; instanceId < meta.occupied.length; instanceId++) {
        const localVoxelId = meta.occupied[instanceId];
        this.manifest.voxelCenterWorld(entry.cx, entry.cy, entry.cz, localVoxelId, this.voxelScratch);
        if (this.voxelScratch.distanceToSquared(this.center) <= radiusSq) {
          if (!chunkSet) {
            chunkSet = new Set();
            next.set(chunkId, chunkSet);
          }
          chunkSet.add(localVoxelId);
        }
      }
    }

    this.applySuppressionDiff(next);
    this.suppressed = next;
  }

  private applySuppressionDiff(next: Map<number, Set<number>>): void {
    // Un-hide anything that was suppressed and no longer should be —
    // including whole chunks that dropped out of `next` entirely.
    for (const [chunkId, prevSet] of this.suppressed) {
      const chunk = this.chunkStore.chunk(chunkId);
      if (!chunk) continue; // evicted meanwhile — mesh is gone, nothing to unhide
      const nextSet = next.get(chunkId);
      const occupied = chunk.meta.occupied;
      for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
        const localVoxelId = occupied[instanceId];
        if (prevSet.has(localVoxelId) && !nextSet?.has(localVoxelId)) {
          chunk.mesh.setVisibilityAt(instanceId, true);
          // Phase 6.8: a voxel's container cage is a separate mesh, so hiding
          // the cube alone would leave an empty frame floating in the hole the
          // field just opened. Same instance id, same gate.
          chunk.containers.setSuppressed(instanceId, false);
        }
      }
    }
    // Hide anything newly inside the volume.
    for (const [chunkId, nextSet] of next) {
      const chunk = this.chunkStore.chunk(chunkId);
      if (!chunk) continue;
      const prevSet = this.suppressed.get(chunkId);
      const occupied = chunk.meta.occupied;
      for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
        const localVoxelId = occupied[instanceId];
        if (nextSet.has(localVoxelId) && !prevSet?.has(localVoxelId)) {
          chunk.mesh.setVisibilityAt(instanceId, false);
          chunk.containers.setSuppressed(instanceId, true);
        }
      }
    }
  }

  /** Un-hides everything currently suppressed during application teardown. */
  private clearSuppression(): void {
    for (const [chunkId, set] of this.suppressed) {
      const chunk = this.chunkStore.chunk(chunkId);
      if (!chunk) continue;
      const occupied = chunk.meta.occupied;
      for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
        if (!set.has(occupied[instanceId])) continue;
        chunk.mesh.setVisibilityAt(instanceId, true);
        chunk.containers.setSuppressed(instanceId, false);
      }
    }
    this.suppressed.clear();
  }

  private handleWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    // Normalize browser wheel units to CSS-pixel-ish travel. Scroll up
    // (negative deltaY) grows; scroll down shrinks. Trackpads remain smooth
    // instead of every tiny event counting as a full mouse-wheel notch.
    const unitScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1;
    this.adjustRadius((-event.deltaY * unitScale) / 100);
  };

  dispose(): void {
    this.clearSuppression();
    this.wheelTarget.removeEventListener("wheel", this.handleWheel);
    this.gizmo.removeFromParent();
    this.surface.geometry.dispose();
    this.surface.material.dispose();
    this.gizmo.clear();
  }
}
