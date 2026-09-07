import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChunkLoader, LoadedChunk } from "./ChunkLoader.ts";
import { ChunkStore } from "./ChunkStore.ts";
import { BL_STREAMING_POLICY, DEFAULT_STREAMING_POLICY, streamingPolicyFor } from "./StreamingPolicy.ts";
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

function compactManifest(coordinates: number[][]): Manifest {
  const base = manifest(true).raw;
  const chunks = coordinates.map(([cx, cy, cz]) => ({
    ...base.chunks[0], cx, cy, cz, chunk_id: cx + 16 * (cy + 16 * cz),
    atlas_size_px: 32, atlas_tiles_per_side: 1, meta_bytes: 32 + 4096 * 16,
    postings: { path: `${cx}-${cy}-${cz}.bin`, bytes: 4, sha256: "x" },
  }));
  return new Manifest({ ...base,
    world: { ...base.world, num_voxels: 256, chunks_per_axis: 16 },
    atlas: { ...base.atlas, layout: "compact-occupied-v1" }, chunks,
    streaming: { version: 1, hierarchy: "hierarchy.json" },
    point_source: { ...base.point_source, n_points: chunks.length },
    point_index: { ...base.point_index, bytes: chunks.length * 8 },
    row_to_voxel: { ...base.row_to_voxel, bytes: chunks.length * 8 },
  }, "/chunks", 80);
}

describe("BL preview residency", () => {
  it("opts in only compact streaming BL, leaving MONET and legacy packs unchanged", () => {
    const m = compactManifest([[0, 0, 0]]);
    expect(streamingPolicyFor("bl-wide", m)).toBe(BL_STREAMING_POLICY);
    expect(streamingPolicyFor(undefined, m)).toBe(DEFAULT_STREAMING_POLICY);
    expect(streamingPolicyFor("bl-wide", manifest(true))).toBe(DEFAULT_STREAMING_POLICY);
    const nonCompact = new Manifest({ ...m.raw, atlas: { ...m.raw.atlas, layout: undefined } }, "/chunks", 80);
    expect(streamingPolicyFor("bl-wide", nonCompact)).toBe(DEFAULT_STREAMING_POLICY);
    expect(BL_STREAMING_POLICY.maxBytes).toBe(DEFAULT_STREAMING_POLICY.maxBytes);
  });

  it("shows each finished chunk immediately, retaining it across the load boundary without fetching cold warm-band chunks", async () => {
    const m = compactManifest([[0, 0, 0], [4, 0, 0], [10, 0, 0]]);
    const complete = new Map<number, (chunk: LoadedChunk) => void>();
    const loader = { load: vi.fn(entry => new Promise<LoadedChunk>(resolve => complete.set(entry.chunk_id, resolve))),
      unload: vi.fn(), dispose: vi.fn() } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader, {}, undefined, BL_STREAMING_POLICY);
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(m.chunkCenterWorld(0, new THREE.Vector3()));
    store.updateCamera(camera, true);
    expect(vi.mocked(loader.load).mock.calls.map(([c]) => c.chunk_id)).toEqual([0, 4]);
    const chunk = loadedChunk(m.chunks[1]);
    complete.get(4)!(chunk);
    await Promise.resolve(); await Promise.resolve();
    expect(store.stats()).toMatchObject({ resident: 1, loading: 1 });
    expect(chunk.mesh.visible).toBe(true); // No wait for any other chunk.
    expect(chunk.containers.setDetailVisible).toHaveBeenLastCalledWith(false);
    // Chunk 10 is now in the keep-only band: do not fetch it. Chunk 4 stays
    // resident/visible beyond the 5-chunk loading radius when moving back.
    camera.position.x += 4.5 * m.chunkWorldSize;
    store.updateCamera(camera, true);
    expect(loader.load).toHaveBeenCalledTimes(2);
    camera.position.x -= 5.7 * m.chunkWorldSize;
    store.updateCamera(camera, true); // chunk 4 is 5.2 chunks away
    expect(chunk.mesh.visible).toBe(true);
    expect(loader.unload).not.toHaveBeenCalled();
    camera.position.x += .3 * m.chunkWorldSize;
    store.updateCamera(camera, true);
    expect(loader.load).toHaveBeenCalledTimes(2);
    camera.position.x -= 1.2 * m.chunkWorldSize;
    store.updateCamera(camera, true); // now 6.1: evict
    expect(loader.unload).toHaveBeenCalledWith(chunk);
    store.dispose();
  });

  it("streams more than 96 chunks in batches of at most six, not one blocking whole-pack load", async () => {
    const coords = Array.from({ length: 125 }, (_, i) => [i % 5, Math.floor(i / 5) % 5, Math.floor(i / 25)]);
    const m = compactManifest(coords);
    const loader = { load: vi.fn(async entry => loadedChunk(entry)), unload: vi.fn(), dispose: vi.fn() } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader, {}, undefined, BL_STREAMING_POLICY);
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(m.chunkCenterWorld(2 + 16 * (2 + 16 * 2), new THREE.Vector3()));
    store.updateCamera(camera, true);
    expect(loader.load).toHaveBeenCalledTimes(6);
    expect(store.stats().resident).toBe(0);
    for (let batch = 0; batch < 25; batch++) {
      await Promise.resolve(); await Promise.resolve();
      store.updateCamera(camera);
      expect(store.stats().loading).toBeLessThanOrEqual(6);
    }
    expect(store.stats().resident).toBe(125);
    expect(store.meshes.every(mesh => mesh.visible)).toBe(true);
    expect(loader.unload).not.toHaveBeenCalled();
    store.dispose();
  });

  it.each([
    { maxChunks: 1 }, { maxBytes: 32 * 32 * 4 + 65568 + 1024 }, { maxInstances: 1 },
  ])("preserves nearest-first admission under a tighter cap %j", async cap => {
    const m = compactManifest([[0, 0, 0], [1, 0, 0], [4, 0, 0]]);
    const loader = { load: vi.fn(async entry => loadedChunk(entry)), unload: vi.fn(), dispose: vi.fn() } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader, {}, undefined, { ...BL_STREAMING_POLICY, ...cap });
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(m.chunkCenterWorld(0, new THREE.Vector3()));
    store.updateCamera(camera, true);
    await Promise.resolve(); await Promise.resolve();
    store.updateCamera(camera);
    expect(vi.mocked(loader.load).mock.calls.map(([c]) => c.chunk_id)).toEqual([0]);
    store.dispose();
  });

  it("admits a newly nearby chunk before retaining a farther warm chunk", async () => {
    const m = compactManifest([[0, 0, 0], [10, 0, 0]]);
    const loader = { load: vi.fn(async entry => loadedChunk(entry)), unload: vi.fn(), dispose: vi.fn() } as unknown as ChunkLoader;
    const store = new ChunkStore(m, loader, {}, undefined, { ...BL_STREAMING_POLICY, maxChunks: 1 });
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(m.chunkCenterWorld(0, new THREE.Vector3()));
    store.updateCamera(camera, true);
    await Promise.resolve(); await Promise.resolve();
    camera.position.x += 5.2 * m.chunkWorldSize;
    store.updateCamera(camera, true);
    await Promise.resolve(); await Promise.resolve();
    expect([...store.residentChunkIds]).toEqual([10]);
    expect(vi.mocked(loader.load).mock.calls.map(([c]) => c.chunk_id)).toEqual([0, 10]);
    expect(loader.unload).toHaveBeenCalledOnce();
    store.dispose();
  });
});

describe("ChunkStore scheduling", () => {
  it("uses per-chunk distance gates without retracting the horizon for an unfinished nearer download", async () => {
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
    camera.position.x -= .4*m.chunkWorldSize;
    store.updateCamera(camera,true);
    const loaded=chunks.map(loadedChunk);
    complete.get(1)!(loaded[1]);complete.get(2)!(loaded[2]);
    await Promise.resolve();await Promise.resolve();
    expect(loaded[1].mesh.visible).toBe(true); // missing chunk 0 must not hide existing detail
    expect(loaded[2].mesh.visible).toBe(false); // downloaded, outside display radius
    complete.get(0)!(loaded[0]);await Promise.resolve();await Promise.resolve();
    expect(loaded[0].mesh.visible).toBe(true);expect(loaded[1].mesh.visible).toBe(true);
    expect(loaded[2].mesh.visible).toBe(false);
    expect(onDisplayChanged).not.toHaveBeenCalledWith(2,true);
    camera.position.copy(m.chunkCenterWorld(2,new THREE.Vector3()));store.updateCamera(camera,true);
    expect(loaded[0].mesh.visible).toBe(true);
    camera.position.x += .3*m.chunkWorldSize;store.updateCamera(camera,true);
    expect(loaded[0].mesh.visible).toBe(true); // retained in the exit deadband
    camera.position.x += .15*m.chunkWorldSize;store.updateCamera(camera,true);
    expect(loaded[0].mesh.visible).toBe(false);expect(loaded[2].mesh.visible).toBe(true);
    expect(onDisplayChanged).toHaveBeenCalledWith(0,false);
    store.dispose();
  });
  it("requests nearer chunks first regardless of facing direction", () => {
    const base=manifest(true).raw;
    const chunks=[0,1,2].map(cx=>({...base.chunks[0],chunk_id:cx,cx,atlas_size_px:32,
      meta_bytes:32+4096*16,postings:{path:`${cx}.bin`,bytes:4,sha256:"x"}}));
    const m=new Manifest({...base,world:{...base.world,num_voxels:128,chunks_per_axis:8},chunks,
      streaming:{version:1,hierarchy:"hierarchy.json"},point_source:{...base.point_source,n_points:3},
      point_index:{...base.point_index,bytes:24},row_to_voxel:{...base.row_to_voxel,bytes:24}},"/chunks",80);
    for (const direction of [-1,1]) {
      const loader={load:vi.fn(()=>new Promise(()=>{})),unload:vi.fn(),dispose:vi.fn()} as unknown as ChunkLoader;
      const store=new ChunkStore(m,loader),camera=new THREE.PerspectiveCamera();
      camera.position.copy(m.chunkCenterWorld(1,new THREE.Vector3()));camera.position.x-=.1*m.chunkWorldSize;
      camera.lookAt(camera.position.clone().add(new THREE.Vector3(direction,0,0)));
      store.updateCamera(camera,true);
      expect(vi.mocked(loader.load).mock.calls.map(([entry])=>entry.chunk_id)).toEqual([1,0,2]);
      camera.position.x += .6*m.voxelWorldSize;
      store.updateCamera(camera);
      expect(store.stats().classificationPasses).toBe(2); // less than old 1.5 world-unit threshold
      store.dispose();
    }
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
