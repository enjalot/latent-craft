import { Store } from "../ui/store.ts";

/**
 * One source voxel's worth of EXTRACTED points.
 *
 * Phase 6.5 changed what this represents. Phase 3/3.5's stack was a permanent
 * snapshot of an entire voxel, created whole at mine time and only ever
 * deleted; extraction is continuous, so a stack now accumulates over multiple
 * cycles and can shrink again point-by-point when items are returned. Two
 * consequences a reader should not be surprised by:
 *
 * 1. **`rowIds` is a mutable `number[]`, not a `Uint32Array` snapshot.** It
 *    grows by one batch per extraction cycle and loses individual entries on
 *    return, so a fixed-length typed array would mean reallocating on every
 *    mutation. It is still an OWNED array (never a view over the chunk's
 *    `meta.bin` buffer, which gets released on eviction — the reason 3.5's
 *    version was a `.slice()` copy in the first place).
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
  rowIds: number[];
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
      // A plain loop, not `push(...rowIds)`: today `rowIds` is always length 1
      // (one point per extraction cycle, by explicit design — see
      // config.ts#extractionBatchSize), so this doesn't bite in practice right
      // now, but the ONLY caller (MiningController.extract) is the same call
      // site that used to hand this a batch sized to the voxel — up to ~7,098
      // ids on BL's densest voxel before that changed. Keeping the safe form
      // costs nothing and stays correct if batching ever comes back.
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
      rowIds: [...rowIds],
      totalPoints: descriptor.totalPoints,
      reprRowId: descriptor.reprRowId,
      firstExtractedAt: now,
      lastExtractedAt: now,
      revision: 1,
    };
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
    const index = stack.rowIds.indexOf(rowId);
    if (index < 0) return false;
    stack.rowIds.splice(index, 1);
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
