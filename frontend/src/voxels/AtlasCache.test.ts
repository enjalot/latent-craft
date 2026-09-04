import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { AtlasCache, type AtlasTextureLoader } from "./AtlasCache.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cacheWith(loader: AtlasTextureLoader): AtlasCache {
  return new AtlasCache({} as THREE.WebGLRenderer, "/basis/", loader);
}

describe("AtlasCache", () => {
  it("counts decoded RGBA fallback pixels rather than compressed transfer bytes", async () => {
    const texture = new THREE.DataTexture(new Uint8Array(64), 4, 4);
    const cache = cacheWith({ loadAsync: async () => texture, dispose: vi.fn() });
    await cache.acquire('rgba.ktx2');
    expect(cache.byteSize('rgba.ktx2', 8)).toBe(64);
    cache.release('rgba.ktx2');
    cache.dispose();
  });
  it("disposes a decode whose only waiter aborted", async () => {
    const load = deferred<THREE.Texture>();
    const loader = { loadAsync: vi.fn(() => load.promise), dispose: vi.fn() };
    const cache = cacheWith(loader);
    const texture = new THREE.Texture();
    texture.mipmaps = [
      { data: new Uint8Array(16), width: 4, height: 4 },
      { data: new Uint8Array(4), width: 2, height: 2 },
    ];
    const dispose = vi.spyOn(texture, "dispose");
    const controller = new AbortController();
    const acquired = cache.acquire("atlas.ktx2", controller.signal);
    controller.abort();
    load.resolve(texture);

    await expect(acquired).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.residentCount).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps a shared decode while one live waiter owns it", async () => {
    const load = deferred<THREE.Texture>();
    const loader = { loadAsync: vi.fn(() => load.promise), dispose: vi.fn() };
    const cache = cacheWith(loader);
    const texture = new THREE.Texture();
    texture.mipmaps = [
      { data: new Uint8Array(16), width: 4, height: 4 },
      { data: new Uint8Array(4), width: 2, height: 2 },
    ];
    const dispose = vi.spyOn(texture, "dispose");
    const controller = new AbortController();
    const abandoned = cache.acquire("atlas.ktx2", controller.signal);
    const live = cache.acquire("atlas.ktx2");
    controller.abort();
    load.resolve(texture);

    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    await expect(live).resolves.toBe(texture);
    expect(texture.mipmaps).toHaveLength(1);
    expect(cache.byteSize("atlas.ktx2", 0)).toBe(16);
    expect(cache.residentCount).toBe(1);
    expect(dispose).not.toHaveBeenCalled();

    cache.release("atlas.ktx2");
    expect(cache.residentCount).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes a decode that completes after cache teardown", async () => {
    const load = deferred<THREE.Texture>();
    const loader = { loadAsync: vi.fn(() => load.promise), dispose: vi.fn() };
    const cache = cacheWith(loader);
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, "dispose");
    const acquired = cache.acquire("atlas.ktx2");
    cache.dispose();
    load.resolve(texture);

    await expect(acquired).rejects.toMatchObject({ name: "AbortError" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(loader.dispose).toHaveBeenCalledOnce();
  });
});
