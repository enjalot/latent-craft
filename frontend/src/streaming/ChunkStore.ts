import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { isAbortError } from "../net/fetchTyped.ts";
import { Ring, chunkPriority, ringFor, type RingRadii } from "./priority.ts";
import type { ChunkLoader, LoadedChunk } from "./ChunkLoader.ts";
import type { Manifest } from "./Manifest.ts";
import type { ManifestChunk } from "../types.ts";
import {
  CHUNK_UPDATE_MOVE_EPSILON,
  MAX_CONCURRENT_CHUNK_LOADS,
  MAX_RESIDENT_ATLAS_BYTES,
  MAX_RESIDENT_CHUNKS,
  RING_R0_CHUNKS,
  RING_R1_CHUNKS,
  RING_R2_CHUNKS,
} from "../config.ts";

export interface ChunkStoreStats {
  resident: number;
  loading: number;
  failed: number;
  instances: number;
  bytes: number;
  candidates: number;
  /** Chunks currently pulled into a fetching ring by a teleport destination
   * rather than by the camera (see `prioritizeTeleport`). */
  teleportPinned: number;
}

export interface ChunkStoreEvents {
  /** Fired when a chunk becomes resident or is evicted — the voxel proxy
   * layer subscribes so the chunk's flat stand-ins step aside for the real
   * thing (and come back when it is evicted), and the per-voxel controllers
   * re-apply their state to a freshly built mesh. */
  onResidencyChanged?: (chunkId: number, resident: boolean) => void;
}

interface ChunkCandidate {
  entry: ManifestChunk;
  center: THREE.Vector3;
  /** Distance from the camera in chunk-edge units. */
  distance: number;
  ring: Ring;
  priority: number;
}

/**
 * Ring-based chunk residency: decides which chunks should be on the GPU right
 * now, fetches them in priority order, and evicts the ones the camera has left
 * behind.
 *
 * Scale note: the BL num_voxels=96 pack has only 98 occupied chunks, so the
 * candidate pass below is a plain linear scan and, with the default radii,
 * nearly everything ends up resident anyway. That is fine and intentional —
 * the machinery exists for the datasets where it matters (higher num_voxels,
 * Monet), and a linear scan over a few hundred chunks is far cheaper than the
 * spatial index it would take to avoid it. The one thing that does not scale
 * is the scan itself; swap it for a chunk-grid neighbourhood walk when a pack
 * has tens of thousands of occupied chunks.
 */
export class ChunkStore {
  /** Every resident chunk mesh hangs off this group; add it to the scene. */
  readonly group = new THREE.Group();

  private readonly radii: RingRadii = {
    r0: RING_R0_CHUNKS,
    r1: RING_R1_CHUNKS,
    r2: RING_R2_CHUNKS,
  };

  private readonly resident = new Map<number, LoadedChunk>();
  private readonly loading = new Map<number, AbortController>();
  private readonly failed = new Set<number>();

  /** Chunk centers never move, so they're computed once rather than per pass. */
  private readonly centers = new Map<number, THREE.Vector3>();
  private readonly candidates: ChunkCandidate[] = [];
  private readonly lastUpdatePosition = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly forward = new THREE.Vector3();
  private readonly toChunk = new THREE.Vector3();

  private residentBytes = 0;
  private disposed = false;
  private warnedOverBudget = false;

  /** Destination of an in-flight teleport, or null. Acts as a SECOND camera
   * for ring classification while set — see `prioritizeTeleport`. */
  private teleportTarget: THREE.Vector3 | null = null;
  private teleportPinned = 0;

  constructor(
    private readonly manifest: Manifest,
    private readonly loader: ChunkLoader,
    private readonly events: ChunkStoreEvents = {},
  ) {
    this.group.name = "chunks";
    // Chunk meshes carry world-space instance positions and never move, so
    // the group's own matrix is identity forever.
    this.group.matrixAutoUpdate = false;
    for (const entry of manifest.chunks) {
      this.centers.set(entry.chunk_id, manifest.chunkCenterWorld(entry.chunk_id, new THREE.Vector3()));
    }
  }

  get meshes(): InstancedMesh2[] {
    return this.group.children as InstancedMesh2[];
  }

  get residentChunkIds(): Iterable<number> {
    return this.resident.keys();
  }

  chunk(chunkId: number): LoadedChunk | undefined {
    return this.resident.get(chunkId);
  }

  stats(): ChunkStoreStats {
    let instances = 0;
    for (const chunk of this.resident.values()) instances += chunk.mesh.instancesCount;
    return {
      resident: this.resident.size,
      loading: this.loading.size,
      failed: this.failed.size,
      instances,
      bytes: this.residentBytes,
      candidates: this.candidates.length,
      teleportPinned: this.teleportPinned,
    };
  }

  /**
   * Pins a teleport destination so its neighbourhood starts streaming NOW,
   * in parallel with the camera flight rather than after it.
   *
   * Call this *synchronously before* `Engine.teleportTo`. The mechanism is
   * deliberately not a separate fetch queue: the destination is registered as
   * a second origin for the existing ring classification, so a chunk gets the
   * better (lower) of its camera-derived and target-derived ring, and
   * target-driven chunks sort ahead of everything else within that ring. That
   * matters for correctness as much as for priority — `evictOutOfRange()`
   * aborts in-flight fetches for chunks that are not in ANY current ring, so
   * without the pin the very next `updateCamera()` pass (still at the old
   * camera position, since the flight hasn't finished) would cancel exactly
   * the fetches this is trying to start.
   *
   * The pin clears itself once the camera actually reaches the destination's
   * R0, so a teleport that is interrupted mid-flight doesn't leave a
   * permanently pinned neighbourhood behind.
   *
   * @returns how many chunks the destination pulled into a fetching ring that
   *   the camera alone would not have — i.e. the real work this saved.
   */
  prioritizeTeleport(target: THREE.Vector3, camera: THREE.Camera): number {
    if (this.disposed) return 0;
    this.teleportTarget = (this.teleportTarget ?? new THREE.Vector3()).copy(target);
    this.teleportPinned = 0;
    this.updateCamera(camera, true);
    return this.teleportPinned;
  }

  /** Drops the teleport pin (safe to call when none is set). */
  clearTeleportTarget(): void {
    this.teleportTarget = null;
    this.teleportPinned = 0;
  }

  /**
   * Re-runs ring classification for the current camera pose. Cheap to call
   * every frame — it early-outs unless the camera has actually moved a
   * meaningful distance (or a load slot just freed up).
   */
  updateCamera(camera: THREE.Camera, force = false): void {
    if (this.disposed) return;
    const position = camera.position;
    const moved = this.lastUpdatePosition.distanceToSquared(position);
    if (
      !force &&
      Number.isFinite(this.lastUpdatePosition.x) &&
      moved < CHUNK_UPDATE_MOVE_EPSILON * CHUNK_UPDATE_MOVE_EPSILON &&
      this.loading.size >= MAX_CONCURRENT_CHUNK_LOADS
    ) {
      return;
    }
    this.lastUpdatePosition.copy(position);

    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    this.classify(position);
    this.evictOutOfRange();
    this.startLoads();
    this.enforceBudget();
  }

  private classify(cameraPosition: THREE.Vector3): void {
    const chunkSize = this.manifest.chunkWorldSize;
    // A teleport destination close enough that the camera's own rings already
    // cover it isn't worth pinning; drop it so the pin can't outlive its use.
    if (this.teleportTarget && cameraPosition.distanceTo(this.teleportTarget) / chunkSize <= this.radii.r0) {
      this.clearTeleportTarget();
    }
    const target = this.teleportTarget;
    this.candidates.length = 0;
    this.teleportPinned = 0;
    for (const entry of this.manifest.chunks) {
      const center = this.centers.get(entry.chunk_id)!;
      const distance = center.distanceTo(cameraPosition) / chunkSize;
      let ring = ringFor(distance, this.radii);
      this.toChunk.subVectors(center, cameraPosition);
      if (this.toChunk.lengthSq() > 0) this.toChunk.normalize();
      let priority = chunkPriority(distance, this.toChunk, this.forward);

      if (target) {
        const targetDistance = center.distanceTo(target) / chunkSize;
        const targetRing = ringFor(targetDistance, this.radii);
        if (targetRing < ring) {
          ring = targetRing;
          // Negative priorities sort ahead of every camera-derived one (which
          // are distances, so always >= 0), ordered among themselves by
          // closeness to the destination.
          priority = targetDistance - 1000;
          if (targetRing !== Ring.Keep && !this.resident.has(entry.chunk_id)) this.teleportPinned++;
        }
      }

      this.candidates.push({ entry, center, distance, ring, priority });
    }
  }

  private evictOutOfRange(): void {
    const inRange = new Set<number>();
    for (const candidate of this.candidates) {
      if (candidate.ring !== Ring.Evict) inRange.add(candidate.entry.chunk_id);
    }
    for (const chunkId of [...this.resident.keys()]) {
      if (!inRange.has(chunkId)) this.evict(chunkId);
    }
    // Cancel in-flight fetches the camera has already left behind — a chunk
    // that is no longer wanted should not keep a connection slot busy.
    for (const [chunkId, controller] of this.loading) {
      if (!inRange.has(chunkId)) {
        controller.abort();
        this.loading.delete(chunkId);
      }
    }
  }

  private startLoads(): void {
    if (this.loading.size >= MAX_CONCURRENT_CHUNK_LOADS) return;

    const wanted = this.candidates
      .filter(
        (c) =>
          (c.ring === Ring.Load || c.ring === Ring.Prefetch) &&
          !this.resident.has(c.entry.chunk_id) &&
          !this.loading.has(c.entry.chunk_id) &&
          !this.failed.has(c.entry.chunk_id),
      )
      // R0 always beats R1, then closest/most-in-front first.
      .sort((a, b) => a.ring - b.ring || a.priority - b.priority);

    for (const candidate of wanted) {
      if (this.loading.size >= MAX_CONCURRENT_CHUNK_LOADS) break;
      void this.beginLoad(candidate.entry);
    }
  }

  private async beginLoad(entry: ManifestChunk): Promise<void> {
    const controller = new AbortController();
    this.loading.set(entry.chunk_id, controller);
    try {
      const chunk = await this.loader.load(entry, controller.signal);
      if (this.disposed || controller.signal.aborted) {
        this.loader.unload(chunk);
        return;
      }
      this.group.add(chunk.mesh);
      this.resident.set(entry.chunk_id, chunk);
      this.residentBytes += chunk.bytes;
      this.events.onResidencyChanged?.(entry.chunk_id, true);
    } catch (error) {
      if (!isAbortError(error)) {
        this.failed.add(entry.chunk_id);
        console.error(`chunk ${entry.chunk_id}: load failed`, error);
      }
    } finally {
      if (this.loading.get(entry.chunk_id) === controller) this.loading.delete(entry.chunk_id);
    }
  }

  /**
   * Enforces the count/byte caps once the ring pass is done, evicting the
   * farthest resident chunks first. Distance is the recency signal here rather
   * than a literal touch timestamp: nothing "uses" a chunk except being near
   * it, so farthest-first *is* least-recently-useful.
   *
   * Only R2 ("warm keep") chunks are eligible. Evicting an R0/R1 chunk would
   * put it straight back on the fetch list on the very next pass, so the
   * budget would thrash the network instead of freeing anything — if R0+R1
   * alone exceed the budget the honest answer is to say so and stay over,
   * which is a signal to shrink the radii or the atlas size, not to churn.
   */
  private enforceBudget(): void {
    if (this.withinBudget()) return;

    const evictable = this.candidates
      .filter((c) => c.ring === Ring.Keep && this.resident.has(c.entry.chunk_id))
      .sort((a, b) => b.distance - a.distance);

    for (const candidate of evictable) {
      if (this.withinBudget()) return;
      this.evict(candidate.entry.chunk_id);
    }

    if (!this.withinBudget() && !this.warnedOverBudget) {
      this.warnedOverBudget = true;
      console.warn(
        `[ChunkStore] over budget with nothing evictable: ${this.resident.size} chunks / ` +
          `${(this.residentBytes / (1024 * 1024)).toFixed(0)} MB are all inside R1. ` +
          `Reduce RING_R0_CHUNKS/RING_R1_CHUNKS or raise MAX_RESIDENT_ATLAS_BYTES.`,
      );
    }
  }

  private withinBudget(): boolean {
    return (
      this.resident.size <= MAX_RESIDENT_CHUNKS && this.residentBytes <= MAX_RESIDENT_ATLAS_BYTES
    );
  }

  private evict(chunkId: number): void {
    const chunk = this.resident.get(chunkId);
    if (!chunk) return;
    this.resident.delete(chunkId);
    this.residentBytes -= chunk.bytes;
    this.loader.unload(chunk);
    this.events.onResidencyChanged?.(chunkId, false);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTeleportTarget();
    for (const controller of this.loading.values()) controller.abort();
    this.loading.clear();
    for (const chunkId of [...this.resident.keys()]) this.evict(chunkId);
    this.group.removeFromParent();
  }
}
