import * as THREE from "three";
import type { VisualTheme } from "./registry.ts";

/** Page-owned, shared by all chunk materials. Neither texture delays the map.
 * The late-load guard also covers page teardown during image decoding. */
export class ThemeTextures {
  readonly wood: THREE.Texture | null;
  readonly panorama: THREE.Texture | null;
  private disposed = false;

  constructor(theme: VisualTheme, sky = true, loader = new THREE.TextureLoader()) {
    const load = (url: string, repeat: boolean) => {
      const texture = loader.load(url, loaded => {
        if (this.disposed) loaded.dispose();
      }, undefined, () => console.warn(`Theme texture unavailable: ${url}`));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.name = url;
      return texture;
    };
    this.wood = theme.woodTexture ? load(theme.woodTexture, true) : null;
    this.panorama = sky && theme.panorama ? load(theme.panorama, false) : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wood?.dispose();
    this.panorama?.dispose();
  }
}
