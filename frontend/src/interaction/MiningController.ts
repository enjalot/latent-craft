import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { ChunkMeshUserData, LoadedChunk } from "../streaming/ChunkLoader.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { Inventory } from "./Inventory.ts";
import { combinedVoxelOpacity, ensureTransparentMaterial } from "../voxels/VoxelOpacity.ts";
import { extractionBatchSize } from "../config.ts";

export function voxelStackId(chunkId: number, localVoxelId: number): string {
  return `${chunkId}:${localVoxelId}`;
}

/**
 * Everything this controller remembers about one partially- or fully-drained
 * voxel. Lives here rather than on the chunk mesh for the same reason Phase
 * 3.5's boolean did: a chunk's `InstancedMesh2` is disposed on eviction and
 * rebuilt from scratch on reload, so any state that must survive that cannot
 * live on it.
 */
export interface VoxelExtraction {
  chunkId: number;
  localVoxelId: number;
  /** Points in the voxel, extracted or not (from `meta.bin`'s `count`). */
  total: number;
  /**
   * The row_ids currently OUT of this voxel — the actual ids, not a count.
   *
   * A count would be enough to drive the fade, and nothing else. It is not
   * enough to (a) pick the NEXT batch without re-extracting points already in
   * the inventory, (b) put one specific point back from the inventory panel,
   * or (c) survive an evict/reload and still agree with the inventory stack
   * about which points are where. All three are Phase 6.5 requirements, so the
   * set is the real state and the count/fraction are derived from it.
   */
  extracted: Set<number>;
}

/** What one completed extraction cycle produced — enough for the caller to
 * drive the fly-to-inventory animation and the HUD without re-deriving any
 * of it. */
export interface ExtractionCycle {
  chunkId: number;
  localVoxelId: number;
  stackId: string;
  /** The row_ids pulled out by THIS cycle (length ≤ `extractionBatchSize`). */
  rowIds: number[];
  /** A representative of this batch, for the flight animation's thumbnail. */
  leadRowId: number;
  extractedCount: number;
  total: number;
  /** `extractedCount / total`, 0..1. */
  fraction: number;
  /** True iff this cycle emptied the voxel. */
  complete: boolean;
}

/**
 * Turns a raycast hit into progressive extraction — and back again.
 *
 * ## Phase 3.5's finding, still the foundation
 *
 * Mining originally called `InstancedMesh2.setVisibilityAt(id, false)`, which
 * — per Phase 3's own documented finding — makes an instance BOTH invisible
 * AND un-raycastable in one call. That's wrong for a block you must be able to
 * find again, so 3.5 moved to `InstancedMesh2`'s first-class per-instance
 * opacity channel (`setOpacityAt`/`getOpacityAt`, backed by `colorsTexture`),
 * which does NOT touch `getActiveAndVisibilityAt` (what raycasting and frustum
 * culling actually gate on). A faded voxel therefore stays fully hit-testable
 * for free. The one thing that needs doing manually:
 * `MeshStandardMaterial` defaults to `transparent: false`, so opacity < 1 would
 * otherwise render fully opaque — `ensureTransparentMaterial()` flips that on
 * lazily, once per chunk material.
 *
 * ## Phase 6.5: continuous extraction, not one-shot mining
 *
 * Holding a voxel used to move its entire point list into the inventory in one
 * action and flip a per-voxel boolean. It now runs an `EXTRACTION_CYCLE_MS`
 * timer repeatedly for as long as the button is held (the timer itself lives
 * in `main.ts`'s frame loop, which is the only place with a `dt`), and each
 * completed cycle calls `extract()` here to pull ONE BATCH out. So:
 *
 * - a voxel's state is a FRACTION (0 = untouched … 1 = fully drained), not a
 *   boolean, and its opacity is `lerp(1, EXTRACTION_FLOOR_OPACITY, fraction)`
 *   via the same `combinedVoxelOpacity()` X-Ray composes through;
 * - each cycle pulls exactly ONE point (`config.ts#extractionBatchSize` is
 *   always 1, by deliberate design — "human scale interface to this large
 *   dataset" — not a batch scaled to the voxel's size, which an earlier pass
 *   at this used), so draining a several-thousand-point voxel one hold at a
 *   time genuinely takes a long time. That's intended, not a bug;
 * - the per-voxel record is a real `VoxelExtraction` (see above) keyed by
 *   `${chunkId}:${localVoxelId}`, re-applied via `onChunkResident` exactly the
 *   way 3.5's boolean set was. A voxel drained 40%, evicted, and re-streamed
 *   comes back at 40% — same fraction, same specific row_ids, no double
 *   counting (the extracted set is keyed by row_id, so even a re-run of the
 *   same cycle could not double-extract a point).
 *
 * Reversal exists at two granularities and they share one path
 * (`returnRows`): `restoreAll()` (hold on a fully-drained voxel) and
 * `returnRow()` (one thumbnail in the inventory panel).
 *
 * ## Cross-controller composition
 *
 * Every `setOpacityAt` write goes through `combinedVoxelOpacity()`
 * (`voxels/VoxelOpacity.ts`) rather than a bare constant, so a voxel drained
 * (or refilled) while the "X-Ray" hotbar item is equipped lands on the correct
 * COMBINED opacity instead of silently ignoring X-Ray's global toggle.
 * `isXrayActive` is injected as a callback (not a direct `XRayController`
 * reference) to avoid a two-way constructor dependency — `XRayController`
 * itself needs `MiningController.extractedFraction` to do the same combination
 * in reverse. See main.ts's bootstrap-order comment.
 *
 * Phase 6.7 hangs a second readout off the very same fraction: the voxel's
 * greeble layer (`voxels/VoxelGreebles.ts`), whose pieces break off as it
 * drains. Every place below that writes `setOpacityAt` writes
 * `greebles.setExtractedFraction` beside it — one fraction, two renderings of
 * it, updated at the same four moments (extract, restore-all, per-item return,
 * chunk becomes resident) rather than polled from the frame loop.
 */
export class MiningController {
  readonly inventory = new Inventory();

  private readonly extractionByChunk = new Map<number, Map<number, VoxelExtraction>>();

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly isXrayActive: () => boolean = () => false,
  ) {}

  /** 0 (untouched) … 1 (fully drained). The single number every other system
   * — opacity, cursor style, hold-ring color, HUD label — reads. */
  extractedFraction(chunkId: number, localVoxelId: number): number {
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    if (!state || state.total === 0) return 0;
    return Math.min(1, state.extracted.size / state.total);
  }

  /** True iff every point in the voxel is currently in the inventory. */
  isFullyExtracted(chunkId: number, localVoxelId: number): boolean {
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    return !!state && state.total > 0 && state.extracted.size >= state.total;
  }

  /** The live per-voxel record, or `undefined` for an untouched voxel.
   * Exposed for the HUD and the verification harness — treat as read-only. */
  extractionState(chunkId: number, localVoxelId: number): VoxelExtraction | undefined {
    return this.extractionByChunk.get(chunkId)?.get(localVoxelId);
  }

  /** Every voxel this session has touched and not fully returned. */
  get touchedVoxels(): VoxelExtraction[] {
    const all: VoxelExtraction[] = [];
    for (const byVoxel of this.extractionByChunk.values()) all.push(...byVoxel.values());
    return all;
  }

  /**
   * Runs ONE extraction cycle against whatever the current raycast hit points
   * at. Returns the cycle's result, or `null` if nothing was extracted.
   *
   * Silently no-ops for a null hit, a hit against something that isn't a
   * chunk-voxel mesh (the Phase 1 `?synthetic=1` field has no `chunkId` in its
   * userData), a voxel whose chunk isn't resident, or a voxel that is already
   * fully drained — a drained voxel stays raycastable, so that last check is
   * load-bearing, not defensive.
   */
  extract(hit: VoxelHit | null): ExtractionCycle | null {
    if (!hit) return null;
    const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
    if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return null;

    const chunkId = userData.chunkId;
    const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
    if (localVoxelId === undefined) return null;

    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return null;

    const total = chunk.meta.count[localVoxelId];
    if (total === 0) return null;

    const state = this.stateFor(chunkId, localVoxelId, total);
    if (state.extracted.size >= state.total) return null;

    const batch = extractionBatchSize(state.total);
    const offset = chunk.meta.pointOffset[localVoxelId];
    const taken: number[] = [];
    // Scan the voxel's own point list in file order and take the first `batch`
    // row_ids that aren't already out. Deliberately a scan rather than a stored
    // cursor: returns from the inventory can put arbitrary points back at any
    // time, which a monotonic cursor would either skip over or re-extract. The
    // scan is O(points in this voxel) — under a millisecond even for BL's
    // densest 7,098-point voxel, and it runs at most twice a second.
    for (let i = 0; i < total && taken.length < batch; i++) {
      const rowId = chunk.meta.pointIds[offset + i];
      if (state.extracted.has(rowId)) continue;
      state.extracted.add(rowId);
      taken.push(rowId);
    }
    if (taken.length === 0) return null;

    const stackId = voxelStackId(chunkId, localVoxelId);
    this.inventory.extractInto(
      {
        id: stackId,
        chunkId,
        localVoxelId,
        totalPoints: state.total,
        reprRowId: chunk.meta.reprRowId[localVoxelId],
      },
      taken,
    );

    ensureTransparentMaterial(hit.mesh);
    hit.mesh.setOpacityAt(
      hit.instanceId,
      combinedVoxelOpacity(state.extracted.size / state.total, this.isXrayActive()),
    );
    // The voxel's edge detail is driven off the SAME fraction as its fade (see
    // `voxels/VoxelGreebles.ts`), so it is updated here rather than polled:
    // there is no other way for a voxel's extraction state to change.
    chunk.greebles?.setExtractedFraction(hit.instanceId, state.extracted.size / state.total);

    return {
      chunkId,
      localVoxelId,
      stackId,
      rowIds: taken,
      leadRowId: taken[0],
      extractedCount: state.extracted.size,
      total: state.total,
      fraction: state.extracted.size / state.total,
      complete: state.extracted.size >= state.total,
    };
  }

  /**
   * Pushes a fully-drained voxel's ENTIRE stack back into it: opacity back to
   * normal, the per-voxel record dropped (so eviction/reload doesn't resurrect
   * a drained state), and its inventory stack removed. Returns `true` iff a
   * voxel was actually restored.
   *
   * Deliberately gated on FULLY drained rather than "partially drained too":
   * the same gesture (hold) means "keep extracting" on a partially drained
   * voxel, so allowing bulk-restore there would make one hold ambiguous. The
   * inventory panel's per-item and per-stack returns cover the partial case
   * without needing a second 3D binding.
   */
  restoreAll(hit: VoxelHit | null): boolean {
    if (!hit) return false;
    const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
    if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return false;

    const chunkId = userData.chunkId;
    const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
    if (localVoxelId === undefined || !this.isFullyExtracted(chunkId, localVoxelId)) return false;

    this.clearState(chunkId, localVoxelId);
    // NOT a bare `1` — if X-Ray is still equipped, a restored voxel must land
    // back on XRAY_OPACITY (still see-through, per that item's global effect),
    // not snap to fully opaque just because its extraction state cleared.
    hit.mesh.setOpacityAt(hit.instanceId, combinedVoxelOpacity(0, this.isXrayActive()));
    // Fraction 0 == every broken-off greeble reattaches, in one write.
    this.chunkStore.chunk(chunkId)?.greebles?.setExtractedFraction(hit.instanceId, 0);
    this.inventory.removeStack(voxelStackId(chunkId, localVoxelId));
    return true;
  }

  /**
   * Sends ONE specific point back into its source voxel, from the inventory
   * panel. Returns `true` iff that row was actually extracted from that stack.
   *
   * Works whether or not the voxel's chunk is currently resident: the
   * authoritative state is the extracted set here, and the visual (opacity)
   * is re-derived either immediately (resident) or on the next
   * `onChunkResident` (not resident).
   */
  returnRow(stackId: string, rowId: number): boolean {
    const stack = this.inventory.stack(stackId);
    if (!stack) return false;
    const { chunkId, localVoxelId } = stack;
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    if (!state?.extracted.delete(rowId)) return false;

    this.inventory.returnRow(stackId, rowId);
    if (state.extracted.size === 0) this.clearState(chunkId, localVoxelId);
    this.applyToResidentVoxel(chunkId, localVoxelId);
    return true;
  }

  /**
   * Sends an entire stack back into its source voxel, from the inventory panel
   * — the partial-drain counterpart to `restoreAll`'s hold gesture (that one
   * only offers itself once a voxel is completely drained, so this is the only
   * way to undo a half-drain in one action).
   *
   * Deliberately NOT a loop over `returnRow`: both the extracted `Set` and the
   * stack's `rowIds` array would be walked per point, and a 7,098-point
   * stack would make that ~2.8e10 operations — a hung tab. Clearing the whole
   * state and dropping the whole stack is O(1) bookkeeping for the same
   * outcome.
   */
  returnStack(stackId: string): boolean {
    const stack = this.inventory.stack(stackId);
    if (!stack) return false;
    const { chunkId, localVoxelId } = stack;
    if (!this.extractionByChunk.get(chunkId)?.has(localVoxelId)) return false;

    this.clearState(chunkId, localVoxelId);
    this.inventory.removeStack(stackId);
    this.applyToResidentVoxel(chunkId, localVoxelId);
    return true;
  }

  /**
   * Called (via `ChunkStore`'s `onResidencyChanged` hook) whenever a chunk
   * becomes resident. Re-applies extraction-derived opacity to every voxel in
   * it this session has drained — fully-returned voxels are, by construction,
   * no longer tracked (see `clearState`), so they correctly come back normal
   * rather than stuck faded.
   *
   * `chunk.meta.occupied[instanceId] === localVoxelId` is the same identity
   * `ChunkLoader.load`'s `addInstances` loop relies on (instance ids are
   * assigned in ascending-`occupied`-index order), so scanning it once inverts
   * instanceId↔localVoxelId without a persistent side table. Only done when
   * this chunk actually has drained voxels to reapply.
   */
  onChunkResident(chunkId: number): void {
    const byVoxel = this.extractionByChunk.get(chunkId);
    if (!byVoxel || byVoxel.size === 0) return;
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;

    ensureTransparentMaterial(chunk.mesh);
    const xrayActive = this.isXrayActive();
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      const state = byVoxel.get(occupied[instanceId]);
      if (!state) continue;
      chunk.mesh.setOpacityAt(
        instanceId,
        combinedVoxelOpacity(state.extracted.size / state.total, xrayActive),
      );
      // A reloaded chunk's greebles are rebuilt intact (and deterministically —
      // same seed, same pieces in the same places), so re-breaking exactly the
      // ones this voxel's fraction calls for is all that's needed to make the
      // layer as persistent across an evict/reload as the fade it accompanies.
      chunk.greebles?.setExtractedFraction(instanceId, state.extracted.size / state.total);
    }
  }

  private stateFor(chunkId: number, localVoxelId: number, total: number): VoxelExtraction {
    let byVoxel = this.extractionByChunk.get(chunkId);
    if (!byVoxel) {
      byVoxel = new Map();
      this.extractionByChunk.set(chunkId, byVoxel);
    }
    let state = byVoxel.get(localVoxelId);
    if (!state) {
      state = { chunkId, localVoxelId, total, extracted: new Set() };
      byVoxel.set(localVoxelId, state);
    }
    return state;
  }

  private clearState(chunkId: number, localVoxelId: number): void {
    const byVoxel = this.extractionByChunk.get(chunkId);
    if (!byVoxel) return;
    byVoxel.delete(localVoxelId);
    if (byVoxel.size === 0) this.extractionByChunk.delete(chunkId);
  }

  /** Re-derives one voxel's opacity from its current state, if its chunk
   * happens to be resident. A no-op otherwise — `onChunkResident` will do it
   * when the chunk comes back. */
  private applyToResidentVoxel(chunkId: number, localVoxelId: number): void {
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;
    const instanceId = instanceIdOf(chunk, localVoxelId);
    if (instanceId < 0) return;
    ensureTransparentMaterial(chunk.mesh);
    chunk.mesh.setOpacityAt(
      instanceId,
      combinedVoxelOpacity(this.extractedFraction(chunkId, localVoxelId), this.isXrayActive()),
    );
    chunk.greebles?.setExtractedFraction(instanceId, this.extractedFraction(chunkId, localVoxelId));
  }
}

/**
 * instanceId for a localVoxelId within a loaded chunk, or -1.
 *
 * `meta.occupied` is built by scanning voxel records in ascending index order
 * (`ChunkLoader.parseChunkMeta`), so it is sorted — a binary search is exact,
 * not a heuristic. Worth it over `indexOf`: this runs once per returned point,
 * and a chunk can carry up to 4,096 occupied voxels.
 */
function instanceIdOf(chunk: LoadedChunk, localVoxelId: number): number {
  const occupied = chunk.meta.occupied;
  let lo = 0;
  let hi = occupied.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = occupied[mid];
    if (value === localVoxelId) return mid;
    if (value < localVoxelId) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
