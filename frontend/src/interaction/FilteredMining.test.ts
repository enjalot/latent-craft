import { it, expect, vi } from "vitest";
import { MiningController } from "./MiningController.ts";
import { MatchSnapshot } from "../metadata/MetadataClient.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { validateMiningSave } from "./MiningSave.ts";
import { PagedRecords } from "../streaming/RangeReader.ts";

function filter(rows: number[], total = 32) {
  const size = Math.ceil(total / 8), bytes = new ArrayBuffer(64 + size + (rows.length ? 12 : 0)), v = new DataView(bytes);
  v.setUint32(0, 0x464d434c, true); v.setUint32(4, total, true); v.setUint32(8, rows.length, true);
  v.setUint32(12, rows.length ? 1 : 0, true); v.setUint32(48, size, true); v.setUint32(52, 1, true);
  for (const row of rows) new Uint8Array(bytes)[64 + (row >> 3)] |= 1 << (row & 7);
  if (rows.length) v.setUint32(72 + size, rows.length, true);
  return new MatchSnapshot(bytes, "0".repeat(64), total, 1, 4);
}
function fixture() {
  const mesh = { userData: { chunkId: 0, instanceToLocalVoxelId: new Uint32Array([0]) }, setOpacityAt: vi.fn(), setUniformAt: vi.fn() };
  const chunk = { entry: {}, mesh, meta: { count: new Uint32Array([6]), occupied: new Uint32Array([0]),
    reprRowId: new Uint32Array([0]), pointOffset: new Uint32Array([0]), pointIds: new Uint32Array([0, 1, 2, 3, 4, 5]) }, containers: { setExtractedFraction: vi.fn() } };
  const manifest = { totalPoints: 32, voxelsPerChunk: 4, baseUrl: "/test", chunksById: new Map([[0, {}]]) } as Manifest;
  const mining = new MiningController({ residentChunkIds: [0], chunk: () => chunk } as unknown as ChunkStore, () => false, () => true, manifest);
  const hit = { mesh, instanceId: 0 } as unknown as VoxelHit;
  const mine = async () => { mining.prepare(0, 0); await Promise.resolve(); await Promise.resolve(); return mining.extract(hit); };
  return { mining, mine, hit, mesh, manifest };
}
it("mines only matches, preserving the ordinary cursor and CSV/save invariants when cleared", async () => {
  const { mining, mine, hit, manifest, mesh } = fixture();
  mining.setMetadataFilter(filter([1, 3, 5]));
  expect(await mining.previewRowId(0, 0)).toBe(1);
  expect(mesh.setUniformAt).toHaveBeenCalledWith(0, "atlasAllowed", 0);
  expect((await mine())?.rowIds).toEqual([1, 3, 5]);
  expect(mining.extractionState(0, 0)?.cursor).toBe(0);
  expect(mining.isFullyExtracted(0, 0)).toBe(true);
  const save = mining.snapshot("test"); expect(validateMiningSave(save, "test", manifest)).toEqual(save);
  mining.restore(save, "test"); expect(mining.viewExtracted(0, 0)).toBe(3);
  mining.setMetadataFilter(null); expect(mining.extract(hit)?.rowIds).toEqual([0, 2, 4]);
  expect([...mining.inventory.stacks[0].rowIds].sort()).toEqual([0, 1, 2, 3, 4, 5]);
});
it("restores returned matches and never includes held rows from an ordinary consumed prefix", async () => {
  const { mining, mine, hit } = fixture();
  mining.extract(hit); mining.returnRow("0:0", 1); mining.returnRow("0:0", 4);
  mining.setMetadataFilter(filter([1, 3, 5]));
  expect(mining.viewExtracted(0, 0)).toBe(2); expect((await mine())?.rowIds).toEqual([1]);
  mining.returnRow("0:0", 3); expect((await mine())?.rowIds).toEqual([3]);
  mining.returnStack("0:0"); expect(mining.viewExtracted(0, 0)).toBe(0);
  expect((await mine())?.rowIds).toEqual([1, 3, 5]);
});
it("cancels stale preparations and handles zero matches without changing inventory", async () => {
  const { mining, mine } = fixture();
  mining.setMetadataFilter(filter([1])); mining.prepare(0, 0);
  mining.setMetadataFilter(filter([2])); expect((await mine())?.rowIds).toEqual([2]);
  mining.setMetadataFilter(filter([])); expect(await mine()).toBeNull();
  expect(mining.inventory.totalPoints).toBe(1); expect(mining.isFullyExtracted(0, 0)).toBe(true);
});

it("scans sparse streamed matches in bounded batches, and retries after eviction during a read", async () => {
  const mesh = { userData: { chunkId: 0, instanceToLocalVoxelId: new Uint32Array([0]) }, setOpacityAt: vi.fn(), setUniformAt: vi.fn() };
  const chunk = { entry: { postings: { path: "postings" }, n_points: 205 }, mesh,
    meta: { count: new Uint32Array([205]), occupied: new Uint32Array([0]), reprRowId: new Uint32Array([0]), pointOffset: new Uint32Array([0]) },
    containers: { setExtractedFraction: vi.fn() } };
  let resident: typeof chunk | undefined = chunk, active = 0, peak = 0;
  const record = vi.spyOn(PagedRecords.prototype, "record").mockImplementation(async row => {
    active++; peak = Math.max(peak, active); await Promise.resolve(); active--;
    const data = new DataView(new ArrayBuffer(4)); data.setUint32(0, row, true); return data;
  });
  try {
    const manifest = { totalPoints: 256, url: (path: string) => path } as Manifest;
    const mining = new MiningController({ residentChunkIds: [0], chunk: () => resident } as unknown as ChunkStore, () => false, () => true, manifest);
    mining.setMetadataFilter(filter([101, 203], 256)); mining.prepare(0, 0);
    resident = undefined; await vi.waitFor(() => expect(active).toBe(0));
    resident = { ...chunk }; mining.prepare(0, 0);
    let cycle: ReturnType<MiningController["extract"]> = null;
    await vi.waitFor(() => { cycle = mining.extract({ mesh, instanceId: 0 } as unknown as VoxelHit); expect(cycle).not.toBeNull(); });
    expect(cycle!.rowIds).toEqual([101, 203]); expect(peak).toBeLessThanOrEqual(100);
    expect(mining.extractionState(0, 0)?.cursor).toBe(0);
    expect(mining.isFullyExtracted(0, 0)).toBe(true);
  } finally { record.mockRestore(); }
});
