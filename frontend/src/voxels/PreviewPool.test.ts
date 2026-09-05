import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewPool, PREVIEW_EDGE, PREVIEW_SLOTS, type PreviewTarget } from "./PreviewPool.ts";
import { isSharpBandCell } from "../interaction/SharpBand.ts";

const pixels = () => new Uint8ClampedArray(PREVIEW_EDGE ** 2 * 4);
const target = (key: string): PreviewTarget => ({ key, matrix: new THREE.Matrix4(), opacity: 1,
  valid: () => true, resolve: async () => "unused" });
const camera = new THREE.PerspectiveCamera();
const pools: PreviewPool[] = [];
function pool(load = async (_t: PreviewTarget, _s: AbortSignal) => pixels()) {
  const p = new PreviewPool(new THREE.Scene(), { initTexture: vi.fn() } as unknown as THREE.WebGLRenderer, load);
  pools.push(p); return p;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { pools.splice(0).forEach(p => p.dispose()); vi.restoreAllMocks(); });

describe("bounded sharp preview pool", () => {
  it("renders only X-ray hover opaque with depth writes, sharing the sharp texture", async () => {
    const p=pool(), focused={...target("focus"),focused:true,opacity:.4}, other={...target("glass"),opacity:.4};
    p.update([focused,other],true,camera);await settle();p.update([focused,other],true,camera);
    expect(p.focusMesh.count).toBe(1);expect(p.mesh.count).toBe(1);
    expect(p.focusMesh.material.transparent).toBe(false);expect(p.focusMesh.material.depthWrite).toBe(true);
    expect(p.focusMesh.geometry.getAttribute("previewAlpha").getX(0)).toBe(1);
    expect(p.mesh.material.transparent).toBe(true);expect(p.mesh.material.depthWrite).toBe(false);
    expect(p.stats.cpuPixelBytes).toBe(8*1024**2);
    p.update([{...focused,focused:false},other],true,camera);
    expect(p.focusMesh.count).toBe(0);expect(p.mesh.count).toBe(2);
    p.update([focused,other],false,camera);
    expect(p.focusMesh.count).toBe(0);expect(p.mesh.count).toBe(2);
  });
  it("keeps mining fades in the depth-writing queue, before neighbouring cages", async () => {
    const p = pool(), a = target("a"), b = target("b");
    p.update([a,b],false,camera); await settle(); p.update([a,b],false,camera);
    const version = p.mesh.material.version;
    for (const opacity of [.9, .5, .1, 1]) {
      p.update([{...a,opacity},b],false,camera);
      expect(p.mesh.material.transparent).toBe(false);
      expect(p.mesh.material.depthWrite).toBe(true);
      expect(p.mesh.material.alphaToCoverage).toBe(true);
      expect(p.mesh.renderOrder).toBe(0);
      expect(p.mesh.material.version).toBe(version);
    }
    expect(p.texture.magFilter).toBe(THREE.LinearFilter);
    p.update([a,b],true,camera);
    expect(p.mesh.material.alphaToCoverage).toBe(false);
  });
  it("uses 128px / 128 layers and honors fetch, upload, and slot caps", async () => {
    const load = vi.fn(async () => pixels()), p = pool(load);
    const targets = Array.from({ length: 1000 }, (_,i) => target(String(i)));
    p.update(targets, false, camera);
    expect(load).toHaveBeenCalledTimes(4);
    expect(p.stats.pending).toBe(4);
    await settle(); p.update(targets, false, camera);
    expect(p.mesh.count).toBe(2);
    expect(p.texture.layerUpdates.size).toBe(2);
    expect(p.texture.image.width).toBe(128);
    expect(p.texture.image.depth).toBe(128);
    for (let i=0; i<70; i++) { await settle(); p.texture.clearLayerUpdates(); p.update(targets, false, camera); }
    expect(p.stats.slots).toBe(PREVIEW_SLOTS);
    expect(p.stats.visible).toBe(PREVIEW_SLOTS);
    expect(load).toHaveBeenCalledTimes(PREVIEW_SLOTS);
    expect(p.stats.cpuPixelBytes).toBe(8 * 1024 ** 2);
    expect(p.stats.gpuBytes).toBe(87380 * 128);
  });

  it("discards late canceled loads without showing an old row in a reused slot", async () => {
    const completions: (() => void)[] = [];
    const p = pool((_t, _s) => new Promise(resolve => completions.push(() => resolve(pixels()))));
    p.update([target("old")], false, camera);
    p.update([target("new")], false, camera);
    completions[0](); await settle(); p.update([target("new")], false, camera);
    expect(p.mesh.count).toBe(0);
    completions[1](); await settle(); p.update([target("new")], false, camera);
    expect([...p.visibleKeys]).toEqual(["new"]);
    p.update([], false, camera); expect(p.mesh.count).toBe(0);
    p.update([target("new")], false, camera); expect(p.mesh.count).toBe(1);
  });

  it("deduplicates, validates residency, and preserves transparent state", async () => {
    const p = pool(), a = target("a");
    p.update([a,a,{...target("evicted"),valid:()=>false}], false, camera);
    await settle(); p.update([{...a,opacity:.2}],true,camera);
    expect(p.mesh.count).toBe(1);
    expect(p.mesh.material.transparent).toBe(true);
    expect(p.mesh.material.depthWrite).toBe(false);
    expect(p.mesh.geometry.getAttribute("previewAlpha").getX(0)).toBeCloseTo(.2);
    p.update([{...a,valid:()=>false}],false,camera);
    expect(p.mesh.count).toBe(0);
    expect(p.mesh.material.depthWrite).toBe(true);
  });

  it("backs off missing thumbnails instead of retrying every frame", async () => {
    let now = 0; vi.spyOn(performance,"now").mockImplementation(()=>now);
    const load = vi.fn(async()=>{ throw new Error("404"); });
    const p = pool(load), targets = [target("missing")];
    p.update(targets,false,camera); await settle();
    for(let i=0;i<20;i++) p.update(targets,false,camera);
    expect(load).toHaveBeenCalledTimes(1);
    now=2001; p.update(targets,false,camera);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("selects exactly the unsuppressed one-voxel shell", () => {
    expect(isSharpBandCell(4,2,1)).toBe(false);
    expect(isSharpBandCell(4.01,2,1)).toBe(true);
    expect(isSharpBandCell(9,2,1)).toBe(true);
    expect(isSharpBandCell(9.01,2,1)).toBe(false);
  });
});
