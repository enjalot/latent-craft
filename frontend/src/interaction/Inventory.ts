import { Store } from "../ui/store.ts";
import { ChunkedRows } from "./ChunkedRows.ts";
import type { SavedStack } from "./MiningSave.ts";

/**
 * One source voxel's worth of EXTRACTED points.
 *
 * Phase 6.5 changed what this represents. Phase 3/3.5's stack was a permanent
 * snapshot of an entire voxel, created whole at mine time and only ever
 * deleted; extraction is continuous, so a stack now accumulates over multiple
 * cycles and can shrink again point-by-point when items are returned. Two
 * consequences a reader should not be surprised by:
 *
 * 1. `rowIds` owns append-friendly 4K u32 pages, independent of render chunks
 *    and network caches. A return compacts one page, not the whole inventory.
 * 2. **The stack OBJECT identity is stable for the life of the stack.** The
 *    panel builds one DOM row per stack and holds a reference to the stack in
 *    that row's closures, so mutation-in-place + a `revision` bump is what
 *    keeps an already-expanded row's loaded thumbnails alive across an
 *    extraction cycle. Only the store's ARRAY is replaced, to fire listeners.
 */
export interface InventoryStack {
  /** `${chunkId}:${localVoxelId}` — stable and unique per source voxel. */
  id: string;
  chunkId: number;
  localVoxelId: number;
  /** Owned, mutable list of every row_id currently extracted (i.e. currently
   * OUT of the voxel and in this stack), in extraction order. */
  rowIds: ChunkedRows;
  /** How many points the SOURCE VOXEL holds in total, extracted or not — the
   * denominator for "3,412 / 7,098 pts" and for the voxel's fade. */
  totalPoints: number;
  /** The voxel's representative point — used for the stack's own thumbnail,
   * and as the minimap's 2D handle when this row is hovered (see
   * `MinimapBridge.highlightVoxel`). Independent of which points happen to be
   * extracted, so it stays valid for a stack of any size. */
  reprRowId: number;
  firstExtractedAt: number;
  lastExtractedAt: number;
  /** Bumped on every mutation. The panel's per-row update path uses it to skip
   * re-rendering rows that didn't change when some OTHER stack did. */
  revision: number;
}

/** Everything needed to open a new stack, minus the points themselves. */
export interface StackDescriptor {
  id: string;
  chunkId: number;
  localVoxelId: number;
  totalPoints: number;
  reprRowId: number;
}

/** Extracted-point stacks, newest source voxel first, backed by a `Store` so
 * `InventoryPanel` can subscribe rather than being hand-wired to every
 * extraction event. */
export class Inventory {
  readonly store = new Store<InventoryStack[]>([]);

  private readonly byId = new Map<string, InventoryStack>();

  replace(stacks: readonly SavedStack[]): void {
    const next = stacks.map(s => {
      const rowIds = new ChunkedRows();
      for (const row of s.rowIds) rowIds.push(row);
      return { id: s.id, chunkId: s.chunkId, localVoxelId: s.localVoxelId, totalPoints: s.totalPoints,
        reprRowId: s.reprRowId, firstExtractedAt: s.firstExtractedAt, lastExtractedAt: s.lastExtractedAt, rowIds, revision: 1 };
    });
    this.byId.clear();
    for (const s of next) this.byId.set(s.id, s);
    this.store.set(next);
  }

  stack(id: string): InventoryStack | undefined {
    return this.byId.get(id);
  }

  /**
   * Adds one extraction cycle's worth of points to the stack for `descriptor`,
   * creating that stack if this is the voxel's first cycle.
   *
   * A stack that already exists keeps its POSITION in the list rather than
   * jumping to the front on every cycle — a row that reordered itself ten
   * times during one hold would slide out from under the cursor of anyone
   * trying to interact with it mid-drain.
   */
  extractInto(descriptor: StackDescriptor, rowIds: readonly number[]): InventoryStack {
    const now = Date.now();
    let stack = this.byId.get(descriptor.id);
    if (stack) {
      // A plain loop, not `push(...rowIds)`: Pickaxe currently supplies 100,
      // and future bulk tools or much denser datasets could make that batch
      // large enough to exceed an engine's argument-count limit.
      for (const rowId of rowIds) stack.rowIds.push(rowId);
      stack.totalPoints = descriptor.totalPoints;
      stack.lastExtractedAt = now;
      stack.revision++;
      // Same array contents, new array identity: the store's listeners fire on
      // `set`, and the panel diffs by stack id, so this is how an in-place
      // mutation gets published without disturbing row order.
      this.store.set((prev) => [...prev]);
      return stack;
    }
    stack = {
      id: descriptor.id,
      chunkId: descriptor.chunkId,
      localVoxelId: descriptor.localVoxelId,
      rowIds: new ChunkedRows(),
      totalPoints: descriptor.totalPoints,
      reprRowId: descriptor.reprRowId,
      firstExtractedAt: now,
      lastExtractedAt: now,
      revision: 1,
    };
    for (const rowId of rowIds) stack.rowIds.push(rowId);
    this.byId.set(stack.id, stack);
    this.store.set((prev) => [stack!, ...prev]);
    return stack;
  }

  /**
   * Removes ONE row_id from a stack (the inventory side of "send this point
   * back into its voxel"). Returns `true` iff the row was actually in that
   * stack — callers use that to decide whether to touch the voxel's opacity.
   *
   * A stack that empties out disappears from the list, mirroring how an
   * inventory that never held anything renders: there is no such thing as a
   * zero-point stack on screen.
   */
  returnRow(id: string, rowId: number): boolean {
    const stack = this.byId.get(id);
    if (!stack) return false;
    if (!stack.rowIds.remove(rowId)) return false;
    stack.revision++;
    if (stack.rowIds.length === 0) {
      this.removeStack(id);
      return true;
    }
    this.store.set((prev) => [...prev]);
    return true;
  }

  /** Removes a stack outright (a whole voxel's worth going back at once, see
   * `MiningController.returnStack`) — a no-op if the id isn't present, so
   * callers don't need to check first. */
  removeStack(id: string): void {
    if (!this.byId.delete(id)) return;
    this.store.set((prev) => prev.filter((stack) => stack.id !== id));
  }

  get stacks(): InventoryStack[] {
    return this.store.get();
  }

  get totalPoints(): number {
    let total = 0;
    for (const stack of this.stacks) total += stack.rowIds.length;
    return total;
  }
}
