import * as THREE from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

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
  private readonly loader: KTX2Loader;
  private readonly entries = new Map<string, { texture: THREE.Texture; refs: number }>();
  private readonly pending = new Map<string, Promise<THREE.Texture>>();

  constructor(renderer: THREE.WebGLRenderer, transcoderPath = "/basis/") {
    this.loader = new KTX2Loader().setTranscoderPath(transcoderPath).detectSupport(renderer);
  }

  /** Loads (or re-uses) an atlas and takes a reference on it. */
  async acquire(url: string, signal?: AbortSignal): Promise<THREE.Texture> {
    const existing = this.entries.get(url);
    if (existing) {
      existing.refs += 1;
      return existing.texture;
    }

    let inFlight = this.pending.get(url);
    if (!inFlight) {
      inFlight = this.loader.loadAsync(url).then((texture) => {
        this.configure(texture);
        this.pending.delete(url);
        this.entries.set(url, { texture, refs: 0 });
        return texture;
      });
      this.pending.set(url, inFlight);
      inFlight.catch(() => this.pending.delete(url));
    }

    const texture = await inFlight;
    if (signal?.aborted) {
      // The caller gave up while we were decoding. The texture stays cached
      // with refs === 0 so a later request is instant; `release` is what
      // eventually disposes it.
      throw new DOMException("aborted", "AbortError");
    }
    const entry = this.entries.get(url);
    if (entry) entry.refs += 1;
    return texture;
  }

  /** Drops a reference; disposes the GPU texture when the last one goes. */
  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
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
    // Deliberately NOT mipmapped for sampling, even though `basisu -mipmap`
    // put mip levels in the file: a 2048px atlas of 32px tiles only stays
    // tile-correct down to mip 5 — past that a texel spans several tiles and
    // neighbouring thumbnails bleed into each other. Trading distant-voxel
    // aliasing for never showing the wrong book cover is the right way round
    // here; a proper fix (clamped TEXTURE_MAX_LEVEL, or a texture array with
    // one layer per tile) is a later-phase optimization.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
    this.pending.clear();
    this.loader.dispose();
  }
}
