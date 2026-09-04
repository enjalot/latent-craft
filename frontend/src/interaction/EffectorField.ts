import * as THREE from "three";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import {
  EFFECTOR_DEFAULT_RADIUS_VOXELS,
  EFFECTOR_GIZMO_COLOR,
  EFFECTOR_KEY_STEP_MULTIPLIER,
  EFFECTOR_MAX_RADIUS_CHUNKS,
  EFFECTOR_MIN_RADIUS_VOXELS,
  EFFECTOR_RADIUS_STEP_VOXELS,
  EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC,
} from "../config.ts";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildGizmo(): THREE.Group {
  const group = new THREE.Group();
  group.name = "effector-field-gizmo";
  // Drawn after the opaque voxels (textured and proxy, renderOrder 0, the
  // default) and the container cages (renderOrder 1, see VoxelContainers.ts)
  // — translucent geometry drawn back-to-front only looks right relative to
  // what's already there.
  group.renderOrder = 2;

  // Unit sphere, scaled per-frame to `radius` — avoids rebuilding geometry
  // on every resize.
  const geometry = new THREE.SphereGeometry(1, 24, 16);

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: EFFECTOR_GIZMO_COLOR,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  group.add(new THREE.Mesh(geometry, fillMaterial));

  const wireMaterial = new THREE.MeshBasicMaterial({
    color: EFFECTOR_GIZMO_COLOR,
    wireframe: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(geometry, wireMaterial));

  return group;
}

/**
 * Hotbar slot 3 — "Effector Field": a resizable bubble centered on the
 * camera that HIDES (not fades) whatever voxels currently fall inside it, so
 * the player can push into a dense cluster and see what's around them.
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
 * `radius`: the mouse wheel (or the `-`/`=` keys) grows/shrinks it. All
 * bindings only do anything while this item is actually equipped
 * (`active`).
 *
 * Because the camera sits inside the sphere, the gizmo is seen from within:
 * the translucent fill becomes a faint full-view tint and the wireframe a
 * cage of lat/long lines around you, which together read as "the field is
 * on" without hiding anything. The fill is `DoubleSide` for exactly this
 * reason.
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

  private active = false;
  private radius: number;

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
  ) {
    this.radius = manifest.voxelWorldSize * EFFECTOR_DEFAULT_RADIUS_VOXELS;
    this.minRadius = manifest.voxelWorldSize * EFFECTOR_MIN_RADIUS_VOXELS;
    this.maxRadius = manifest.chunkWorldSize * EFFECTOR_MAX_RADIUS_CHUNKS;
    this.radiusStep = manifest.voxelWorldSize * EFFECTOR_RADIUS_STEP_VOXELS;
    this.moveEpsilon = manifest.voxelWorldSize * EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC;

    this.gizmo = buildGizmo();
    this.gizmo.visible = false;
    scene.add(this.gizmo);

    window.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("keydown", this.handleKeydown);
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentRadius(): number {
    return this.radius;
  }

  /** Total voxels currently suppressed — for HUD/status display and for
   * scripted verification. */
  get suppressedCount(): number {
    let total = 0;
    for (const set of this.suppressed.values()) total += set.size;
    return total;
  }

  /** Equips or un-equips the Effector Field. Un-equipping restores
   * visibility to everything currently suppressed — see `clearSuppression`.
   * Equipping forces an immediate placement/recompute against `camera` (when
   * given) rather than waiting for the next `update()` tick, so the field
   * appears exactly where it should the instant it's equipped. */
  setActive(active: boolean, camera?: THREE.Camera): void {
    if (active === this.active) return;
    this.active = active;
    this.gizmo.visible = active;
    if (!active) {
      this.clearSuppression();
      return;
    }
    // Reset the move-throttle state so the very next recompute is forced
    // even if the camera happens to be exactly where it was last time this
    // field was active.
    this.lastRadius = -1;
    this.lastCenter.set(Number.NaN, 0, 0);
    if (camera) this.recomputeFromCamera(camera, true);
  }

  /** Per-frame hook (main.ts's tick) — cheap early-out while un-equipped;
   * internally throttled (see `EFFECTOR_UPDATE_MOVE_EPSILON_VOXEL_FRAC`)
   * while equipped, so it only does real work when the field's computed
   * center or radius actually changed. */
  update(camera: THREE.Camera): void {
    if (!this.active) return;
    this.recomputeFromCamera(camera, false);
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
    if (!this.active) return;
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
    this.radius = clamp(this.radius + deltaSteps * this.radiusStep, this.minRadius, this.maxRadius);
  }

  private recomputeFromCamera(camera: THREE.Camera, force: boolean): void {
    // Centered on the camera — see the class doc comment. Looking around
    // therefore never moves the field; only flying does.
    this.center.copy(camera.position);

    const moved = this.lastCenter.distanceToSquared(this.center) > this.moveEpsilon * this.moveEpsilon;
    const resized = this.radius !== this.lastRadius;
    if (!force && !moved && !resized) return;

    this.lastCenter.copy(this.center);
    this.lastRadius = this.radius;
    this.gizmo.position.copy(this.center);
    this.gizmo.scale.setScalar(this.radius);
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

  /** Un-hides everything currently suppressed and clears the set — called on
   * un-equip so nothing stays orphaned-invisible after the tool is put
   * away. */
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
    if (!this.active) return;
    event.preventDefault();
    // Scroll up (negative deltaY) = grow, scroll down = shrink.
    //
    // Swapped from "wheel repositions, shift+wheel resizes" per user
    // feedback: resizing is the control you reach for constantly (the field
    // needs to match the cluster you're digging into), repositioning is the
    // one you touch occasionally, so the frictionless gesture belongs to
    // resize. There is deliberately no shift+wheel branch anymore either —
    // Shift is now "descend" in `FlightControls`, so a shift+wheel binding
    // would fire while the player is flying downward.
    this.adjustRadius(event.deltaY > 0 ? -1 : 1);
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    switch (event.code) {
      case "Equal":
      case "NumpadAdd":
        this.adjustRadius(EFFECTOR_KEY_STEP_MULTIPLIER);
        break;
      case "Minus":
      case "NumpadSubtract":
        this.adjustRadius(-EFFECTOR_KEY_STEP_MULTIPLIER);
        break;
      default:
        break;
    }
  };

  dispose(): void {
    window.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeydown);
  }
}
