import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChunkLoader, LoadedChunk } from "./ChunkLoader.ts";
import { ChunkStore } from "./ChunkStore.ts";
import { Manifest } from "./Manifest.ts";
import type { ManifestJson } from "../types.ts";
import { HttpError } from "../net/fetchTyped.ts";

function manifest(withChunk: boolean): Manifest {
  const chunks = withChunk
    ? [{
        chunk_id: 0,
        cx: 0,
        cy: 0,
        cz: 0,
        bbox: [-1, 1, -1, 1, -1, 1] as [number, number, number, number, number, number],
        n_occupied_voxels: 1,
        n_points: 1,
        atlas_path: "atlas.ktx2",
        atlas_bytes: 1,
        atlas_sha256: "x",
        meta_path: "meta.bin",
        meta_bytes: 1,
        meta_sha256: "x",
      }]
    : [];
  const blob = { path: "x", bytes: 1, sha256: "x" };
  const raw: ManifestJson = {
    format_version: 1,
    dataset_id: "test",
    built_at: "now",
    world: {
      num_voxels: 16,
      voxels_per_chunk: 16,
      chunks_per_axis: 1,
      frame: {
        extent: [-1, 1, -1, 1, -1, 1],
        raw_extent: [-1, 1, -1, 1, -1, 1],
        method: "test",
        extent_pct: [0, 100],
        pad_frac: 0,
      },
    },
    atlas: { size_px: 2_048, tile_px: 32, tiles_per_side: 64, format: "ktx2", alpha: false },
    point_source: { points_table: "x", umap_run: "x", n_points: withChunk ? 1 : 0 },
    subsets: {},
    thumb_url_template: "x",
    proxy: blob,
    point_index: blob,
    row_to_voxel: blob,
    voxel_proxy: { ...blob, n_voxels: withChunk ? 1 : 0 },
    chunks,
  };
  return new Manifest(raw, "/chunks", 80);
}

function loadedChunk(entry: Manifest["chunks"][number]): LoadedChunk {
  const mesh = new THREE.Group() as unknown as InstancedMesh2;
  Object.assign(mesh, { instancesCount: 0 });
  return {
    entry,
    mesh,
    atlasUrl: "atlas.ktx2",
    bytes: 1,
    meta: {
      chunkId: 0,
      voxelGridN: 16,
      atlasTilePx: 32,
      count: new Uint16Array(4_096),
      pointOffset: new Uint32Array(4_096),
      colorRgb: new Uint8Array(4_096 * 3),
      flags: new Uint8Array(4_096),
      reprRowId: new Uint32Array(4_096),
      pointIds: new Uint32Array(1),
      occupied: new Uint32Array([0]),
    },
    instanceToLocalVoxelId: new Uint32Array([0]),
    containers: {
      setDetailVisible: vi.fn(),
      instanceCount: 1,
      visibleInstanceCount: 1,
      drawnInstanceCount: 0,
    } as unknown as LoadedChunk["containers"],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChunkStore scheduling", () => {
  it("prefetches without showing distant thumbnails, and retains proxies until the nearer horizon is ready", async () => {
    const base = manifest(true).raw, summaryBytes = 32 + 4096 * 16;
    const chunks = [0,1,2].map(cx=>({...base.chunks[0],chunk_id:cx,cx,meta_bytes:summaryBytes,
      atlas_size_px:32,postings:{path:`${cx}.bin`,bytes:4,sha256:"x"}}));
    const m = new Manifest({...base,world:{...base.world,num_voxels:128,chunks_per_axis:8},chunks,
      streaming:{version:1,hierarchy:"hierarchy.json"},point_source:{...base.point_source,n_points:3},
      point_index:{...base.point_index,bytes:24},row_to_voxel:{...base.row_to_voxel,bytes:24}},"/chunks",80);
    const complete = new Map<number,(chunk:LoadedChunk)=>void>();
    const loader = {load:vi.fn(entry=>new Promise<LoadedChunk>(resolve=>complete.set(entry.chunk_id,resolve))),
      unload:vi.fn(),dispose:vi.fn()} as unknown as ChunkLoader;
    const onDisplayChanged=vi.fn(), store=new ChunkStore(m,loader,{onDisplayChanged});
    const camera=new THREE.PerspectiveCamera();camera.position.copy(m.chunkCenterWorld(0,new THREE.Vector3()));
    store.updateCamera(camera,true);
    const loaded=chunks.map(loadedChunk);
    complete.get(1)!(loaded[1]);complete.get(2)!(loaded[2]);
    await Promise.resolve();await Promise.resolve();
    expect(loaded[1].mesh.visible).toBe(false); // nearer chunk 0 isn't ready
    expect(loaded[2].mesh.visible).toBe(false); // downloaded, outside display radius
    complete.get(0)!(loaded[0]);await Promise.resolve();await Promise.resolve();
    expect(loaded[0].mesh.visible).toBe(true);expect(loaded[1].mesh.visible).toBe(true);
    expect(loaded[2].mesh.visible).toBe(false);
    expect(onDisplayChanged).not.toHaveBeenCalledWith(2,true);
    camera.position.copy(m.chunkCenterWorld(2,new THREE.Vector3()));store.updateCamera(camera,true);
    expect(loaded[0].mesh.visible).toBe(false);expect(loaded[2].mesh.visible).toBe(true);
    expect(onDisplayChanged).toHaveBeenCalledWith(0,false);
    store.dispose();
  });
  it("does not reclassify a stationary, settled world", () => {
    const loader = { load: vi.fn(), unload: vi.fn(), dispose: vi.fn() } as unknown as ChunkLoader;
    const store = new ChunkStore(manifest(false), loader);
    const camera = new THREE.PerspectiveCamera();
    store.updateCamera(camera, true);
    for (let i = 0; i < 1_000; i++) store.updateCamera(camera);
    expect(store.stats().classificationPasses).toBe(1);
    camera.rotateY(Math.PI / 12);
    store.updateCamera(camera);
    expect(store.stats().classificationPasses).toBe(2);
    store.dispose();
  });

  it("retries a transient failure after backoff and clears the failure on success", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const m = manifest(true);
    const chunk = loadedChunk(m.chunks[0]);
    const loader = {
      load: vi.fn().mockRejectedValueOnce(new TypeError("network down")).mockResolvedValue(chunk),
      unload: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader, {}, () => now);
    const camera = new THREE.PerspectiveCamera();

    store.updateCamera(camera, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.load).toHaveBeenCalledTimes(1);
    expect(store.stats().failed).toBe(1);

    now = 500;
    await vi.advanceTimersByTimeAsync(500);
    store.updateCamera(camera);
    await Promise.resolve();
    await Promise.resolve();
    expect(loader.load).toHaveBeenCalledTimes(2);
    expect(store.stats().resident).toBe(1);
    expect(store.stats().failed).toBe(0);
    store.dispose();
  });

  it("does not retry a definitive 404", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const m = manifest(true);
    const loader = {
      load: vi.fn().mockRejectedValue(new HttpError("/chunk", 404, "Not Found")),
      unload: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader);
    const camera = new THREE.PerspectiveCamera();

    store.updateCamera(camera, true);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    store.updateCamera(camera);

    expect(loader.load).toHaveBeenCalledOnce();
    expect(store.stats().failed).toBe(1);
    store.dispose();
  });

  it("turns off expensive cage detail while retaining a warm chunk", async () => {
    const m = manifest(true);
    const chunk = loadedChunk(m.chunks[0]);
    const loader = {
      load: vi.fn().mockResolvedValue(chunk),
      unload: vi.fn(),
      dispose: vi.fn(),
    } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader);
    const camera = new THREE.PerspectiveCamera();

    store.updateCamera(camera, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(chunk.containers.setDetailVisible).toHaveBeenLastCalledWith(true);

    camera.position.x = 400; // 2.5 chunk edges: retained in R2, beyond cage LOD
    store.updateCamera(camera, true);
    expect(store.stats().resident).toBe(1);
    expect(chunk.containers.setDetailVisible).toHaveBeenLastCalledWith(false);
    store.dispose();
  });
});
