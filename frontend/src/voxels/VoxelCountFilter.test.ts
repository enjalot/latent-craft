import { describe, expect, it, vi } from "vitest";
import { proxyCellMaxCounts, voxelCountThreshold } from "./VoxelCountFilter.ts";
import { VoxelProxyCloud } from "./VoxelProxyCloud.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { VoxelProxyData } from "../types.ts";
import type { WebGLRenderer } from "three";

function records(rows: number[][]): DataView {
  const view = new DataView(new ArrayBuffer(rows.length * 16));
  rows.forEach(([x, y, z, count], i) => {
    view.setUint16(i * 16, x, true); view.setUint16(i * 16 + 2, y, true); view.setUint16(i * 16 + 4, z, true);
    view.setUint32(i * 16 + 8, count, true);
  });
  return view;
}

describe("Voxel count filter", () => {
  it("defaults invalid/old settings to one and accepts only positive integer thresholds", () => {
    for (const input of [undefined, null, "2", NaN, Infinity, -5, 0]) expect(voxelCountThreshold(input)).toBe(1);
    expect(voxelCountThreshold(2.9)).toBe(2);
    expect(voxelCountThreshold(1e20)).toBe(0xffffffff);
  });

  it("filters coarse cells by maximum child count, never the aggregate sum", () => {
    const fine = records([[0, 0, 0, 1], [1, 1, 1, 1], [4, 0, 0, 2], [5, 0, 0, 70000], [0, 0, 4, 9]]);
    const coarse = records([[0, 0, 0, 2], [4, 0, 0, 70002], [0, 0, 4, 9]]);
    const max = proxyCellMaxCounts(fine, coarse, 4, 16);
    expect([...max]).toEqual([1, 70000, 9]);
    expect([...max].map(count => count > 1)).toEqual([false, true, true]);
    expect([...max].map(count => count > 9)).toEqual([false, true, false]);
    expect([...proxyCellMaxCounts(fine, fine, 1, 16)]).toEqual([1, 1, 2, 70000, 9]);
  });

  it("composes legacy proxy filtering with residency, including reload and disabling", () => {
    const data = { chunkId: new Uint32Array([0, 0, 1]), localVoxelId: new Uint16Array([0, 1, 0]),
      count: new Uint32Array([1, 2, 1]), colorRgb: new Uint8Array(9),
      runStart: new Int32Array([0, 2]), runEnd: new Int32Array([2, 3]) } as VoxelProxyData;
    const manifest = { voxelWorldSize: 1, voxelCenterWorldById: vi.fn() } as unknown as Manifest;
    const cloud = new VoxelProxyCloud(manifest, data, undefined as unknown as WebGLRenderer);
    const visible = () => [0, 1, 2].map(id => cloud.mesh.getVisibilityAt(id));
    expect(cloud.shownCount).toBe(3);
    cloud.setCountFilter(1); expect(visible()).toEqual([false, true, false]); expect(cloud.shownCount).toBe(1);
    cloud.setChunkResident(0, true); expect(cloud.shownCount).toBe(0);
    cloud.setChunkResident(0, false); expect(visible()).toEqual([false, true, false]); expect(cloud.shownCount).toBe(1);
    cloud.setChunkResident(0, true); cloud.setCountFilter(0);
    expect(visible()).toEqual([false, false, true]); expect(cloud.shownCount).toBe(1);
    cloud.setChunkResident(0, false); expect(visible()).toEqual([true, true, true]); expect(cloud.shownCount).toBe(3);
    cloud.setCountFilter(2); expect(cloud.shownCount).toBe(0);
    cloud.dispose();
  });
});
