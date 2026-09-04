import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { describe, expect, it, vi } from "vitest";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { LoadedChunk } from "../streaming/ChunkLoader.ts";
import { XRAY_OPACITY } from "../config.ts";
import { XRayController } from "./XRayController.ts";

describe("XRayController glass rendering", () => {
  it("uses true blending and sorted instances only while active", () => {
    const material = new THREE.MeshStandardMaterial({ alphaToCoverage: true });
    const setOpacityAt = vi.fn();
    const mesh = {
      material,
      customSort: null,
      sortObjects: false,
      _capacity: 2,
      setOpacityAt,
    } as unknown as InstancedMesh2;
    const setXrayActive = vi.fn();
    const chunk = {
      mesh,
      meta: { occupied: new Uint32Array([4, 9]) },
      containers: { setXrayActive },
    } as unknown as LoadedChunk;
    const store = {
      residentChunkIds: [3],
      chunk: (chunkId: number) => (chunkId === 3 ? chunk : undefined),
    } as unknown as ChunkStore;
    const controller = new XRayController(store, (_chunkId, localVoxelId) =>
      localVoxelId === 9 ? 1 : 0,
    );

    controller.setActive(true);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.alphaToCoverage).toBe(false);
    expect(mesh.sortObjects).toBe(true);
    expect(mesh.customSort).toBeTypeOf("function");
    expect(setXrayActive).toHaveBeenLastCalledWith(true);
    expect(setOpacityAt).toHaveBeenNthCalledWith(1, 0, XRAY_OPACITY);
    expect(setOpacityAt.mock.calls[1][0]).toBe(1);
    expect(setOpacityAt.mock.calls[1][1]).toBeCloseTo(0.3);

    controller.setActive(false);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect(material.alphaToCoverage).toBe(true);
    expect(mesh.sortObjects).toBe(false);
    expect(setXrayActive).toHaveBeenLastCalledWith(false);
    material.dispose();
  });
});
