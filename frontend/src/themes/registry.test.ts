import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { DATASETS } from "../datasets/registry.ts";
import { resolveTheme, THEMES } from "./registry.ts";
import { ThemeTextures } from "./ThemeTextures.ts";
import { createContainerMaterial } from "../voxels/VoxelContainers.ts";

describe("independent visual themes", () => {
  it("changes appearance without changing dataset identity or capability", () => {
    const bl = DATASETS["bl-160"], before = JSON.stringify(bl);
    expect(resolveTheme(bl.theme).id).toBe("library");
    expect(resolveTheme(bl.theme, "nebula").id).toBe("nebula");
    expect(resolveTheme(bl.theme, "toString").id).toBe("library");
    expect(resolveTheme(DATASETS["monet-sscd-512"].theme).id).toBe("nebula");
    expect(JSON.stringify(bl)).toBe(before);
  });

  it("shares one wood texture across chunk materials without changing the metal shader", () => {
    const wood = new THREE.Texture();
    const first = createContainerMaterial(wood), second = createContainerMaterial(wood);
    const metal = createContainerMaterial();
    expect(first.uniforms.uWood.value).toBe(wood);
    expect(second.uniforms.uWood.value).toBe(wood);
    expect(first.defines.LIBRARY_WOOD).toBe(1);
    expect(metal.defines.LIBRARY_WOOD).toBeUndefined();
    expect(first.customProgramCacheKey()).not.toBe(metal.customProgramCacheKey());
    const disposed = vi.fn(); wood.addEventListener("dispose", disposed);
    first.dispose(); second.dispose(); metal.dispose();
    expect(disposed).not.toHaveBeenCalled();
    wood.dispose();
  });

  it("does not request library assets for nebula or a disabled panorama", () => {
    const load = vi.fn((_url: string) => new THREE.Texture());
    const loader = { load } as unknown as THREE.TextureLoader;
    new ThemeTextures(THEMES.nebula, true, loader).dispose();
    expect(load).not.toHaveBeenCalled();
    new ThemeTextures(THEMES.library, false, loader).dispose();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBe(THEMES.library.woodTexture);
  });

  it("disposes page-owned textures and guards a late image load", () => {
    const callbacks: Array<(texture: THREE.Texture) => void> = [];
    const textures: THREE.Texture[] = [];
    const loader = { load: vi.fn((_url: string, ready: (texture: THREE.Texture) => void) => {
      const texture = new THREE.Texture(); textures.push(texture); callbacks.push(ready); return texture;
    }) } as unknown as THREE.TextureLoader;
    const resources = new ThemeTextures(THEMES.library, true, loader);
    const dispose = textures.map(texture => vi.spyOn(texture, "dispose"));
    resources.dispose(); resources.dispose();
    for (const fn of dispose) expect(fn).toHaveBeenCalledTimes(1);
    callbacks[0](textures[0]);
    expect(dispose[0]).toHaveBeenCalledTimes(2);
  });
});
