import { Store } from "../ui/store.ts";

/**
 * One mined voxel's worth of points. `rowIds` is a permanent snapshot taken
 * at mine time — the pipeline never mutates voxel membership at runtime, so
 * there's nothing to keep in sync afterward.
 */
export interface InventoryStack {
  /** `${chunkId}:${localVoxelId}` — stable and unique per mined voxel. */
  id: string;
  chunkId: number;
  localVoxelId: number;
  /** Owned copy (not a view over the chunk's `meta.bin` buffer — that gets
   * released on eviction) of every row_id that was in this voxel. */
  rowIds: Uint32Array;
  /** The voxel's representative point — used for the stack's own thumbnail. */
  reprRowId: number;
  minedAt: number;
}

/** Mined-voxel stacks, newest first, backed by a `Store` so `InventoryPanel`
 * can subscribe rather than being hand-wired to every mine event. */
export class Inventory {
  readonly store = new Store<InventoryStack[]>([]);

  addStack(stack: InventoryStack): void {
    this.store.set((prev) => [stack, ...prev]);
  }

  /** Removes a stack by id (see `restore()` in `MiningController`) — a
   * no-op if the id isn't present, so callers don't need to check first. */
  removeStack(id: string): void {
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
