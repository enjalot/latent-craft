import * as THREE from "three";
import { expect, it, vi } from "vitest";
import { SharpBand } from "./SharpBand.ts";
import type { PreviewTarget } from "../voxels/PreviewPool.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { MiningController } from "./MiningController.ts";
import { Inventory } from "./Inventory.ts";

vi.mock("../voxels/PreviewPool.ts", () => ({
  PREVIEW_SLOTS: 128,
  PreviewPool: class {
    visibleKeys = new Set<string>();
    update = vi.fn();
    dispose = vi.fn();
  },
}));

it("skips stationary scans but refreshes camera, owners, filters and inventory mutations", () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const makeOwner = () => ({ mesh: { visible: true, getVisibilityAt: () => true,
    getMatrixAt: (_id: number, matrix: THREE.Matrix4) => matrix.identity(), setOpacityAt: vi.fn(), getOpacityAt: () => 1 },
    meta: { occupied: new Uint32Array([0]) }, entry: { cx: 0, cy: 0, cz: 0 } });
  let owner = makeOwner();
  const store = { residentChunkIds: [0], chunk: () => owner } as unknown as ChunkStore;
  const manifest = { voxelWorldSize: 1, chunkWorldSize: 16,
    chunkCenterWorld: (_id: number, v: THREE.Vector3) => v.set(0,0,-3),
    voxelCenterWorld: (_x:number,_y:number,_z:number,_id:number,v:THREE.Vector3) => v.set(0,0,-3) } as Manifest;
  const inventory = new Inventory();
  const mining = { inventory, filterRevision: 0, isFullyExtracted: () => false, extractionState: () => null, extractedFraction: () => 0 } as unknown as MiningController;
  const band = new SharpBand(new THREE.Scene(), {} as THREE.WebGLRenderer, store, manifest, mining, vi.fn());
  const camera = new THREE.PerspectiveCamera();
  const step = () => { now += 1000; band.update(camera, 2, null, false); };
  step(); for (let i = 0; i < 100; i++) step(); expect(band.candidateScans).toBe(1);
  camera.position.x = .2; step(); expect(band.candidateScans).toBe(2);
  owner = makeOwner(); step(); expect(band.candidateScans).toBe(3);
  owner.mesh.visible = false; step(); owner.mesh.visible = true; step(); expect(band.candidateScans).toBe(5);
  mining.filterRevision++; step(); expect(band.candidateScans).toBe(6);
  inventory.replace([]); step(); expect(band.candidateScans).toBe(7);
  band.invalidate(); step(); expect(band.candidateScans).toBe(8);
  camera.rotation.y = .1; step(); expect(band.candidateScans).toBe(9);
  band.update(camera, 3, null, false); expect(band.candidateScans).toBe(10);
  band.dispose(); clock.mockRestore();
});

it("removes filtered sharp/search/opaque-hover overlays even before the next candidate scan", () => {
  let visible = true;
  const owner = { mesh: { visible: true, getVisibilityAt: () => visible,
    getMatrixAt: (_id: number, matrix: THREE.Matrix4) => matrix.identity(), setOpacityAt: vi.fn(), getOpacityAt: () => 1 },
    meta: { occupied: new Uint32Array([0]) }, entry: { cx: 0, cy: 0, cz: 0 } };
  const store = { residentChunkIds: [0], chunk: () => owner } as unknown as ChunkStore;
  const manifest = { voxelWorldSize: 1, chunkWorldSize: 16,
    chunkCenterWorld: (_id: number, v: THREE.Vector3) => v.set(0, 0, -3),
    voxelCenterWorld: (_x: number, _y: number, _z: number, _local: number, v: THREE.Vector3) => v.set(0, 0, -3) } as Manifest;
  const mining = { isFullyExtracted: () => false, extractionState: () => null, extractedFraction: () => 0 } as unknown as MiningController;
  const band = new SharpBand(new THREE.Scene(), {} as THREE.WebGLRenderer, store, manifest, mining, vi.fn());
  const camera = new THREE.PerspectiveCamera();
  const targets = () => vi.mocked(band.pool.update).mock.lastCall![0] as PreviewTarget[];
  band.update(camera, 2, null, false);
  expect(targets()).toHaveLength(1);
  const pending = targets()[0]; expect(pending.valid()).toBe(true);
  visible = false;
  expect(pending.valid()).toBe(false);
  band.setSearchFocus({ chunkId: 0, localVoxelId: 0, rowId: 12 });
  band.update(camera, 2, { chunkId: 0, localVoxelId: 0 }, true);
  expect(targets()).toHaveLength(0);
  expect(band.opaqueHover.mesh.visible).toBe(false);
  band.dispose();
});

it("removes the image band in X-ray, retaining only the focused image and invalidating selected-row previews", () => {
  const atlas = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: atlas });
  const owner = { mesh: { visible: true, material, getVisibilityAt: () => true,
    getMatrixAt: (_id: number, matrix: THREE.Matrix4) => matrix.identity(), setOpacityAt: vi.fn(), getOpacityAt: () => 1 },
    meta: { occupied: new Uint32Array([0,1]), reprRowId: new Uint32Array([10,11]) }, entry: { cx: 0, cy: 0, cz: 0, atlas_tiles_per_side: 16 } };
  const store = { residentChunkIds: [0], chunk: () => owner } as unknown as ChunkStore;
  const manifest = { voxelWorldSize: 1, chunkWorldSize: 16, compactAtlases: true, tilePx: 32,
    chunkCenterWorld: (_id: number, v: THREE.Vector3) => v.set(0,0,-2.5),
    voxelCenterWorld: (_x: number, _y: number, _z: number, local: number, v: THREE.Vector3) => v.set(local,0,-2.5) } as Manifest;
  const state = { cursor: 0, extracted: {size: 0}, returned: new Set<number>() };
  const mining = { isFullyExtracted: () => false, extractionState: () => state, extractedFraction: () => 0, matchesRow: () => true } as unknown as MiningController;
  const band = new SharpBand(new THREE.Scene(), {} as THREE.WebGLRenderer, store, manifest, mining, vi.fn());
  const camera = new THREE.PerspectiveCamera();
  const targets = () => vi.mocked(band.pool.update).mock.lastCall![0] as PreviewTarget[];
  band.update(camera,2,null,false); expect(targets()).toHaveLength(2);
  band.update(camera,2,null,true); expect(targets()).toHaveLength(0);
  band.update(camera,2,{chunkId:0,localVoxelId:0},true);
  expect(targets()).toHaveLength(1); expect(targets()[0].focused).toBe(true);
  expect(band.opaqueHover.mesh.visible).toBe(true);
  const key = targets()[0].key;
  state.extracted.size = 1;
  band.update(camera,2,{chunkId:0,localVoxelId:0},true); expect(targets()[0].key).not.toBe(key);
  band.update(camera,2,null,false); expect(targets()).toHaveLength(2);
  const pending = targets()[0];
  mining.filterRevision = 1;
  expect(pending.valid()).toBe(false);
  mining.matchesRow = () => false;
  band.update(camera, 2, { chunkId: 0, localVoxelId: 0 }, true);
  expect(band.opaqueHover.mesh.visible).toBe(false);
  band.dispose(); material.dispose(); atlas.dispose();
});

it("does not upload unchanged source opacity each frame and restores it when uncovered", () => {
  let opacity = 1;
  const setOpacityAt = vi.fn((_id: number, value: number) => { opacity = value; });
  const owner = { mesh: { visible: true, getVisibilityAt: () => true,
    getMatrixAt: (_id: number, matrix: THREE.Matrix4) => matrix.identity(),
    setOpacityAt, getOpacityAt: () => opacity },
    meta: { occupied: new Uint32Array([0]) }, entry: { cx: 0, cy: 0, cz: 0 } };
  const store = { residentChunkIds: [0], chunk: () => owner } as unknown as ChunkStore;
  const manifest = { voxelWorldSize: 1, chunkWorldSize: 16,
    chunkCenterWorld: (_id: number, v: THREE.Vector3) => v.set(0, 0, -3),
    voxelCenterWorld: (_x: number, _y: number, _z: number, _id: number, v: THREE.Vector3) => v.set(0, 0, -3) } as Manifest;
  const mining = { isFullyExtracted: () => false, extractionState: () => null,
    extractedFraction: () => 0 } as unknown as MiningController;
  const band = new SharpBand(new THREE.Scene(), {} as THREE.WebGLRenderer, store, manifest, mining, vi.fn());
  const camera = new THREE.PerspectiveCamera();
  vi.mocked(band.pool.update).mockImplementation((targets: PreviewTarget[]) => {
    band.pool.visibleKeys.clear();
    for (const target of targets) band.pool.visibleKeys.add(target.key);
  });
  for (let i = 0; i < 100; i++) band.update(camera, 2, null, false);
  expect(setOpacityAt).toHaveBeenCalledExactlyOnceWith(0, 0);
  band.update(camera, 3, null, false);
  expect(setOpacityAt).toHaveBeenCalledTimes(2);
  expect(setOpacityAt).toHaveBeenLastCalledWith(0, 1);
  band.dispose();
});
