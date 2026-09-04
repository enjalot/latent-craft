import * as THREE from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

/** Narrow loader surface so the ownership logic can be tested without a WebGL
 * context. `KTX2Loader` is the production implementation. */
export interface AtlasTextureLoader {
  loadAsync(url: string): Promise<THREE.Texture>;
  dispose(): void;
}

interface PendingAtlas {
  promise: Promise<THREE.Texture>;
  /** Callers currently waiting for this decode. A decoded zero-ref texture may
   * only be disposed after every waiter has either claimed it or aborted. */
  waiters: number;
}

/**
 * Loads and refcounts the per-chunk KTX2/Basis-Universal atlases.
 *
 * Transcoder note (this is the part that bites people): `KTX2Loader` cannot
 * decode anything until it has (a) a URL it can actually fetch
 * `basis_transcoder.js` / `.wasm` from and (b) `detectSupport(renderer)` so it
 * knows which GPU-compressed format to transcode ETC1S into. We copy the two
 * transcoder files out of `three/examples/jsm/libs/basis/` into
 * `public/basis/` at setup time so Vite serves them from `/basis/` in both dev
 * and build. (three r185 can also resolve them itself, via
 * `new URL(…, import.meta.url)`, when `transcoderPath` is left empty — but
 * that route depends on the bundler's asset handling, so an explicit served
 * path is the version- and bundler-independent option. Keep `public/basis/`
 * in sync with the installed three if three is upgraded.) If the GPU exposes
 * no compressed-texture format at all (software
 * GL, e.g. headless Chromium's SwiftShader), the loader falls back to
 * transcoding to uncompressed RGBA32 — slower and fatter in VRAM, but it does
 * render, which is what makes headless screenshot verification possible.
 *
 * Refcounting exists because chunk eviction must not dispose a texture another
 * resident chunk is still using — today one atlas maps to exactly one chunk,
 * but that stops being true the moment atlases are shared or an evicted chunk
 * is re-requested while its dispose is still pending.
 */
export class AtlasCache {
  private readonly loader: AtlasTextureLoader;
  private readonly entries = new Map<string, { texture: THREE.Texture; refs: number }>();
  private readonly pending = new Map<string, PendingAtlas>();
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    transcoderPath = "/basis/",
    loader?: AtlasTextureLoader,
  ) {
    this.loader =
      loader ?? new KTX2Loader().setTranscoderPath(transcoderPath).detectSupport(renderer);
  }

  /** Loads (or re-uses) an atlas and takes a reference on it. */
  async acquire(url: string, signal?: AbortSignal): Promise<THREE.Texture> {
    if (this.disposed) throw new Error("AtlasCache is disposed");
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");

    const existing = this.entries.get(url);
    if (existing) {
      existing.refs += 1;
      return existing.texture;
    }

    let inFlight = this.pending.get(url);
    if (!inFlight) {
      const pending: PendingAtlas = {
        // Assigned immediately below; the placeholder keeps the record stable
        // for every waiter sharing this decode.
        promise: undefined as unknown as Promise<THREE.Texture>,
        waiters: 0,
      };
      pending.promise = this.loader.loadAsync(url).then((texture) => {
        if (this.disposed) {
          texture.dispose();
          throw new DOMException("aborted", "AbortError");
        }
        try {
          this.configure(texture);
        } catch (error) {
          texture.dispose();
          throw error;
        }
        this.entries.set(url, { texture, refs: 0 });
        return texture;
      });
      inFlight = pending;
      this.pending.set(url, inFlight);
    }

    inFlight.waiters += 1;
    try {
      const texture = await inFlight.promise;
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const entry = this.entries.get(url);
      if (!entry || entry.texture !== texture) {
        throw new Error(`AtlasCache lost decoded texture ${url}`);
      }
      entry.refs += 1;
      return texture;
    } finally {
      inFlight.waiters -= 1;
      if (inFlight.waiters === 0) {
        if (this.pending.get(url) === inFlight) this.pending.delete(url);
        // KTX2Loader itself cannot be aborted. If every consumer left while it
        // was transcoding, the final waiter owns cleanup of the now-unused
        // result so it cannot bypass ChunkStore's residency budget.
        const entry = this.entries.get(url);
        if (entry?.refs === 0) {
          entry.texture.dispose();
          this.entries.delete(url);
        }
      }
    }
  }

  /** Drops a reference; disposes the GPU texture when the last one goes. */
  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    if (entry.refs > 0) entry.refs -= 1;
    if (entry.refs === 0 && !this.pending.has(url)) {
      entry.texture.dispose();
      this.entries.delete(url);
    }
  }

  /** Approximate decoded byte size of a loaded atlas, for the VRAM budget. */
  byteSize(url: string, fallbackBytes: number): number {
    const entry = this.entries.get(url);
    const texture = entry?.texture as THREE.CompressedTexture | undefined;
    if (!texture?.mipmaps?.length) return fallbackBytes;
    let bytes = 0;
    for (const mip of texture.mipmaps) {
      const data = (mip as { data?: ArrayBufferView }).data;
      if (data) bytes += data.byteLength;
    }
    return bytes || fallbackBytes;
  }

  get residentCount(): number {
    return this.entries.size;
  }

  private configure(texture: THREE.Texture): void {
    // Thumbnails are albedo, so they must be decoded from sRGB.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    // Legacy packs contain a full mip chain, but atlases are deliberately
    // sampled at level 0: once a mip texel spans a tile boundary it can show a
    // neighbouring image. KTX2Loader transcodes every level it keeps, and
    // three uploads them even with LinearFilter, so discard the unused levels
    // before the first upload. New packs omit them at encode time too.
    if (texture.mipmaps.length > 1) texture.mipmaps.splice(1);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
    this.pending.clear();
    this.loader.dispose();
  }
}
