import type { Manifest } from "../streaming/Manifest.ts";
import { PagedRecords, rangeReader, type RangeReader } from "../streaming/RangeReader.ts";
import type { MiningSave } from "./MiningSave.ts";

/** Verify only each consumed posting prefix, including legacy packs whose
 * postings live after the summary. Never fetch a whole dense voxel/chunk list. */
export async function verifyMiningPostings(save: MiningSave, manifest: Manifest,
  cancelled = () => false, reader: RangeReader = rangeReader): Promise<void> {
  const summaryBytes = 32 + manifest.voxelsPerChunk ** 3 * 16;
  for (const stack of save.stacks) {
    if (cancelled()) throw new Error("Map closed.");
    const entry = manifest.chunksById.get(stack.chunkId)!;
    const meta = new DataView(await reader.read(manifest.url(entry.meta_path), 0, summaryBytes, entry.meta_bytes));
    const version = meta.getUint16(4,true);
    if (meta.getUint32(0,true) !== 0x3156534c || (version !== 1 && version !== 2) ||
      meta.getUint32(6,true) !== stack.chunkId || meta.getUint32(10,true) !== manifest.voxelsPerChunk ** 3)
      throw new Error("Invalid block summary.");
    const off = 32 + stack.localVoxelId * 16;
    const count = version === 1 ? meta.getUint16(off,true) : meta.getUint32(off,true);
    const repr = meta.getUint32(off + (version === 1 ? 10 : 12),true);
    const pointOffset = meta.getUint32(off + (version === 1 ? 2 : 4),true);
    if (count !== stack.totalPoints || repr !== stack.reprRowId || pointOffset + count > entry.n_points)
      throw new Error("Block metadata does not match this map.");
    const rows = new Set([...stack.rowIds, ...stack.returned]);
    const selected = new Set(stack.selected ?? []);
    for (const row of selected) rows.delete(row);
    const start = pointOffset + (version === 1 ? summaryBytes / 4 : 0);
    if (version === 2 && !entry.postings) throw new Error("Missing posting reference.");
    const records = version === 1
      ? new PagedRecords(manifest.url(entry.meta_path), entry.meta_bytes / 4, 4, reader)
      : new PagedRecords(manifest.url(entry.postings!.path), entry.n_points, 4, reader);
    for (let i = 0; i < stack.cursor; i += 256) {
      if (cancelled()) throw new Error("Map closed.");
      const batch = await Promise.all(Array.from({length: Math.min(256, stack.cursor-i)}, async (_, j) =>
        (await records.record(start+i+j)).getUint32(0,true)));
      for (const row of batch) if (!rows.delete(row)) throw new Error("Image rows do not match the mined posting prefix.");
    }
    if (rows.size) throw new Error("Unverified images in posting prefix");
    for (const row of selected) {
      if (cancelled()) throw new Error("Map closed.");
      const lookup = manifest.raw.row_to_voxel;
      const identity = new DataView(await reader.read(manifest.url(lookup.path), row * 8, 8, lookup.bytes));
      if (identity.getUint32(0, true) !== stack.chunkId || identity.getUint16(4, true) !== stack.localVoxelId)
        throw new Error("Selected image does not belong to this voxel");
    }
  }
}
