import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { describe, expect, it, vi } from "vitest";
import type { VoxelHit } from "../engine/Raycast.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { LoadedChunk } from "../streaming/ChunkLoader.ts";
import { MiningController } from "./MiningController.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import { rangeReader } from "../streaming/RangeReader.ts";

function fixture(total: number, pickaxe: boolean): {
  controller: MiningController;
  hit: VoxelHit;
  setOpacityAt: ReturnType<typeof vi.fn>;
} {
  const count = new Uint32Array(1);
  count[0] = total;
  const pointIds = Uint32Array.from({ length: total }, (_, index) => 1_000 + index);
  const setOpacityAt = vi.fn();
  const mesh = {
    userData: {
      chunkId: 7,
      instanceToLocalVoxelId: new Uint32Array([0]),
    },
    setOpacityAt,
  } as unknown as InstancedMesh2;
  const chunk = {
    entry: { chunk_id: 7 },
    mesh,
    meta: {
      count,
      pointOffset: new Uint32Array([0]),
      pointIds,
      reprRowId: new Uint32Array([1_000]),
      occupied: new Uint32Array([0]),
    },
    containers: { setExtractedFraction: vi.fn() },
  } as unknown as LoadedChunk;
  const store = { chunk: (chunkId: number) => (chunkId === 7 ? chunk : undefined) } as ChunkStore;
  const controller = new MiningController(store, () => false, () => pickaxe);
  const hit: VoxelHit = {
    mesh,
    instanceId: 0,
    point: new THREE.Vector3(),
    distance: 1,
  };
  return { controller, hit, setOpacityAt };
}

describe("MiningController tool batches", () => {
  it("mines across posting page boundaries in a 100M pack without loading the chunk's full list", async () => {
    rangeReader.cache.clear();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const [start, end] = (options!.headers as Record<string, string>).Range.slice(6).split('-').map(Number);
      const buffer = new ArrayBuffer(end - start + 1), view = new DataView(buffer);
      for (let i = 0; i < buffer.byteLength; i += 4) view.setUint32(i, (start + i) / 4, true);
      return new Response(buffer, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/400000000`, 'Content-Length': String(buffer.byteLength) } });
    });
    try {
      const mesh = { userData: { chunkId: 7, instanceToLocalVoxelId: new Uint32Array([0]) }, setOpacityAt: vi.fn() } as unknown as InstancedMesh2;
      const chunk = { mesh, entry: { chunk_id: 7, n_points: 100_000_000, postings: { path: 'test100m-postings.bin' } },
        meta: { count: new Uint32Array([1_000_000]), pointOffset: new Uint32Array([99_000_000]), pointIds: new Uint32Array(0), reprRowId: new Uint32Array([99_000_000]) },
        containers: { setExtractedFraction: vi.fn() } } as unknown as LoadedChunk;
      const store = { chunk: () => chunk } as unknown as ChunkStore;
      const manifest = { url: (path: string) => `/${path}` } as Manifest;
      const controller = new MiningController(store, () => false, () => true, manifest);
      for (let i = 0; i < 43; i++) {
        controller.prepare(7, 0);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(controller.nextRowId(7, 0)).toBe(99_000_000 + i * 100);
        const cycle = controller.extract({ mesh, instanceId: 0 } as VoxelHit);
        expect(cycle?.lastRowId).toBe(99_000_099 + i * 100);
      }
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
      expect(rangeReader.cache.weight).toBeLessThanOrEqual(3 * 16384);
    } finally { fetcher.mockRestore(); rangeReader.cache.clear(); }
  });
  it("drains a million-image voxel in linear work with compact inventory storage", () => {
    const { controller, hit } = fixture(1_000_000, true);
    for (let i = 0; i < 10_000; i++) expect(controller.extract(hit)?.rowIds.length).toBe(100);
    expect(controller.extractionState(7, 0)?.cursor).toBe(1_000_000);
    expect(controller.nextRowId(7, 0)).toBeNull();
    expect(controller.inventory.stack('7:0')?.rowIds.byteLength).toBeLessThan(4_020_000);
    expect(controller.returnRow('7:0', 500_000)).toBe(true);
    expect(controller.nextRowId(7, 0)).toBe(500_000);
    expect(controller.extract(hit)?.rowIds).toEqual([500_000]);
    expect(controller.returnStack('7:0')).toBe(true);
    expect(controller.nextRowId(7, 0)).toBe(1000);
  });
  it("extracts one point with empty hand", () => {
    const { controller, hit } = fixture(150, false);
    const cycle = controller.extract(hit);

    expect(cycle?.rowIds).toEqual([1_000]);
    expect(cycle?.lastRowId).toBe(1_000);
    expect(controller.batchSizeFor(150)).toBe(1);
    expect(controller.nextRowId(7, 0)).toBe(1_001);
  });

  it("extracts 100 with Pickaxe, advances the preview row, and caps the final batch", () => {
    const { controller, hit, setOpacityAt } = fixture(150, true);

    const first = controller.extract(hit);
    expect(first?.rowIds).toHaveLength(100);
    expect(first?.leadRowId).toBe(1_000);
    expect(first?.lastRowId).toBe(1_099);
    expect(first?.complete).toBe(false);
    expect(controller.nextRowId(7, 0)).toBe(1_100);
    expect(controller.batchSizeFor(150, 100)).toBe(50);

    const second = controller.extract(hit);
    expect(second?.rowIds).toHaveLength(50);
    expect(second?.lastRowId).toBe(1_149);
    expect(second?.complete).toBe(true);
    expect(controller.nextRowId(7, 0)).toBeNull();
    expect(setOpacityAt).toHaveBeenCalledTimes(2);
  });

  it("makes a returned row the next row to mine instead of relying on a monotonic cursor", () => {
    const { controller, hit } = fixture(150, true);
    const first = controller.extract(hit)!;
    expect(controller.returnRow(first.stackId, 1_005)).toBe(true);
    expect(controller.nextRowId(7, 0)).toBe(1_005);

    const final = controller.extract(hit)!;
    expect(final.rowIds).toHaveLength(51);
    expect(final.rowIds[0]).toBe(1_005);
    expect(final.complete).toBe(true);
  });
});
