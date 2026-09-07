import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { ChunkMeshUserData, LoadedChunk } from "../streaming/ChunkLoader.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { Inventory } from "./Inventory.ts";
import { combinedVoxelOpacity } from "../voxels/VoxelOpacity.ts";
import { extractionBatchSize } from "../config.ts";
import { PagedRecords } from "../streaming/RangeReader.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import { validateMiningSave, type MiningSave } from "./MiningSave.ts";
import { searchCollectionDescriptor } from "./SearchCollection.ts";
import type { MatchSnapshot } from "../metadata/MetadataClient.ts";
import { densityLevel } from "../voxels/DensityView.ts";

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
  /** Net extracted count. Row identities live once, in the compact inventory;
   * the posting cursor and return queue identify the next batch without scans. */
  extracted: { size: number };
  cursor: number;
  returned: Set<number>;
  /** Collected out of order, still ahead of the posting cursor. */
  selected: Set<number>;
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
  /** The final row pulled by this cycle — the inventory's large latest image. */
  lastRowId: number;
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
 * culling actually gate on). A faded voxel therefore stays hit-testable for
 * free — which is what a PARTIALLY drained voxel wants, so a hold can keep
 * draining it — and the material needs no per-chunk preparation either: voxel
 * materials are built with alpha-to-coverage on (see `createVoxelMaterial`),
 * so any mix of opaque and faded instances renders correctly in one opaque
 * draw. (Flipping the material to `transparent` lazily, as earlier phases
 * did, was what made a faded cube cut holes in the cubes behind it.)
 *
 * A FULLY drained voxel is the exception, and it is handled one layer up: the
 * raycaster (`engine/Raycast.ts`) is built with a pass-through predicate that
 * `main.ts` wires to `isFullyExtracted` here, so the cursor looks through an
 * emptied ghost and lands on whatever is behind it ("empty cubes should not
 * interact anymore, so that you can mine whats behind them"). Nothing here
 * changes for that — the record, the opacity floor and the cage's depletion
 * are exactly as they were; the voxel just stops being a hover target until a
 * point comes back from the inventory, at which moment `isFullyExtracted`
 * flips and the next cast hits it again.
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
 *   via the same `combinedVoxelOpacity()` Pickaxe glass view composes through;
 * - empty hand pulls one point per cycle; Pickaxe pulls up to 100. The tool
 *   state is injected rather than imported from the hotbar, keeping this data
 *   controller independent of the UI that selects the batch size;
 * - the per-voxel record is a real `VoxelExtraction` (see above) keyed by
 *   `${chunkId}:${localVoxelId}`, re-applied via `onChunkResident` exactly the
 *   way 3.5's boolean set was. A voxel drained 40%, evicted, and re-streamed
 *   comes back at 40% — same fraction, same specific row_ids, no double
 *   counting (the extracted set is keyed by row_id, so even a re-run of the
 *   same cycle could not double-extract a point).
 *
 * Reversal is the inventory panel's, at two granularities: `returnRow()` (one
 * thumbnail) and `returnStack()` (a whole voxel's worth). There is no 3D
 * gesture for it any more — a hold on a drained voxel used to push its stack
 * back, but a drained voxel is now pass-through to the cursor (see above), so
 * there is nothing to hold on.
 *
 * ## Cross-controller composition
 *
 * Every `setOpacityAt` write goes through `combinedVoxelOpacity()`
 * (`voxels/VoxelOpacity.ts`) rather than a bare constant, so a voxel drained
 * (or refilled) while Pickaxe is equipped lands on the correct COMBINED
 * opacity instead of silently ignoring glass view's global toggle.
 * `isXrayActive` is injected as a callback (not a direct `XRayController`
 * reference) to avoid a two-way constructor dependency — `XRayController`
 * itself needs `MiningController.extractedFraction` to do the same combination
 * in reverse. See main.ts's bootstrap-order comment.
 *
 * Phase 6.8 hangs a second readout off the very same fraction: the voxel's
 * container cage (`voxels/VoxelContainers.ts`), which dims and then fades as
 * it drains. Every place below that writes `setOpacityAt` writes
 * `containers.setExtractedFraction` beside it — one fraction, two renderings of
 * it, updated at the same four moments (extract, per-item return, per-stack
 * return, chunk becomes resident) rather than polled from the frame loop.
 */
export class MiningController {
  readonly inventory = new Inventory();

  private readonly extractionByChunk = new Map<number, Map<number, VoxelExtraction>>();
  private prepared: { key: string; cursor: number; rows: Uint32Array } | null = null;
  private preparing: string | null = null;
  private prepareToken = 0;
  private retryAt = 0;
  pagingError: string | null = null;
  private restoreEpoch = 0;
  metadataFilter: MatchSnapshot | null = null;
  filterRevision = 0;
  private matchingHeld = new Map<string, number>();
  private filterCursors = new Map<string, number>();
  private filterPage: { key: string; rows: number[]; next: number } | null = null;

  setMetadataFilter(filter: MatchSnapshot | null): void {
    this.metadataFilter = filter; this.filterRevision++;
    this.prepareToken++; this.preparing = null; this.prepared = null; this.filterPage = null;
    this.filterCursors.clear(); this.matchingHeld.clear(); this.retryAt = 0; this.pagingError = null;
    if (filter) for (const stack of this.inventory.stacks) {
      let count = 0; for (const row of stack.rowIds) if (filter.matches(row)) count++;
      this.matchingHeld.set(stack.id, count);
    }
    for (const id of this.chunkStore.residentChunkIds) this.onChunkResident(id);
  }

  matchesRow(row: number): boolean { return this.metadataFilter?.matches(row) ?? true; }
  viewCount(chunk: number, local: number): number {
    return this.metadataFilter ? this.metadataFilter.count(chunk, local) :
      this.chunkStore.chunk(chunk)?.meta.count[local] ?? this.extractionState(chunk, local)?.total ?? 0;
  }
  viewExtracted(chunk: number, local: number): number {
    return this.metadataFilter ? this.matchingHeld.get(voxelStackId(chunk, local)) ?? 0 : this.extractionState(chunk, local)?.extracted.size ?? 0;
  }
  private adjustMatching(chunk: number, local: number, rows: readonly number[], delta: number): void {
    if (!this.metadataFilter) return;
    const key = voxelStackId(chunk, local);
    this.matchingHeld.set(key, (this.matchingHeld.get(key) ?? 0) + delta * rows.filter(row => this.matchesRow(row)).length);
  }
  /** Bounded posting pages; skipped rows never advance the durable mining cursor. */
  private async matchingPage(chunkId: number, local: number, cursor: number, limit: number, valid: () => boolean): Promise<{ rows: number[]; next: number }> {
    const chunk = this.chunkStore.chunk(chunkId), filter = this.metadataFilter;
    if (!chunk || !filter) return { rows: [], next: cursor };
    const rows: number[] = [], total = chunk.meta.count[local], offset = chunk.meta.pointOffset[local];
    const table = chunk.entry.postings && this.manifest ? new PagedRecords(this.manifest.url(chunk.entry.postings.path), chunk.entry.n_points, 4) : null;
    const initial = this.extractionState(chunkId, local);
    for (const row of initial?.returned ?? []) if (filter.matches(row) && rows.length < limit) rows.push(row);
    while (cursor < total && rows.length < limit && valid()) {
      const end = Math.min(total, cursor + 100);
      const page = table ? await Promise.all(Array.from({ length: end - cursor }, (_, i) => table.record(offset + cursor + i))) : null;
      if (!valid() || this.chunkStore.chunk(chunkId) !== chunk) return { rows: [], next: cursor };
      for (let i = 0; cursor < end && rows.length < limit; i++, cursor++) {
        const row = page ? page[i].getUint32(0, true) : chunk.meta.pointIds[offset + cursor];
        if (!Number.isInteger(row) || row < 0 || (this.manifest && row >= this.manifest.totalPoints)) throw new Error("Invalid posting row");
        const state = this.extractionState(chunkId, local);
        const held = state && (state.selected.has(row) || (cursor < state.cursor && !state.returned.has(row)));
        if (filter.matches(row) && !held && !rows.includes(row)) rows.push(row);
      }
    }
    return { rows, next: cursor };
  }

  private prepareFiltered(chunk: number, local: number): void {
    const key = voxelStackId(chunk, local), revision = this.filterRevision;
    const owner = this.chunkStore.chunk(chunk);
    if (!owner) return;
    if (this.preparing === key || this.filterPage?.key === key || performance.now() < this.retryAt) return;
    const token = ++this.prepareToken; this.preparing = key;
    void this.matchingPage(chunk, local, this.filterCursors.get(key) ?? 0, 100,
      () => token === this.prepareToken && revision === this.filterRevision).then(page => {
      if (token === this.prepareToken && this.chunkStore.chunk(chunk) === owner) { this.filterPage = { key, ...page }; this.pagingError = null; }
    }).catch(error => {
      if (token === this.prepareToken) { this.pagingError = String(error); this.retryAt = performance.now() + 2000; }
    }).finally(() => { if (token === this.prepareToken) this.preparing = null; });
  }

  constructor(
    private readonly chunkStore: ChunkStore,
    private readonly isXrayActive: () => boolean = () => false,
    private readonly isPickaxeEquipped: () => boolean = () => false,
    private readonly manifest?: Manifest,
  ) {}

  snapshot(dataset: string): MiningSave {
    if (!this.manifest) throw new Error("No dataset loaded.");
    return { version: 1, dataset, pack: this.manifest.baseUrl, stacks: this.inventory.stacks.map(s => {
      const state = this.extractionState(s.chunkId, s.localVoxelId)!;
      return { id: s.id, chunkId: s.chunkId, localVoxelId: s.localVoxelId, totalPoints: s.totalPoints, reprRowId: s.reprRowId,
        rowIds: [...s.rowIds], cursor: state.cursor, returned: [...state.returned],
        ...(state.selected.size ? { selected: [...state.selected] } : {}),
        firstExtractedAt: s.firstExtractedAt, lastExtractedAt: s.lastExtractedAt };
    }) };
  }

  restore(value: unknown, dataset: string): void {
    if (!this.manifest) throw new Error("No dataset loaded.");
    const save = validateMiningSave(value, dataset, this.manifest);
    this.restoreEpoch++;
    const old = this.touchedVoxels;
    this.prepareToken++; this.prepared = null; this.preparing = null; this.retryAt = 0;
    this.extractionByChunk.clear();
    for (const s of save.stacks) {
      const state = this.stateFor(s.chunkId, s.localVoxelId, s.totalPoints);
      state.cursor = s.cursor; state.extracted.size = s.rowIds.length; state.returned = new Set(s.returned);
      state.selected = new Set(s.selected ?? []);
    }
    this.inventory.replace(save.stacks);
    this.setMetadataFilter(this.metadataFilter);
    for (const s of old) this.applyToResidentVoxel(s.chunkId, s.localVoxelId);
    for (const id of this.chunkStore.residentChunkIds) this.onChunkResident(id);
  }

  /** Only the hovered voxel's next 100 IDs are retained outside the shared page cache. */
  prepare(chunkId: number, localVoxelId: number): void {
    if (this.metadataFilter) { this.prepareFiltered(chunkId, localVoxelId); return; }
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk?.entry.postings || !this.manifest) return;
    const state = this.extractionState(chunkId, localVoxelId);
    const cursor = state?.cursor ?? 0;
    const key = `${chunkId}:${localVoxelId}:${cursor}`;
    if (this.preparing === key || (this.prepared?.key === key) || performance.now() < this.retryAt) return;
    this.preparing = key;
    const token = ++this.prepareToken;
    const total = chunk.meta.count[localVoxelId];
    const offset = chunk.meta.pointOffset[localVoxelId];
    const table = new PagedRecords(this.manifest.url(chunk.entry.postings.path), chunk.entry.n_points, 4);
    const count = Math.min(100, total - cursor);
    void Promise.all(Array.from({ length: count }, (_, i) => table.record(offset + cursor + i)))
      .then(records => {
        if (token !== this.prepareToken) return;
        const rows = Uint32Array.from(records, r => r.getUint32(0, true));
        if (rows.some(row => row >= this.manifest!.totalPoints)) throw new Error("Posting row outside points table");
        this.prepared = { key, cursor, rows };
        this.pagingError = null;
      }).catch((error: unknown) => {
        if (token !== this.prepareToken) return;
        this.pagingError = String(error);
        this.retryAt = performance.now() + 2000;
      }).finally(() => { if (token === this.prepareToken) this.preparing = null; });
  }

  /** Number of points the current tool can take from this voxel in one cycle,
   * capped to what remains. Shared with the hold gauge so prediction and the
   * completed extraction cannot drift apart. */
  batchSizeFor(total: number, extracted = 0): number {
    const remaining = Math.max(0, total - extracted);
    return Math.min(remaining, extractionBatchSize(total, this.isPickaxeEquipped()));
  }

  /** 0 (untouched) … 1 (fully drained). The single number every other system
   * — opacity, cage depletion, HUD label — reads. */
  extractedFraction(chunkId: number, localVoxelId: number): number {
    if (this.metadataFilter) return Math.min(1, this.viewExtracted(chunkId, localVoxelId) / Math.max(1, this.viewCount(chunkId, localVoxelId)));
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    if (!state || state.total === 0) return 0;
    return Math.min(1, state.extracted.size / state.total);
  }

  /** True iff every point in the voxel is currently in the inventory — the
   * raycaster's pass-through test (see the class comment), so it runs once
   * per instance the cursor's ray crosses, every frame: two map lookups. */
  isFullyExtracted(chunkId: number, localVoxelId: number): boolean {
    if (this.metadataFilter) return this.viewExtracted(chunkId, localVoxelId) >= this.viewCount(chunkId, localVoxelId);
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    return !!state && state.total > 0 && state.extracted.size >= state.total;
  }

  /** The live per-voxel record, or `undefined` for an untouched voxel.
   * Exposed for the HUD and the verification harness — treat as read-only. */
  extractionState(chunkId: number, localVoxelId: number): VoxelExtraction | undefined {
    return this.extractionByChunk.get(chunkId)?.get(localVoxelId);
  }

  /** First row still inside a resident voxel, in pack order. This is the
   * source of truth for the focused high-resolution face shown during a hold,
   * so the image advances immediately after every extraction batch. */
  nextRowId(chunkId: number, localVoxelId: number): number | null {
    if (this.metadataFilter) {
      this.prepareFiltered(chunkId, localVoxelId);
      return this.filterPage?.key === voxelStackId(chunkId, localVoxelId) ? this.filterPage.rows[0] ?? null : null;
    }
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return null;
    const total = chunk.meta.count[localVoxelId] ?? 0;
    if (total <= 0) return null;
    const state = this.extractionState(chunkId, localVoxelId);
    const returned = state?.returned.values().next().value;
    if (returned !== undefined) return returned;
    const cursor = state?.cursor ?? 0;
    if (cursor >= total) return null;
    if (chunk.entry.postings) {
      this.prepare(chunkId, localVoxelId);
      return this.prepared?.key === `${chunkId}:${localVoxelId}:${cursor}`
        ? this.prepared.rows.find(row => !state?.selected.has(row)) ?? null : null;
    }
    const offset = chunk.meta.pointOffset[localVoxelId];
    for (let i = cursor; i < total; i++) if (!state?.selected.has(chunk.meta.pointIds[offset + i])) return chunk.meta.pointIds[offset + i];
    return null;
  }

  /** Independent one-row lookup for the sharp-band cache. Never changes the
   * single focused mining-page cursor/preparation token. RangeReader shares
   * and bounds the posting pages underneath both callers. */
  async previewRowId(chunkId: number, localVoxelId: number): Promise<number | null> {
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return null;
    if (this.metadataFilter) {
      const revision = this.filterRevision, epoch = this.restoreEpoch;
      const repr = chunk.meta.reprRowId[localVoxelId];
      const stack = this.inventory.stack(voxelStackId(chunkId, localVoxelId));
      if (this.matchesRow(repr) && (!stack || stack.rowIds.indexOf(repr) < 0)) return repr;
      const page = await this.matchingPage(chunkId, localVoxelId, this.filterCursors.get(voxelStackId(chunkId, localVoxelId)) ?? 0, 1,
        () => revision === this.filterRevision && epoch === this.restoreEpoch);
      return revision === this.filterRevision && epoch === this.restoreEpoch ? page.rows[0] ?? null : null;
    }
    const state = this.extractionState(chunkId, localVoxelId);
    const returned = state?.returned.values().next().value;
    if (returned !== undefined) return returned;
    const cursor = state?.cursor ?? 0;
    if (cursor >= (chunk.meta.count[localVoxelId] ?? 0)) return null;
    // Atlases use the point nearest the voxel centre, not the first row in
    // the sorted postings list. Hover/sharp-band must sharpen THAT image
    // until mining starts; after mining, preview the next remaining row.
    if (cursor === 0 && !state?.selected.has(chunk.meta.reprRowId[localVoxelId])) {
      const representative = chunk.meta.reprRowId[localVoxelId];
      return Number.isSafeInteger(representative) && (!this.manifest || representative < this.manifest.totalPoints)
        ? representative : null;
    }
    let offset = chunk.meta.pointOffset[localVoxelId] + cursor;
    let row: number;
    if (chunk.entry.postings && this.manifest) {
      const records = new PagedRecords(this.manifest.url(chunk.entry.postings.path), chunk.entry.n_points, 4);
      const end = chunk.meta.pointOffset[localVoxelId] + chunk.meta.count[localVoxelId];
      do { row = (await records.record(offset++)).getUint32(0, true); }
      while (state?.selected.has(row) && offset < end);
    } else {
      do { row = chunk.meta.pointIds[offset++]; } while (state?.selected.has(row));
    }
    if (this.chunkStore.chunk(chunkId) !== chunk ||
      (this.extractionState(chunkId, localVoxelId)?.cursor ?? 0) !== cursor ||
      !Number.isSafeInteger(row) || state?.selected.has(row) || (this.manifest && row >= this.manifest.totalPoints)) return null;
    return row;
  }

  /** Every voxel this session has touched and not fully returned. */
  get touchedVoxels(): VoxelExtraction[] {
    const all: VoxelExtraction[] = [];
    for (const byVoxel of this.extractionByChunk.values()) for (const state of byVoxel.values()) all.push(state);
    return all;
  }

  async collectSearchResult(chunkId: number, localVoxelId: number, rowId: number, cancelled = () => false): Promise<string> {
    if (!this.manifest || cancelled()) throw new Error("Map is not available");
    const epoch = this.restoreEpoch;
    const descriptor = await searchCollectionDescriptor(this.manifest, chunkId, localVoxelId, rowId);
    if (cancelled() || epoch !== this.restoreEpoch) throw new Error("Collection cancelled because the map or inventory changed");
    if (!this.matchesRow(rowId)) throw new Error("This image is excluded by the active filter");
    // Resolve current state AFTER awaiting: concurrent clicks and mining may
    // have collected this row while the small identity reads were in flight.
    const stack = this.inventory.stack(descriptor.id);
    if (stack && stack.rowIds.indexOf(rowId) >= 0) return descriptor.id;
    const state = this.stateFor(chunkId, localVoxelId, descriptor.totalPoints);
    if (!state.returned.delete(rowId)) state.selected.add(rowId);
    state.extracted.size++;
    this.adjustMatching(chunkId, localVoxelId, [rowId], 1);
    this.prepareToken++; this.preparing = null; this.filterPage = null;
    this.inventory.extractInto(descriptor, [rowId]);
    this.applyToResidentVoxel(chunkId, localVoxelId);
    return descriptor.id;
  }

  /**
   * Runs ONE extraction cycle against whatever the current raycast hit points
   * at. Returns the cycle's result, or `null` if nothing was extracted.
   *
   * Silently no-ops for a null hit, a hit against something that isn't a
   * chunk-voxel mesh (the Phase 1 `?synthetic=1` field has no `chunkId` in its
   * userData), a voxel whose chunk isn't resident, or a voxel that is already
   * fully drained. The raycaster can no longer hand this a drained voxel (it
   * passes through them), but the check is what makes that true rather than
   * merely usual: the verification harness calls this directly with a
   * synthetic hit, and so could any future caller.
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
    if (this.metadataFilter) return this.extractFiltered(chunkId, localVoxelId, chunk, state);
    if (state.extracted.size >= state.total) return null;

    const batch = this.batchSizeFor(state.total, state.extracted.size);
    const offset = chunk.meta.pointOffset[localVoxelId];
    const taken: number[] = [];
    // Returned IDs are mined first, then the monotonic posting cursor.
    // A cold page yields null without mutating either source of truth.
    const prepared = this.prepared?.key === `${chunkId}:${localVoxelId}:${state.cursor}` ? this.prepared : null;
    if (chunk.entry.postings && !prepared && state.returned.size === 0) {
      this.prepare(chunkId, localVoxelId);
      return null;
    }
    for (const rowId of state.returned) {
      if (taken.length >= batch) break;
      state.returned.delete(rowId);
      state.extracted.size++;
      taken.push(rowId);
    }
    const startCursor = state.cursor;
    while (state.cursor < total && taken.length < batch) {
      const rowId = chunk.entry.postings
        ? prepared?.rows[state.cursor - startCursor]
        : chunk.meta.pointIds[offset + state.cursor];
      if (rowId === undefined) break;
      state.cursor++;
      if (state.selected.delete(rowId)) continue;
      state.extracted.size++;
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

    hit.mesh.setOpacityAt(
      hit.instanceId,
      combinedVoxelOpacity(state.extracted.size / state.total, this.isXrayActive()),
    );
    // The cage's depletion is driven off the SAME fraction as the cube's fade
    // (see `voxels/VoxelContainers.ts`), so it is updated here rather than
    // polled: there is no other way for a voxel's extraction state to change.
    chunk.containers.setExtractedFraction(hit.instanceId, state.extracted.size / state.total);

    return {
      chunkId,
      localVoxelId,
      stackId,
      rowIds: taken,
      leadRowId: taken[0],
      lastRowId: taken[taken.length - 1],
      extractedCount: state.extracted.size,
      total: state.total,
      fraction: state.extracted.size / state.total,
      complete: state.extracted.size >= state.total,
    };
  }

  /**
   * Sends ONE specific point back into its source voxel, from the inventory
   * panel. Returns `true` iff that row was actually extracted from that stack.
   *
   * Works whether or not the voxel's chunk is currently resident: the
   * authoritative state is the extracted set here, and the visual (opacity)
   * is re-derived either immediately (resident) or on the next
   * `onChunkResident` (not resident). Returning one point to a fully drained
   * voxel is also what makes it a hover target again — `isFullyExtracted`
   * goes false the moment the set shrinks.
   */
  returnRow(stackId: string, rowId: number): boolean {
    const stack = this.inventory.stack(stackId);
    if (!stack) return false;
    const { chunkId, localVoxelId } = stack;
    const state = this.extractionByChunk.get(chunkId)?.get(localVoxelId);
    if (!state || !this.inventory.returnRow(stackId, rowId)) return false;
    state.extracted.size--;
    this.adjustMatching(chunkId, localVoxelId, [rowId], -1);
    this.filterCursors.delete(stackId); this.filterPage = null; this.prepareToken++; this.preparing = null;
    if (!state.selected.delete(rowId)) state.returned.add(rowId);
    if (state.extracted.size === 0) this.clearState(chunkId, localVoxelId);
    this.applyToResidentVoxel(chunkId, localVoxelId);
    return true;
  }

  /**
   * Sends an entire stack back into its source voxel, from the inventory panel
   * — the only way to undo a drain (partial or complete) in one action. The
   * per-voxel record is dropped outright (so eviction/reload doesn't resurrect
   * a drained state) and the opacity/cage go back to normal in one write —
   * NOT to a bare `1`: `applyToResidentVoxel` composes through
   * `combinedVoxelOpacity`, so if Pickaxe is still equipped the refilled voxel
   * lands back on `XRAY_OPACITY` rather than snapping opaque.
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
    this.matchingHeld.delete(stackId); this.filterCursors.delete(stackId); this.filterPage = null; this.prepareToken++; this.preparing = null;
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
    const chunk = this.chunkStore.chunk(chunkId);
    if (!chunk) return;

    const xrayActive = this.isXrayActive();
    const occupied = chunk.meta.occupied;
    for (let instanceId = 0; instanceId < occupied.length; instanceId++) {
      const local = occupied[instanceId];
      chunk.mesh.setUniformAt(instanceId, "atlasAllowed", this.matchesRow(chunk.meta.reprRowId[local]) ? 1 : 0);
      chunk.mesh.setUniformAt(instanceId, "densityLevel", densityLevel(this.viewCount(chunkId, local)));
      const state = byVoxel?.get(local);
      const fraction = this.metadataFilter ? this.extractedFraction(chunkId, local) : state ? state.extracted.size / state.total : 0;
      chunk.mesh.setOpacityAt(
        instanceId,
        combinedVoxelOpacity(fraction, xrayActive),
      );
      // A reloaded chunk's cages are rebuilt full, so re-draining exactly to
      // this voxel's fraction is all that's needed to make the depletion as
      // persistent across an evict/reload as the fade it accompanies.
      chunk.containers.setExtractedFraction(instanceId, fraction);
    }
  }

  private extractFiltered(chunkId: number, local: number, chunk: LoadedChunk, state: VoxelExtraction): ExtractionCycle | null {
    const key = voxelStackId(chunkId, local), page = this.filterPage;
    if (this.isFullyExtracted(chunkId, local)) return null;
    if (page?.key !== key) { this.prepareFiltered(chunkId, local); return null; }
    const batch = this.batchSizeFor(this.viewCount(chunkId, local), this.viewExtracted(chunkId, local));
    const rows = page.rows.splice(0, batch);
    if (!page.rows.length) { this.filterCursors.set(key, page.next); this.filterPage = null; }
    if (!rows.length) return null;
    for (const row of rows) { if (!state.returned.delete(row)) state.selected.add(row); state.extracted.size++; }
    this.adjustMatching(chunkId, local, rows, 1);
    this.inventory.extractInto({ id: key, chunkId, localVoxelId: local, totalPoints: state.total, reprRowId: chunk.meta.reprRowId[local] }, rows);
    this.applyToResidentVoxel(chunkId, local);
    const total = this.viewCount(chunkId, local), extracted = this.viewExtracted(chunkId, local);
    return { chunkId, localVoxelId: local, stackId: key, rowIds: rows, leadRowId: rows[0], lastRowId: rows[rows.length - 1],
      extractedCount: extracted, total, fraction: extracted / total, complete: extracted >= total };
  }

  private stateFor(chunkId: number, localVoxelId: number, total: number): VoxelExtraction {
    let byVoxel = this.extractionByChunk.get(chunkId);
    if (!byVoxel) {
      byVoxel = new Map();
      this.extractionByChunk.set(chunkId, byVoxel);
    }
    let state = byVoxel.get(localVoxelId);
    if (!state) {
      state = { chunkId, localVoxelId, total, extracted: { size: 0 }, cursor: 0, returned: new Set(), selected: new Set() };
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
    chunk.mesh.setOpacityAt(
      instanceId,
      combinedVoxelOpacity(this.extractedFraction(chunkId, localVoxelId), this.isXrayActive()),
    );
    chunk.containers.setExtractedFraction(instanceId, this.extractedFraction(chunkId, localVoxelId));
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
