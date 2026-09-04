import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { describe, expect, it, vi } from "vitest";
import type { VoxelHit } from "../engine/Raycast.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { LoadedChunk } from "../streaming/ChunkLoader.ts";
import { MiningController } from "./MiningController.ts";

function fixture(total: number, pickaxe: boolean): {
  controller: MiningController;
  hit: VoxelHit;
  setOpacityAt: ReturnType<typeof vi.fn>;
} {
  const count = new Uint16Array(1);
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
